import { describe, it, expect } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import { join } from 'node:path';
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// Only the usage text: with no arguments tools/tablet.sh prints it and exits before it needs adb, a device or the lock.
const SCRIPT = join(import.meta.dirname, '..', 'tools', 'tablet.sh');

describe('tools/tablet.sh usage', () => {
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  it('prints the whole comment block and exits 2', () => {
    expect(r.status).toBe(2);
    expect(r.stdout).toContain('tools/tablet.sh devices');
    expect(r.stdout).toContain('never set it yourself');
    expect(r.stdout).not.toContain('set -euo pipefail');
  });
  it('warns that reconnect drops every adb reverse', () => {
    const line = r.stdout.split('\n').findIndex((l) => l.includes('tools/tablet.sh reconnect'));
    expect(line).toBeGreaterThan(-1);
    expect(r.stdout.split('\n').slice(line, line + 3).join(' ')).toMatch(/drops every adb reverse/);
  });
});

describe('tools/tablet.sh with no device (another adb server may own it)', () => {
  // A copy of the script in a temp dir, so the real tools/tablet.env is never sourced; a fake adb; the lock skipped.
  function setup(devicesOut: string) {
    const d = mkdtempSync(join(tmpdir(), 'cc-tabsh-'));
    copyFileSync(SCRIPT, join(d, 'tablet.sh'));
    const adb = join(d, 'fake-adb');
    writeFileSync(join(d, 'devices.out'), devicesOut);
    writeFileSync(adb, `#!/usr/bin/env bash\necho "$*" >> "${d}/calls"\nif [ "$1" = devices ]; then cat "${d}/devices.out"; exit 0; fi\nif grep -q "^TAB1\tdevice" "${d}/devices.out"; then echo ok; exit 0; fi\necho "adb: device 'TAB1' not found" >&2; exit 1\n`);
    chmodSync(adb, 0o755);
    const sh = (...args: string[]) => spawnSync('bash', [join(d, 'tablet.sh'), ...args], { encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ADB: adb, TABLET_SERIAL: 'TAB1', CLAYCLAUDE_TABLET_LOCK_HELD: '1' } });
    return { adb, sh, calls: () => readFileSync(join(d, 'calls'), 'utf8').trim().split('\n') };
  }

  it('a device command that fails because adb sees no device names the adb and hints at the other server', () => {
    const t = setup('List of devices attached\n\n');
    const r = t.sh('key', 'KEYCODE_WAKEUP');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(t.adb);
    expect(r.stderr).toMatch(/another adb server/i);
    expect(t.calls().some((c) => /kill[-]server|start-server/.test(c))).toBe(false);
  });

  it('`devices` with no device prints the hint too', () => {
    const t = setup('List of devices attached\n\n');
    const r = t.sh('devices');
    expect(r.stdout).toContain('List of devices attached');
    expect(r.stderr).toContain(t.adb);
    expect(r.stderr).toMatch(/another adb server/i);
  });

  it('no hint when the device is there', () => {
    const t = setup('List of devices attached\nTAB1\tdevice\n\n');
    const r = t.sh('key', 'KEYCODE_WAKEUP');
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(t.sh('devices').stderr).toBe('');
  });
});

describe('tools/tablet.sh navigate and reload (DevTools WebSocket on an existing tab)', () => {
  // A fake adb that records its calls, and a fake DevTools page socket on a free port standing in for the adb forward.
  async function setup(reply: (msg: { id: number; method: string; params?: Record<string, unknown> }) => unknown) {
    const d = mkdtempSync(join(tmpdir(), 'cc-tabnav-'));
    copyFileSync(SCRIPT, join(d, 'tablet.sh'));
    const adb = join(d, 'fake-adb');
    writeFileSync(adb, `#!/usr/bin/env bash\necho "$*" >> "${d}/calls"\nexit 0\n`);
    chmodSync(adb, 0o755);
    const seen: { path: string; msg: { id: number; method: string; params?: Record<string, unknown> } }[] = [];
    const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    wss.on('connection', (ws, req) => ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      seen.push({ path: req.url ?? '', msg });
      const out = reply(msg);
      if (out !== undefined) ws.send(JSON.stringify(out));
    }));
    await new Promise<void>((res) => wss.on('listening', () => res()));
    const port = (wss.address() as AddressInfo).port;
    const sh = (...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
      const p = spawn('bash', [join(d, 'tablet.sh'), ...args], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ADB: adb,
        TABLET_SERIAL: 'TAB1', CLAYCLAUDE_TABLET_LOCK_HELD: '1', TABLET_DEVTOOLS_PORT: String(port), TABLET_NODE: process.execPath,
        TABLET_DEVTOOLS_TIMEOUT: '2' } });
      let stdout = ''; let stderr = '';
      p.stdout.on('data', (b) => { stdout += b; });
      p.stderr.on('data', (b) => { stderr += b; });
      p.on('close', (status) => res({ status, stdout, stderr }));
    });
    const calls = () => readFileSync(join(d, 'calls'), 'utf8').trim().split('\n');
    return { sh, seen, calls, port, close: () => new Promise((res) => wss.close(res)) };
  }

  it('navigate sends Page.navigate with the URL to that tab, then removes the forward', async () => {
    const t = await setup((m) => ({ id: m.id, result: { frameId: 'F1' } }));
    try {
      const r = await t.sh('navigate', 'TABID42', 'http://localhost:8431/?a=1&b=2');
      expect(r.status).toBe(0);
      expect(t.seen).toHaveLength(1);
      expect(t.seen[0].path).toBe('/devtools/page/TABID42');
      expect(t.seen[0].msg.method).toBe('Page.navigate');
      expect(t.seen[0].msg.params).toEqual({ url: 'http://localhost:8431/?a=1&b=2' });
      expect(t.calls()).toEqual([`-s TAB1 forward tcp:${t.port} localabstract:chrome_devtools_remote`,
        `-s TAB1 forward --remove tcp:${t.port}`]);
    } finally { await t.close(); }
  });

  it('reload sends Page.reload to that tab', async () => {
    const t = await setup((m) => ({ id: m.id, result: {} }));
    try {
      const r = await t.sh('reload', 'TABID7');
      expect(r.status).toBe(0);
      expect(t.seen.map((s) => [s.path, s.msg.method])).toEqual([['/devtools/page/TABID7', 'Page.reload']]);
      expect(t.calls().at(-1)).toBe(`-s TAB1 forward --remove tcp:${t.port}`);
    } finally { await t.close(); }
  });

  it('a DevTools error (unknown tab, failed navigation) exits non-zero and says why', async () => {
    const t = await setup((m) => ({ id: m.id, result: { frameId: 'F1', errorText: 'net::ERR_CONNECTION_REFUSED' } }));
    try {
      const r = await t.sh('navigate', 'TABID42', 'http://localhost:8499/');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('net::ERR_CONNECTION_REFUSED');
    } finally { await t.close(); }
  });

  it('a stalled DevTools socket times out, exits non-zero and still removes the forward', async () => {
    const t = await setup(() => undefined);
    try {
      const r = await t.sh('reload', 'TABID7');
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/timed out/i);
      expect(t.calls().at(-1)).toBe(`-s TAB1 forward --remove tcp:${t.port}`);
    } finally { await t.close(); }
  });

  it('usage lists navigate and reload', () => {
    const u = spawnSync('bash', [SCRIPT], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }).stdout;
    expect(u).toContain('tools/tablet.sh navigate <id> <url>');
    expect(u).toContain('tools/tablet.sh reload <id>');
  });
});

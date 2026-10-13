import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import {
  adbCandidates, adbClashWarning, chooseAdb, configuredAdb, isWsl, nativeAdbListening, otherAdb, probeAdb, systemAdbCandidates, WSL_INTEROP,
} from '../src/adbpick.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cc-adbpick-'));
/** A fake adb: prints the given `devices` output, logs every argv to <dir>/calls. Never a real adb. */
function fakeAdb(dir: string, name: string, devicesOut: string): string {
  const p = join(dir, name);
  writeFileSync(`${p}.out`, devicesOut);
  writeFileSync(p, `#!/usr/bin/env bash\necho "$*" >> "${join(dir, 'calls')}"\nif [ "$1" = devices ]; then cat "${p}.out"; exit 0; fi\nexit 1\n`);
  chmodSync(p, 0o755);
  return p;
}
const run = (bin: string, argv: string[]) => new Promise<string>((res, rej) => execFile(bin, argv, { timeout: 5000 }, (e, out) => (e ? rej(e) : res(out))));
const DEV = 'List of devices attached\nTAB1\tdevice\n\n';
/** A throwaway listener on a free loopback port: something answers there that is not a Linux adb server. Never the real 5037. */
async function listener(): Promise<{ port: number; server: Server }> {
  const server = createServer((c) => c.destroy());
  await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
  return { port: (server.address() as { port: number }).port, server };
}
const TCP_HEAD = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
/** A fake /proc/net/tcp: one loopback socket on <port>, listening (0A) or only connected (01). Never the real table. */
const procTcp = (port: number, listening: boolean) =>
  `${TCP_HEAD}   0: 0100007F:${port.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${listening ? '0A' : '01'} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n`;
/** A test port, never the real 5037. */
const PORT = 45037;
const callsIn = (d: string) => (existsSync(join(d, 'calls')) ? readFileSync(join(d, 'calls'), 'utf8').trim().split('\n') : []);
const NONE = 'List of devices attached\n\n';

describe('WSL detection', () => {
  it('uses the WSLInterop entry or WSL_DISTRO_NAME', () => {
    expect(isWsl({}, (p) => p === WSL_INTEROP)).toBe(true);
    expect(isWsl({ WSL_DISTRO_NAME: 'Ubuntu' }, () => false)).toBe(true);
    expect(isWsl({}, () => false)).toBe(false);
  });
});

describe('adb candidates', () => {
  function layout() {
    const root = tmp();
    const bin = join(root, 'bin'); mkdirSync(bin);
    const users = join(root, 'Users');
    const sdk = join(users, 'jo', 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools'); mkdirSync(sdk, { recursive: true });
    mkdirSync(join(users, 'Public'));
    const native = fakeAdb(bin, 'adb', NONE);
    const winexe = fakeAdb(sdk, 'adb.exe', DEV);
    const deps = { exists: existsSync, listDir: (p: string) => readdirSync(p), usersRoot: users };
    return { bin, users, native, winexe, deps };
  }
  it('finds adb on PATH, and under WSL the Windows SDK adb.exe of every user', () => {
    const l = layout();
    expect(adbCandidates({ wsl: false, pathVar: `/nonexistent:${l.bin}`, ...l.deps })).toEqual([l.native]);
    expect(adbCandidates({ wsl: true, pathVar: l.bin, ...l.deps })).toEqual([l.native, l.winexe]);
  });
  it('also takes adb.exe on PATH under WSL, without duplicates, and survives a missing Users folder', () => {
    const l = layout();
    const exeDir = join(l.bin, '..', 'winbin'); mkdirSync(exeDir);
    const onPath = fakeAdb(exeDir, 'adb.exe', DEV);
    expect(adbCandidates({ wsl: true, pathVar: `${l.bin}:${exeDir}:${exeDir}`, ...l.deps })).toEqual([l.native, l.winexe, onPath]);
    expect(adbCandidates({ wsl: true, pathVar: l.bin, exists: existsSync, listDir: () => { throw new Error('ENOENT'); }, usersRoot: '/nope' })).toEqual([l.native]);
  });
});

describe('CLAYCLAUDE_ADB_CANDIDATES', () => {
  it('replaces the search (tests set it empty, so no test finds a real adb)', () => {
    expect(systemAdbCandidates(true, { CLAYCLAUDE_ADB_CANDIDATES: '', PATH: '/usr/bin' })).toEqual([]);
    expect(systemAdbCandidates(true, { CLAYCLAUDE_ADB_CANDIDATES: '/a/adb:/b/adb.exe' })).toEqual(['/a/adb', '/b/adb.exe']);
    expect(process.env.CLAYCLAUDE_ADB_CANDIDATES).toBe('');
  });
});

describe('probing and choosing', () => {
  it('runs only `devices` with each candidate and reads the authorised serials', async () => {
    const d = tmp();
    const a = fakeAdb(d, 'adb', NONE), b = fakeAdb(d, 'adb.exe', 'List of devices attached\r\nTAB1\tdevice\r\nTAB2\tunauthorized\r\n');
    expect(await probeAdb(a, run)).toEqual({ path: a, serials: [] });
    expect(await probeAdb(b, run)).toEqual({ path: b, serials: ['TAB1'] });
    expect((await probeAdb(join(d, 'missing'), run)).error).toBeTruthy();
    expect(readFileSync(join(d, 'calls'), 'utf8').trim().split('\n')).toEqual(['devices', 'devices']);
  });
  it('under WSL, never runs a native adb whose server is not in the Linux socket table: `devices` would start one', async () => {
    const d = tmp();
    const native = fakeAdb(d, 'adb', DEV);
    expect(await probeAdb(native, run, { wsl: true, adbPort: PORT, procNetTcp: () => procTcp(PORT, false) })).toEqual({ path: native, serials: [], notRunning: true });
    expect(callsIn(d)).toEqual([]);
  });
  it('under WSL, never runs a native adb when the port answers but no Linux socket listens (mirrored networking: the Windows adb.exe server)', async () => {
    const d = tmp();
    const native = fakeAdb(d, 'adb', DEV);
    const { port, server } = await listener();
    try {
      expect(await probeAdb(native, run, { wsl: true, adbPort: port, procNetTcp: () => procTcp(port, false) })).toEqual({ path: native, serials: [], notRunning: true });
      expect(callsIn(d)).toEqual([]);
    } finally { server.close(); }
  });
  it('under WSL, probes a native adb whose server is listening in /proc/net/tcp (on the injected port)', async () => {
    const d = tmp();
    const native = fakeAdb(d, 'adb', DEV);
    expect(await probeAdb(native, run, { wsl: true, adbPort: PORT, procNetTcp: () => procTcp(PORT, true) })).toEqual({ path: native, serials: ['TAB1'] });
    expect(callsIn(d)).toEqual(['devices']);
    // a listener on another port is not this server
    const d2 = tmp();
    const native2 = fakeAdb(d2, 'adb', DEV);
    expect(await probeAdb(native2, run, { wsl: true, adbPort: PORT, procNetTcp: () => procTcp(PORT + 1, true) })).toEqual({ path: native2, serials: [], notRunning: true });
    expect(callsIn(d2)).toEqual([]);
  });
  it('under WSL, a Windows adb.exe is probed whether or not a Linux server listens (it talks to the Windows server)', async () => {
    const d = tmp();
    const exe = fakeAdb(d, 'adb.exe', DEV);
    expect(await probeAdb(exe, run, { wsl: true, adbPort: PORT, procNetTcp: () => procTcp(PORT, false) })).toEqual({ path: exe, serials: ['TAB1'] });
    expect(callsIn(d)).toEqual(['devices']);
  });
  it('chooses the one that sees a device', () => {
    expect(chooseAdb([{ path: '/usr/bin/adb', serials: [] }, { path: '/mnt/c/x/adb.exe', serials: ['T'] }], { preferWindows: true })).toBe('/mnt/c/x/adb.exe');
    expect(chooseAdb([{ path: '/usr/bin/adb', serials: ['T'] }, { path: '/mnt/c/x/adb.exe', serials: [] }], { preferWindows: true })).toBe('/usr/bin/adb');
  });
  it('when two see it, prefers the configured one, else the Windows one under WSL', () => {
    const both = [{ path: '/usr/bin/adb', serials: ['T'] }, { path: '/mnt/c/x/adb.exe', serials: ['T'] }];
    expect(chooseAdb(both, { configured: '/usr/bin/adb', preferWindows: true })).toBe('/usr/bin/adb');
    expect(chooseAdb(both, { configured: 'adb', preferWindows: true })).toBe('/usr/bin/adb');
    expect(chooseAdb(both, { preferWindows: true })).toBe('/mnt/c/x/adb.exe');
    expect(chooseAdb(both, { configured: '/elsewhere/adb2', preferWindows: false })).toBe('/usr/bin/adb');
  });
  it('chooses nothing when none sees a device', () => {
    expect(chooseAdb([{ path: '/usr/bin/adb', serials: [] }, { path: '/x/adb.exe', serials: [], error: 'ENOENT' }], { preferWindows: true })).toBeUndefined();
  });
  it('reads tablet.adb from an existing config, if any', () => {
    expect(configuredAdb('tablet:\n  adb: /mnt/c/x/adb.exe\n')).toBe('/mnt/c/x/adb.exe');
    expect(configuredAdb('port: 7420\n')).toBeUndefined();
    expect(configuredAdb(null)).toBeUndefined();
    expect(configuredAdb(': : not yaml [')).toBeUndefined();
  });
});

describe('the daemon\'s view of the other adb', () => {
  it('names the other kind of adb as the other candidate', () => {
    const c = ['/usr/bin/adb', '/mnt/c/U/jo/Sdk/adb.exe'];
    expect(otherAdb('/mnt/c/U/jo/Sdk/adb.exe', c)).toBe('/usr/bin/adb');
    expect(otherAdb('/usr/bin/adb', c)).toBe('/mnt/c/U/jo/Sdk/adb.exe');
    expect(otherAdb('adb', c)).toBe('/mnt/c/U/jo/Sdk/adb.exe');
    expect(otherAdb('/usr/bin/adb', ['/usr/bin/adb'])).toBeUndefined();
  });
  it('sees a native adb server listening on 5037 in /proc/net/tcp', () => {
    const head = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n';
    expect(nativeAdbListening(head + '   0: 0100007F:13AD 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n')).toBe(true);
    expect(nativeAdbListening(head + '   0: 0100007F:13AD 0100007F:9C40 01 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n')).toBe(false);
    expect(nativeAdbListening(head + '   0: 0100007F:1CFC 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n')).toBe(false);
    expect(nativeAdbListening(procTcp(PORT, true), PORT)).toBe(true);
    expect(nativeAdbListening(procTcp(PORT, true))).toBe(false);
    expect(nativeAdbListening('  sl ...\n   0: 00000000000000000000000000000000:13AD 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000 0 1\n')).toBe(true);
  });
  it('warns under WSL when the other kind of adb server is running, and never otherwise', () => {
    expect(adbClashWarning({ wsl: true, configured: '/mnt/c/x/adb.exe', nativeListening: true, windowsRunning: true })).toMatch(/Linux adb server.*5037.*adb\.exe/s);
    expect(adbClashWarning({ wsl: true, configured: '/usr/bin/adb', nativeListening: true, windowsRunning: true })).toMatch(/Windows adb server/);
    expect(adbClashWarning({ wsl: true, configured: '/mnt/c/x/adb.exe', nativeListening: false, windowsRunning: true })).toBeUndefined();
    expect(adbClashWarning({ wsl: true, configured: 'adb', nativeListening: true, windowsRunning: false })).toBeUndefined();
    expect(adbClashWarning({ wsl: false, configured: 'adb', nativeListening: true, windowsRunning: true })).toBeUndefined();
  });
});

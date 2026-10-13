import { describe, it, expect } from 'vitest';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = (...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
  execFile(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), ...args], { cwd: root, timeout: 15_000 },
    (e, out, err) => resolve({ code: e ? ((e as any).code ?? null) : 0, out, err }));
});
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-cli-'));
const validConfig = (port: number, dir: string) => `port: ${port}
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ${dir}, usage: {provider: none}}]
tablet: {adb: ${join(dir, 'no-adb')}}
`;
/** A stack trace has "    at fn (file:line:col)" lines. */
const noStack = (s: string) => expect(s).not.toMatch(/^\s+at .+:\d+:\d+\)?$/m);

describe('cli', () => {
  it('reports a missing config file plainly, without a stack trace', async () => {
    const path = join(tmp(), 'nope.yaml');
    const r = await cli('serve', '--config', path);
    expect(r.code).toBe(1);
    expect(r.err).toContain(path);
    noStack(r.err);
  }, 20_000);

  it('reports invalid YAML and schema errors plainly', async () => {
    const d = tmp();
    writeFileSync(join(d, 'bad.yaml'), 'hosts: [\n');
    const yaml = await cli('serve', '--config', join(d, 'bad.yaml'));
    expect(yaml.code).toBe(1);
    noStack(yaml.err);
    writeFileSync(join(d, 'schema.yaml'), 'hosts: [{id: local}]\n');
    const schema = await cli('serve', '--config', join(d, 'schema.yaml'));
    expect(schema.code).toBe(1);
    expect(schema.err).toContain('accounts');
    noStack(schema.err);
  }, 20_000);

  it('refuses --config with no value instead of silently using the default', async () => {
    const r = await cli('serve', '--config');
    expect(r.code).toBe(1);
    expect(r.err).toContain('--config');
    noStack(r.err);
  }, 20_000);

  it('says the port is in use, without a stack trace', async () => {
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as any).port as number;
    try {
      const d = tmp();
      writeFileSync(join(d, 'c.yaml'), validConfig(port, d));
      const r = await cli('serve', '--config', join(d, 'c.yaml'));
      expect(r.code).toBe(1);
      expect(r.err).toContain(`port ${port} is already in use`);
      noStack(r.err);
    } finally { await new Promise((r) => blocker.close(r)); }
  }, 20_000);

  it('serves, then exits 0 promptly on SIGTERM', async () => {
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, '127.0.0.1', r));
    const port = (probe.address() as any).port as number;
    await new Promise((r) => probe.close(r));
    const d = tmp();
    writeFileSync(join(d, 'c.yaml'), validConfig(port, d));
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'serve', '--config', join(d, 'c.yaml')], { cwd: root });
    let out = '';
    child.stderr.on('data', (b) => { out += b; });
    await new Promise<void>((resolve, reject) => {
      child.stdout.on('data', (b) => { out += b; if (out.includes('clayclaude on')) resolve(); });
      child.on('exit', () => reject(new Error('exited early: ' + out)));
    });
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    // Plan 2: the PC baker's routes are mounted (pc is true or false depending on this machine; either is an answer)
    expect(typeof (await (await fetch(`http://127.0.0.1:${port}/clay/status`)).json()).pc).toBe('boolean');
    // This checkout has no web/dist build: say so instead of answering 404 to the board in silence.
    expect(existsSync(join(root, 'web/dist/index.html')) || out.includes('npm run build')).toBe(true);
    const t = Date.now();
    child.kill('SIGTERM');
    const code = await new Promise((r) => child.on('exit', (c) => r(c)));
    expect(code).toBe(0);
    expect(Date.now() - t).toBeLessThan(3000);
  }, 20_000);
  it('demo: a bad option or a port in use is one plain line and exit 1, not a stack trace', async () => {
    const bad = await cli('demo', '--prot', '7453');
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('clayclaude: unknown option "--prot"');
    noStack(bad.err);
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as any).port as number;
    try {
      const r = await cli('demo', '--port', String(port));
      expect(r.code).toBe(1);
      expect(r.err).toContain(`port ${port} is already in use`);
      noStack(r.err);
    } finally { await new Promise((r) => blocker.close(r)); }
  }, 20_000);

  it('setup: an unknown option is refused before any question', async () => {
    const r = await cli('setup', '--bogus');
    expect(r.code).toBe(1);
    expect(r.err).toContain('clayclaude: unknown option "--bogus"');
    expect(r.out).not.toContain('Which ssh hosts');
    noStack(r.err);
  }, 20_000);
});

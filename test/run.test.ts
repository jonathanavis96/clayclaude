import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { runProbe, probeCommand, ProbeError } from '../src/probe/run.js';
import { fakeSshDir } from './helpers/probe.js';

describe('runProbe', () => {
  it('runs the probe locally', async () => {
    const r: any = await runProbe({ id: 'local', tmuxSession: 'x', repoRoots: [] }, { mode: 'snapshot', dirs: ['/nonexistent'] });
    expect(r.ok).toBe(true);
    expect(r.dirs[0].registries).toEqual([]);
  });
  it('builds an ssh command with multiplexing and the request on stdin', () => {
    const c = probeCommand({ id: 'b', ssh: 'box', tmuxSession: 'x', repoRoots: [] }, { mode: 'snapshot', dirs: ["~/it's"] });
    expect(c.cmd).toBe('ssh');
    expect(c.args).toContain('ControlMaster=auto');
    expect(c.args).toContain('ControlPath=~/.ssh/clayclaude-z-%C'); // fixed-length hash: long host names cannot overflow the socket path
    expect(c.args).toContain('Compression=yes'); // a poll moves ~200 KB of JSON and Python: 4x faster on a slow link
    expect(c.args.slice(-4, -2)).toEqual(['box', 'python3']);
    expect(c.args.at(-2)).toBe('-I'); // isolated: no cwd ($HOME) on sys.path, no PYTHON* env
    expect(c.args.at(-1)).toBe('-'); // script and request on stdin: nothing for the remote shell to quote, no argv size cap
    expect(c.stdin.split('\n')[0]).toBe(`import sys; sys.argv[1:] = [${JSON.stringify(JSON.stringify({ mode: 'snapshot', dirs: ["~/it's"] }))}]`);
  });
  it('throws ProbeError(spawn|exit) for an unreachable ssh host', async () => {
    await expect(runProbe({ id: 'b', ssh: 'no-such-host.invalid', tmuxSession: 'x', repoRoots: [] }, { mode: 'snapshot', dirs: [] }, { timeoutMs: 8000 }))
      .rejects.toBeInstanceOf(ProbeError);
  });
});

describe('runProbe over ssh (fake ssh on PATH)', () => {
  const host = { id: 'fake', ssh: 'box', tmuxSession: 'x', repoRoots: [] };
  const saved = { ...process.env };
  let fake: string;
  beforeEach(() => { fake = fakeSshDir(); process.env.PATH = `${fake}:${saved.PATH}`; });
  afterEach(() => { process.env = { ...saved }; });

  it('runs the probe with the script on stdin', async () => {
    const r: any = await runProbe(host, { mode: 'snapshot', dirs: ['/nonexistent'] });
    expect(r.dirs[0]).toEqual({ configDir: '/nonexistent', registries: [], events: [] });
  });

  it('ignores text a remote shell startup file prints on stdout', async () => {
    process.env.FAKE_SSH_STDOUT = 'Welcome to box! {not json';
    const r: any = await runProbe(host, { mode: 'snapshot', dirs: ['/nonexistent'] });
    expect(r.ok).toBe(true);
    // Even text with no trailing newline (printf in a .bashrc) cannot glue itself onto the probe's line.
    process.env.FAKE_SSH_STDOUT = '';
    process.env.FAKE_SSH_CWD = mkdtempSync(join(tmpdir(), 'cc-home-'));
    const realPy = execFileSync('which', ['python3'], { encoding: 'utf8', env: saved }).trim();
    writeFileSync(join(fake, 'python3'), `#!/bin/sh\nprintf "motd"\nexec ${realPy} "$@"\n`, { mode: 0o755 });
    process.env.PATH = `${fake}:${saved.PATH}`;
    const r2: any = await runProbe(host, { mode: 'snapshot', dirs: ['/nonexistent'] });
    expect(r2.ok).toBe(true);
  });

  it('is not hijacked by a json.py in the remote working directory', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
    writeFileSync(join(home, 'json.py'), 'raise SystemExit("shadowed stdlib json")\n');
    process.env.FAKE_SSH_CWD = home;
    const r: any = await runProbe(host, { mode: 'snapshot', dirs: ['/nonexistent'] });
    expect(r.ok).toBe(true);
  });

  it('never asks for a remote tty and gives up on a dead multiplexed connection', () => {
    const { args } = probeCommand(host, { mode: 'snapshot', dirs: [] });
    expect(args).toContain('-T'); // RequestTTY force/yes in ~/.ssh/config would otherwise feed the script to an interactive REPL
    expect(args.join(' ')).toMatch(/ServerAliveInterval=\d+/);
    expect(args.slice(-5, -2)).toEqual(['--', 'box', 'python3']); // a host alias can never be read as an ssh option
  });

  it('settles once ssh exits even if a backgrounded control master still holds stderr', async () => {
    process.env.FAKE_SSH_HOLD_STDERR = '6';
    const t = Date.now();
    const r: any = await runProbe(host, { mode: 'snapshot', dirs: ['/nonexistent'] }, { timeoutMs: 4000 });
    expect(r.ok).toBe(true);
    expect(Date.now() - t).toBeLessThan(3000);
  });

  it('reports the last stderr line (the actual error) on a failed run', async () => {
    const e = await runProbe(host, { mode: 'nope' }).catch((x) => x);
    expect(e).toBeInstanceOf(ProbeError);
    expect(e.kind).toBe('exit');
    expect(e.message).toContain("unknown mode 'nope'");
    const bad = mkdtempSync(join(tmpdir(), 'cc-py-'));
    writeFileSync(join(bad, 'py'), '#!/bin/sh\necho "Traceback (most recent call last):" >&2\necho "ValueError: boom" >&2\nexit 1\n', { mode: 0o755 });
    const e2 = await runProbe({ id: 'local', tmuxSession: 'x', repoRoots: [] }, { mode: 'snapshot', dirs: [] }, { pythonBin: join(bad, 'py') }).catch((x) => x);
    expect(e2.message).toContain('ValueError: boom');
  });

  it('logs the argv the fake saw (sanity)', async () => {
    await runProbe(host, { mode: 'snapshot', dirs: [] });
    expect(readFileSync(join(fake, 'argv.log'), 'utf8')).toContain('box python3 -I -');
  });
});

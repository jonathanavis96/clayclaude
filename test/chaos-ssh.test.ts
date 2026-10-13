/**
 * Hostile and broken ssh hosts: a fake `ssh` whose body is given per test, so each one can hang, flood,
 * die or lie. Every test checks the daemon side stays up, settles in time and leaves no process behind.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbe, ProbeError } from '../src/probe/run.js';
import { makeExec } from '../src/actions/exec.js';
import { killChildren } from '../src/children.js';

const host = { id: 'box', ssh: 'box', tmuxSession: 'x', repoRoots: [] };

/** A fake ssh: drops options and the host alias, then runs `body` with the remote command in "$@". */
function fakeSsh(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-chaos-ssh-'));
  writeFileSync(join(dir, 'ssh'), `#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in -o) shift 2 ;; --) shift; break ;; -*) shift ;; *) break ;; esac; done
shift
${body}
`, { mode: 0o755 });
  return join(dir, 'ssh');
}

const savedPath = process.env.PATH;
afterEach(() => { process.env.PATH = savedPath; });
const onPath = (bin: string) => { process.env.PATH = `${join(bin, '..')}:${savedPath}`; };

describe('runProbe against a hostile host', () => {
  it('gives up on endless output instead of exhausting memory', async () => {
    onPath(fakeSsh('exec yes "$(printf "A%.0s" $(seq 1 200))"'));
    const e = await runProbe(host, { mode: 'snapshot', dirs: [] }, { timeoutMs: 10_000 }).catch((x) => x);
    expect(e).toBeInstanceOf(ProbeError);
    expect(e.message).toMatch(/too large/);
  });
});

describe('exec against a hostile host', () => {
  it('settles when ssh exits even if a backgrounded control master still holds stderr', async () => {
    // Older OpenSSH leaves the ControlPersist master holding stderr; waiting for 'close' waited out the timeout
    // and reported a command that succeeded as timed out (124).
    const ssh = fakeSsh('( exec sleep 6 </dev/null >/dev/null ) &\neval "$*"');
    const t = Date.now();
    const r = await makeExec({ sshBin: ssh })(host, ['echo', 'hi'], { timeoutMs: 4000 });
    expect(r).toEqual({ code: 0, stdout: 'hi\n', stderr: '' });
    expect(Date.now() - t).toBeLessThan(2000);
  });
  it('keeps a multi-byte character that arrives split across two reads', async () => {
    // A pane full of box drawing (3 bytes each) arrives in ssh channel packets; a split must not turn into U+FFFD,
    // or two captures of the same prompt hash differently and the answer is refused as "prompt changed".
    const ssh = fakeSsh(`printf '\\342\\224'; sleep 0.2; printf '\\202 ok\\n'`);
    const r = await makeExec({ sshBin: ssh })(host, ['true']);
    expect(r.stdout).toBe('\u2502 ok\n');
  });
});

/** True while a process with this pid exists (a zombie counts as gone). */
function alive(pid: number): boolean {
  try { return !/^\S+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
}
const pidOf = (dir: string) => Number(readFileSync(join(dir, 'pid'), 'utf8'));
const waitFor = async (f: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); return f(); };

describe('daemon shutdown', () => {
  it('kills ssh children still waiting on a hung host, so none outlive the daemon', async () => {
    const ssh = fakeSsh('echo $$ > "$(dirname "$0")/pid"; exec sleep 300');
    const dir = join(ssh, '..');
    onPath(ssh);
    const probe = runProbe(host, { mode: 'snapshot', dirs: [] }, { timeoutMs: 60_000 }).catch((e) => e);
    expect(await waitFor(() => existsSync(join(dir, 'pid')))).toBe(true);
    const p1 = pidOf(dir);
    const ex = makeExec({ sshBin: ssh })(host, ['true'], { timeoutMs: 60_000 });
    expect(await waitFor(() => pidOf(dir) !== p1)).toBe(true);
    const p2 = pidOf(dir);
    killChildren();
    expect(await probe).toBeInstanceOf(ProbeError);
    expect((await ex).code).not.toBe(0);
    expect(await waitFor(() => !alive(p1) && !alive(p2))).toBe(true);
  });
});

describe('an ssh wrapper script that does not exec', () => {
  // `ssh` on PATH is sometimes a wrapper (ssh.exe from WSL, a 1Password or teleport shim). Killing only the wrapper
  // left the real client, hung on the dead host, running for ever.
  const wrapper = () => fakeSsh('sleep 300 & echo $! > "$(dirname "$0")/pid"; wait');
  it('runProbe kills the whole process group at the timeout', async () => {
    const ssh = wrapper();
    onPath(ssh);
    const e = await runProbe(host, { mode: 'snapshot', dirs: [] }, { timeoutMs: 500 }).catch((x) => x);
    expect(e.kind).toBe('timeout');
    expect(await waitFor(() => !alive(pidOf(join(ssh, '..'))))).toBe(true);
  });
  it('exec kills the whole process group at the timeout', async () => {
    const ssh = wrapper();
    const r = await makeExec({ sshBin: ssh })(host, ['true'], { timeoutMs: 500 });
    expect(r.code).toBe(124);
    expect(await waitFor(() => !alive(pidOf(join(ssh, '..'))))).toBe(true);
  });
  it('shutdown kills the whole process group', async () => {
    const ssh = wrapper();
    const dir = join(ssh, '..');
    const ex = makeExec({ sshBin: ssh })(host, ['true'], { timeoutMs: 60_000 });
    expect(await waitFor(() => existsSync(join(dir, 'pid')))).toBe(true);
    killChildren();
    await ex;
    expect(await waitFor(() => !alive(pidOf(dir)))).toBe(true);
  });
});

describe('an ssh client killed by a signal (OOM killer, kill -9)', () => {
  it('runProbe names the signal instead of "exit null"', async () => {
    onPath(fakeSsh('kill -9 $$'));
    const e = await runProbe(host, { mode: 'snapshot', dirs: [] }).catch((x) => x);
    expect(e.kind).toBe('exit');
    expect(e.message).toBe('box: killed by SIGKILL');
  });
  it('exec reports 128 + the signal number, as a shell would', async () => {
    const r = await makeExec({ sshBin: fakeSsh('kill -9 $$') })(host, ['true']);
    expect(r.code).toBe(137);
  });
});

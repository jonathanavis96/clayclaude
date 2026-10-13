import { describe, it, expect } from 'vitest';
import { SSH_OPTS, execCommand, makeExec } from '../src/actions/exec.js';
import { probeCommand } from '../src/probe/run.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

const local = { id: 'local', tmuxSession: 's', repoRoots: [], claudeBin: 'claude' };
const remote = { ...local, id: 'box', ssh: 'box' };

describe('exec', () => {
  it('builds a direct command locally and one quoted string over ssh', () => {
    expect(execCommand(local, ['tmux', 'send-keys', '-t', '%1'])).toEqual({ cmd: 'tmux', args: ['send-keys', '-t', '%1'] });
    const r = execCommand(remote, ['printf', '%s', "it's"]);
    expect(r.cmd).toBe('ssh');
    expect(r.args.slice(-2)).toEqual(['box', `'printf' '%s' 'it'\\''s'`]);
    expect(r.args).toContain('ControlMaster=auto');
    // One source of truth with the probe: same options, so both share one connection.
    expect(probeCommand(remote, {}).args.join(' ')).toContain(SSH_OPTS.join(' '));
  });
  // Like the probe: -T, so a `RequestTTY force` in ~/.ssh/config cannot put a pty in the way (a pty echoes stdin,
  // turns \n into \r\n and never delivers EOF, so remote writes such as the hook installer's `cat > file` hang), and
  // `--` before the alias.
  it('runs remote commands without a tty, with the alias after --', () => {
    const { args } = execCommand(remote, ['true']);
    expect(args[0]).toBe('-T');
    expect(args.slice(-3)).toEqual(['--', 'box', `'true'`]);
  });
  it('runs locally and returns code, stdout and stderr', async () => {
    const ex = makeExec();
    expect(await ex(local, ['sh', '-c', 'echo out; echo err >&2; exit 3'])).toEqual({ code: 3, stdout: 'out\n', stderr: 'err\n' });
  });
  it('passes stdin, and reports a missing binary as code 127', async () => {
    const ex = makeExec();
    expect((await ex(local, ['cat'], { input: 'hello' })).stdout).toBe('hello');
    expect((await ex(local, ['no-such-binary-xyz'])).code).toBe(127);
  });
  it('kills a hung command at the timeout', async () => {
    const r = await makeExec()(local, ['sleep', '5'], { timeoutMs: 200 });
    expect(r.code).toBe(124);
  });
  it('delivers hostile arguments intact through a remote shell', async () => {
    const f = makeFakeSsh();
    const ex = makeExec({ sshBin: f.bin });
    const nasty = ["a b", "it's", '$(id)', 'x; echo pwned', '`id`', '-n', 'a\nb'];
    const r = await ex(remote, ['printf', '[%s]', ...nasty]);
    expect(r.stdout).toBe(nasty.map((s) => `[${s}]`).join(''));
  });
});

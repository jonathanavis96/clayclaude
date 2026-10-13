import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec } from '../src/actions/exec.js';
import { CapsCache, RepoLister, launch, launchArgv, launchOptions, parseClaudeHelp, validateOptions } from '../src/actions/launch.js';
import { ModelCache } from '../src/actions/models.js';
import { TEST_PREFIX, killOwn, testSessionName } from './helpers/tmux.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

/** A fish binary for the login-shell tests: CLAYCLAUDE_TEST_FISH, or fish on PATH. */
const FISH = process.env.CLAYCLAUDE_TEST_FISH
  || (() => { try { return execFileSync('sh', ['-c', 'command -v fish'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();

const HELP = `Usage: claude [options] [command] [prompt]
Options:
  --effort <level>                      Effort level for the current session
                                        (low, medium, high, xhigh, max)
  --model <model>                       Model for the current session.
  -n, --name <name>                     Set a display name for this session
  --permission-mode <mode>              Permission mode to use for the session
                                        (choices: "acceptEdits", "auto",
                                        "bypassPermissions", "manual",
                                        "dontAsk", "plan")
  --remote-control [name]               Start an interactive session with Remote
                                        Control enabled (optionally named)
`;

describe('parseClaudeHelp', () => {
  it('reads efforts, remote control, model and name', () => {
    expect(parseClaudeHelp(HELP, '2.1.296')).toEqual({ version: '2.1.296', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], remoteControl: true, model: true, name: true,
      permissionModes: ['acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan'] });
  });
  it('reports an older CLI as lacking the options', () => {
    expect(parseClaudeHelp('Usage: claude\n  --model <m>  x\n')).toMatchObject({ efforts: [], remoteControl: false, model: true, name: false, permissionModes: [] });
  });
});

// tmux here is the private test server (Task 0); sessions are still named and killed only through the helpers.
const sessions: string[] = [];
afterEach(() => { sessions.splice(0).forEach(killOwn); });

function setup(over = '') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-launch-'));
  const repo = join(dir, 'my repo');
  mkdirSync(repo);
  const stub = join(dir, 'claude-stub');
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${dir}/args"\nprintf '%s' "\${CLAUDE_CONFIG_DIR-<unset>}" > "${dir}/cfgdir"\npwd > "${dir}/cwd"\nsleep 20\n`);
  chmodSync(stub, 0o755);
  const tmux = testSessionName('launch-');
  sessions.push(tmux);
  const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: ${tmux}, claudeBin: ${stub}, repoRoots: [${dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ${dir}/cfg}]
${over}`);
  const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP, version: '9' } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
  const exec = makeExec();
  const deps = { cfg, exec, caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) };
  return { dir, repo, tmux, deps };
}
// The shell's `>` creates the file before pwd writes to it, so wait for the whole line, not just the file.
const written = (p: string) => existsSync(p) && readFileSync(p, 'utf8').endsWith('\n');
const waitFor = async (p: string) => { for (let i = 0; i < 50 && !written(p); i++) await new Promise((r) => setTimeout(r, 100)); return written(p); };

describe('launch', () => {
  it('creates a tmux session, then a second window, running the stub with the right flags and config dir', async () => {
    const { dir, repo, tmux, deps } = setup();
    const r = await launch(deps, { account: 'me', repo, options: { model: 'opus', effort: 'high', remoteControl: true } });
    expect(r).toMatchObject({ ok: true });
    expect((r as any).target).toMatch(new RegExp(`^${tmux}:@\\d+\\.%\\d+$`));
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['--model', 'opus', '--effort', 'high', '--remote-control', '-n', 'my-repo']);
    expect(readFileSync(join(dir, 'cfgdir'), 'utf8')).toBe(`${dir}/cfg`);
    expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(repo);
    const again = await launch(deps, { account: 'me', repo, options: {} });
    expect(again).toMatchObject({ ok: true });
    expect(execFileSync('tmux', ['list-windows', '-t', `=${tmux}`], { encoding: 'utf8' }).trim().split('\n')).toHaveLength(2);
  });

  it('reports the started pane (target, the pid tmux gives for it, folder) so the board can show it until Claude registers (Task 40)', async () => {
    const { repo, tmux, deps } = setup();
    const started: any[] = [];
    const r = await launch({ ...deps, onStarted: (l) => started.push(l) }, { account: 'me', repo, options: {} });
    expect(r).toMatchObject({ ok: true });
    const target = (r as any).target;
    expect(started).toEqual([{ host: 'local', account: 'me', target, pid: expect.any(Number), cwd: repo, name: 'my repo' }]);
    const panePid = execFileSync('tmux', ['display-message', '-p', '-t', target.split(':')[1].split('.')[1], '#{pane_pid}'], { encoding: 'utf8' }).trim();
    expect(String(started[0].pid)).toBe(panePid);
    expect(tmux).toBeTruthy();
  });

  it('leaves CLAUDE_CONFIG_DIR unset for the default ~/.claude, so the session reads ~/.claude.json like a plain claude', async () => {
    const { dir, repo, tmux } = setup();
    const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: ${tmux}, claudeBin: ${dir}/claude-stub, repoRoots: [${dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ~/.claude/}]`);
    expect(cfg.accounts[0].configDir).toBe(`${process.env.HOME}/.claude/`);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
    // A value the launching shell (and so a tmux server it starts) carries must not leak into the session either.
    const prev = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = join(dir, 'inherited');
    try {
      const deps = { cfg, exec: makeExec(), caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) };
      expect(await launch(deps, { account: 'me', repo, options: {} })).toMatchObject({ ok: true });
    } finally {
      if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
    }
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'cfgdir'), 'utf8')).toBe('<unset>');
  });

  it('rejects a repo that was not listed, an unknown account, and options outside the allowed list', async () => {
    const { repo, deps } = setup();
    expect(await launch(deps, { account: 'me', repo: '/etc', options: {} })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await launch(deps, { account: 'me', repo: `${repo}/../../etc`, options: {} })).toMatchObject({ ok: false, error: 'forbidden' });
    expect(await launch(deps, { account: 'nope', repo, options: {} })).toMatchObject({ ok: false, error: 'unknown_account' });
    expect(await launch(deps, { account: 'me', repo, options: { model: 'x; id' } })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await launch(deps, { account: 'me', repo, options: { effort: 'turbo' } })).toMatchObject({ ok: false, error: 'bad_request' });
  });

  it('refuses an effort the installed CLI does not list', () => {
    const { deps } = setup();
    expect(() => validateOptions(deps.cfg, parseClaudeHelp('--model <m> x'), { effort: 'high' })).toThrow(/does not support/);
    expect(() => validateOptions(deps.cfg, parseClaudeHelp(HELP), { remoteControl: true })).not.toThrow();
  });

  it('reports a missing claude binary with its message', async () => {
    const { repo, deps } = setup();
    const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: ${TEST_PREFIX}missing, claudeBin: /nonexistent/claude, repoRoots: [/x]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x/cfg}]`);
    sessions.push(`${TEST_PREFIX}missing`);
    const r = await launch({ ...deps, cfg, repos: new RepoLister(cfg, async () => ({ ok: true, repos: [{ path: repo, name: 'r', lastUsedMs: 0 }] })) }, { account: 'me', repo, options: {} });
    expect(r).toMatchObject({ ok: false, error: 'failed' });
    expect((r as any).message).toMatch(/not found/);
  });

  it('puts a hostile folder name through safely', async () => {
    const { dir, deps } = setup();
    const evil = join(dir, "x'; touch PWNED; '");
    mkdirSync(evil);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: evil, name: "x'; touch PWNED; '", lastUsedMs: 0 }] };
    const d2 = { ...deps, caps: new CapsCache(probe), repos: new RepoLister(deps.cfg, probe) };
    expect(await launch(d2, { account: 'me', repo: evil, options: {} })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    // An injected `touch PWNED` would run in whatever directory that shell was in: check all of them.
    for (const d of [dir, evil, process.cwd(), process.env.HOME!]) expect(existsSync(join(d, 'PWNED'))).toBe(false);
  });

  // Over ssh the whole argv is one string for the remote login shell (sshd runs `$SHELL -c`), which may be fish.
  it.each([['sh', ['sh']], ['fish', FISH ? [FISH, '--no-config'] : null]] as const)('launches a hostile folder over ssh with a %s login shell', async (_n, shell) => {
    if (!shell) return; // no fish here: the quoting itself is covered in quote.test.ts
    const { dir, tmux } = setup();
    const name = `x\\'; touch PWNED; # $(touch PWNED) \`touch PWNED\` \\`;
    const evil = join(dir, name);
    mkdirSync(evil);
    const cfg = parseConfig(`
hosts: [{id: box, ssh: box, tmuxSession: ${tmux}, claudeBin: ${dir}/claude-stub, repoRoots: [${dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: box, configDir: ~/cfg-remote}]`);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: evil, name, lastUsedMs: 0 }] };
    const exec = makeExec({ sshBin: makeFakeSsh(undefined, [...shell]).bin });
    const deps = { cfg, exec, caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) };
    expect(await launch(deps, { account: 'me', repo: evil, options: { model: 'opus' } })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(evil);
    expect(readFileSync(join(dir, 'cfgdir'), 'utf8')).toBe(join(process.env.HOME!, 'cfg-remote'));
    for (const d of [dir, evil, process.cwd(), process.env.HOME!]) expect(existsSync(join(d, 'PWNED'))).toBe(false);
  });

  it('starts in a folder whose name holds tmux format characters, literally and without running anything', async () => {
    const { dir, deps } = setup();
    // tmux format-expands the -c start directory: #(...) would run a command, ## and #{..} would rewrite the path.
    for (const name of ['r#(cd;touch PWNED)', 'a##b', 'c#{session_name}', 'd#[fg=red]', 'e##[x]', 'f#,g#}']) {
      const folder = join(dir, name);
      mkdirSync(folder);
      rmSync(join(dir, 'cwd'), { force: true });
      const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: folder, name, lastUsedMs: 0 }] };
      const d2 = { ...deps, caps: new CapsCache(probe), repos: new RepoLister(deps.cfg, probe) };
      expect(await launch(d2, { account: 'me', repo: folder, options: {} })).toMatchObject({ ok: true });
      expect(await waitFor(join(dir, 'cwd'))).toBe(true);
      expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(folder);
    }
    for (const d of [dir, process.cwd(), process.env.HOME!]) expect(existsSync(join(d, 'PWNED'))).toBe(false);
  });

  it('expands a leading ~ in claudeBin, which the capability probe also accepts', async () => {
    const { dir, repo, tmux } = setup();
    mkdirSync(join(process.env.HOME!, 'stubs'), { recursive: true });
    copyFileSync(join(dir, 'claude-stub'), join(process.env.HOME!, 'stubs', 'claude'));
    chmodSync(join(process.env.HOME!, 'stubs', 'claude'), 0o755);
    const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: ${tmux}, claudeBin: ~/stubs/claude, repoRoots: [${dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ${dir}/cfg}]`);
    expect(cfg.hosts[0].claudeBin).toBe('~/stubs/claude');
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
    const deps = { cfg, exec: makeExec(), caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) };
    expect(await launch(deps, { account: 'me', repo, options: {} })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(repo);
  });

  it('leaves out -n when the installed CLI does not list --name', async () => {
    const { dir, repo, deps } = setup();
    const help = HELP.replace(/^\s*-n, --name.*\n/m, '');
    expect(parseClaudeHelp(help).name).toBe(false);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
    const d2 = { ...deps, caps: new CapsCache(probe), repos: new RepoLister(deps.cfg, probe) };
    expect(await launch(d2, { account: 'me', repo, options: { model: 'opus' } })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['--model', 'opus']);
  });

  it('runs the executable behind a claude alias, and refuses a claude that is only a shell function', async () => {
    const { dir, repo, tmux } = setup();
    mkdirSync(join(dir, 'bin'));
    copyFileSync(join(dir, 'claude-stub'), join(dir, 'bin', 'cc-test-claude'));
    chmodSync(join(dir, 'bin', 'cc-test-claude'), 0o755);
    const profile = join(process.env.HOME!, '.bash_profile');
    const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: ${tmux}, claudeBin: cc-test-claude, repoRoots: [${dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ${dir}/cfg}]`);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
    const deps = () => ({ cfg, exec: makeExec(), caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) });
    try {
      // A unique name, so a real claude on PATH can never be found. `command -v` would print "alias claude=..." here and launch that text as the program.
      writeFileSync(profile, `export PATH="${dir}/bin:$PATH"\nalias cc-test-claude='echo aliased'\n`);
      expect(await launch(deps(), { account: 'me', repo, options: {} })).toMatchObject({ ok: true });
      expect(await waitFor(join(dir, 'cwd'))).toBe(true);
      expect(readFileSync(join(dir, 'cwd'), 'utf8').trim()).toBe(repo);
      // A function is not something tmux can run: say so rather than start a window that dies at once.
      writeFileSync(profile, `cc-test-claude() { :; }\n`);
      const r = await launch(deps(), { account: 'me', repo, options: {} });
      expect(r).toMatchObject({ ok: false, error: 'failed' });
      expect((r as any).message).toMatch(/not found/);
    } finally {
      rmSync(profile, { force: true });
    }
  });
});

describe('launchOptions', () => {
  it('intersects the allowed lists with what the CLI supports, and disables an unreachable host', async () => {
    const { deps } = setup();
    const o = await launchOptions(deps);
    expect(o.accounts[0]).toMatchObject({ canLaunch: true, remoteControl: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
      moreModels: ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001', 'claude-fable-5'], efforts: ['low', 'medium', 'high', 'xhigh', 'max'] });
    expect(o.accounts[0].modelNames).toMatchObject({ 'claude-opus-5-5': 'Opus 5.5', 'claude-haiku-4-5-20251001': 'Haiku 4.5' });
    const down = await launchOptions({ cfg: deps.cfg, caps: new CapsCache(async () => { throw new Error('ssh: unreachable'); }) });
    expect(down.accounts[0]).toMatchObject({ canLaunch: false, reason: 'ssh: unreachable' });
  });
});

describe('Task 42a: + New with a Name', () => {
  it('passes the name to claude as one --name=… argument, cleaned like a nickname, and reports it for the starting row and the board name', async () => {
    const { dir, repo, deps } = setup();
    const started: any[] = [];
    const r = await launch({ ...deps, onStarted: (l) => started.push(l) }, { account: 'me', repo, options: { model: 'opus', name: '  api   work ' } });
    expect(r).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['--model', 'opus', '--name=api work']);
    expect(started).toEqual([expect.objectContaining({ name: 'api work', nickname: 'api work' })]);
    // the tmux window keeps the folder's name
    expect(execFileSync('tmux', ['display-message', '-p', '-t', (r as any).target.split('.').pop(), '#{window_name}'], { encoding: 'utf8' }).trim()).toBe('my-repo');
  });

  it('a hostile name is one argument, with nothing run (locally and over ssh)', async () => {
    const name = `-p $(touch PWNED) 'x' \`id\` ;#{h}`;
    const { dir, repo, deps } = setup();
    expect(await launch(deps, { account: 'me', repo, options: { name } })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').split('\n').filter(Boolean)).toEqual([`--name=${name}`]);
    const r2 = setup();
    const cfg = parseConfig(`
hosts: [{id: box, ssh: box, tmuxSession: ${r2.tmux}, claudeBin: ${r2.dir}/claude-stub, repoRoots: [${r2.dir}]}]
accounts: [{id: me, label: Me, colour: "#fff", host: box, configDir: ~/cfg-remote}]`);
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: HELP } : { ok: true, repos: [{ path: r2.repo, name: 'my repo', lastUsedMs: 0 }] };
    const exec = makeExec({ sshBin: makeFakeSsh(undefined, ['sh']).bin });
    const d3 = { cfg, exec, caps: new CapsCache(probe), repos: new RepoLister(cfg, probe), attachNew: async () => ({ ok: true as const, message: 'attached' }) };
    expect(await launch(d3, { account: 'me', repo: r2.repo, options: { name } })).toMatchObject({ ok: true });
    expect(await waitFor(join(r2.dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(r2.dir, 'args'), 'utf8').split('\n').filter(Boolean)).toEqual([`--name=${name}`]);
    for (const d of [dir, r2.dir, repo, r2.repo, process.cwd(), process.env.HOME!]) expect(existsSync(join(d, 'PWNED'))).toBe(false);
  });

  it('refuses a name a nickname could not have, before starting anything', async () => {
    const { repo, tmux, deps } = setup();
    for (const bad of ['x'.repeat(41), '', '   ', '​⁠', 'a‮b'])
      expect(await launch(deps, { account: 'me', repo, options: { name: bad } }), JSON.stringify(bad)).toMatchObject({ ok: false, error: 'bad_request' });
    expect(() => execFileSync('tmux', ['has-session', '-t', `=${tmux}`], { stdio: 'ignore' })).toThrow();
  });

  it('a claude without --name gets no flag, and the name is still the board\'s', async () => {
    const { dir, repo, deps } = setup();
    const help = HELP.replace(/^\s*-n, --name.*\n/m, '');
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help } : { ok: true, repos: [{ path: repo, name: 'my repo', lastUsedMs: 1 }] };
    const started: any[] = [];
    const d2 = { ...deps, caps: new CapsCache(probe), repos: new RepoLister(deps.cfg, probe), onStarted: (l: any) => started.push(l) };
    expect(await launch(d2, { account: 'me', repo, options: { name: 'api work' } })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim()).toBe('');
    expect(started).toEqual([expect.objectContaining({ name: 'api work', nickname: 'api work' })]);
  });

  it('without a name nothing changes: -n with the window name, the folder name on the starting row, no nickname', async () => {
    const { dir, repo, deps } = setup();
    const started: any[] = [];
    expect(await launch({ ...deps, onStarted: (l) => started.push(l) }, { account: 'me', repo, options: {} })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['-n', 'my-repo']);
    expect(started[0].name).toBe('my repo');
    expect(started[0].nickname).toBeUndefined();
  });
});

describe('Task 46: real models and the permission mode', () => {
  const discovered = [
    { id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
    { id: 'claude-opus-4-7', display_name: 'Opus 4.7', created_at: '2025-11-01T00:00:00Z' },
  ];
  const modelProbe = async (_h: unknown, req: any) => ({ ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true, models: discovered })) });

  it('reads the permission modes from help text, wrapped or on one line, and none from an older claude', () => {
    expect(parseClaudeHelp('  --permission-mode <mode>  Permission mode (choices: "acceptEdits", "bypassPermissions", "default", "plan")\n').permissionModes)
      .toEqual(['acceptEdits', 'bypassPermissions', 'default', 'plan']);
    expect(parseClaudeHelp('  --permission-mode <mode>  Permission mode to use\n').permissionModes).toEqual([]);
    expect(parseClaudeHelp(HELP.replace(/--permission-mode[\s\S]*?"plan"\)\n/, '')).permissionModes).toEqual([]);
  });

  it('launches with a discovered model id and refuses one the account does not have', async () => {
    const { dir, repo, deps } = setup();
    const models = new ModelCache(deps.cfg, modelProbe);
    await models.refresh();
    expect(await launch({ ...deps, models }, { account: 'me', repo, options: { model: 'claude-opus-9' } })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await launch({ ...deps, models }, { account: 'me', repo, options: { model: 'claude-opus-4-7', permissionMode: 'plan' } })).toMatchObject({ ok: true });
    expect(await waitFor(join(dir, 'cwd'))).toBe(true);
    expect(readFileSync(join(dir, 'args'), 'utf8').trim().split('\n')).toEqual(['--model', 'claude-opus-4-7', '--permission-mode', 'plan', '-n', 'my-repo']);
  });

  it('offers the discovered list grouped, the modes the CLI lists (bypass only when the config allows it)', async () => {
    const { deps } = setup();
    const models = new ModelCache(deps.cfg, modelProbe);
    const o = await launchOptions({ ...deps, models });
    expect(o.accounts[0]).toMatchObject({ models: ['claude-opus-5-5'], moreModels: ['claude-opus-4-7'], modelNames: { 'claude-opus-5-5': 'Opus 5.5', 'claude-opus-4-7': 'Opus 4.7' },
      modes: ['acceptEdits', 'auto', 'plan', 'dontAsk'] });
    const allowed = setup('launch: {allowBypassPermissions: true}');
    expect((await launchOptions(allowed.deps)).accounts[0].modes).toEqual(['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']);
  });

  it('refuses bypassPermissions unless the config allows it, and then only with the confirm flag', () => {
    const caps = parseClaudeHelp(HELP);
    const off = setup().deps.cfg, on = setup('launch: {allowBypassPermissions: true}').deps.cfg;
    expect(() => validateOptions(off, caps, { permissionMode: 'bypassPermissions', confirmBypass: true })).toThrow(/allowBypassPermissions/);
    expect(() => validateOptions(on, caps, { permissionMode: 'bypassPermissions' })).toThrow(/confirm/);
    expect(validateOptions(on, caps, { permissionMode: 'bypassPermissions', confirmBypass: true }).permissionMode).toBe('bypassPermissions');
  });

  it('refuses a mode the CLI does not list or that is not a known mode; Manual and default pass no flag', () => {
    const caps = parseClaudeHelp(HELP);
    const { cfg } = setup().deps;
    expect(() => validateOptions(cfg, caps, { permissionMode: 'plan; id' })).toThrow(/permission mode/);
    expect(() => validateOptions(cfg, parseClaudeHelp(HELP.replace('"plan"', '"other"')), { permissionMode: 'plan' })).toThrow(/does not support/);
    expect(() => validateOptions(cfg, parseClaudeHelp('--model <m>'), { permissionMode: 'acceptEdits' })).toThrow(/does not support/);
    for (const m of ['manual', 'default', '']) expect(validateOptions(cfg, caps, { permissionMode: m }).permissionMode).toBeUndefined();
  });

  it('puts --permission-mode and the model id in argv as separate arguments', () => {
    const { deps } = setup();
    const argv = launchArgv({ host: deps.cfg.hosts[0], account: deps.cfg.accounts[0], repoPath: '/r', windowName: 'r',
      options: { model: 'claude-opus-5-5[1m]', permissionMode: 'acceptEdits', remoteControl: false, openOnPc: false, name: false } });
    expect(argv.slice(-4)).toEqual(['--model', 'claude-opus-5-5[1m]', '--permission-mode', 'acceptEdits']);
  });
});

describe('Task 47: launch.defaultMode', () => {
  it('each account is offered the configured default mode, or Manual (\'\') when its claude does not list it', async () => {
    expect((await launchOptions(setup().deps)).accounts[0].defaultMode).toBe('auto');
    expect((await launchOptions(setup('launch: {defaultMode: plan}').deps)).accounts[0].defaultMode).toBe('plan');
    expect((await launchOptions(setup('launch: {defaultMode: manual}').deps)).accounts[0].defaultMode).toBe('');
    expect((await launchOptions(setup('launch: {defaultMode: bypassPermissions, allowBypassPermissions: true}').deps)).accounts[0].defaultMode).toBe('bypassPermissions');
    // A host whose claude lists no "auto" (an older CLI) falls back to Manual for that host.
    const noAuto = setup();
    const caps = { get: async () => ({ caps: parseClaudeHelp(HELP.replace('"auto", ', '').replace('"auto"', '')) }) } as unknown as CapsCache;
    const o = (await launchOptions({ ...noAuto.deps, caps })).accounts[0];
    expect(o.modes).not.toContain('auto');
    expect(o.defaultMode).toBe('');
  });

  it('server confirm rule: bypass without the confirm only when the owner made it the default', () => {
    const caps = parseClaudeHelp(HELP);
    const byDefault = setup('launch: {defaultMode: bypassPermissions, allowBypassPermissions: true}').deps.cfg;
    const byHand = setup('launch: {allowBypassPermissions: true}').deps.cfg;
    expect(validateOptions(byDefault, caps, { permissionMode: 'bypassPermissions' }).permissionMode).toBe('bypassPermissions');
    expect(() => validateOptions(byHand, caps, { permissionMode: 'bypassPermissions' })).toThrow(/confirm/);
    expect(() => validateOptions(byHand, caps, { permissionMode: 'bypassPermissions', confirmBypass: false })).toThrow(/confirm/);
    expect(validateOptions(byHand, caps, { permissionMode: 'bypassPermissions', confirmBypass: true }).permissionMode).toBe('bypassPermissions');
  });

  it('argv for each mode: --permission-mode <mode>, nothing for Manual', () => {
    const caps = parseClaudeHelp(HELP);
    const { cfg } = setup('launch: {defaultMode: bypassPermissions, allowBypassPermissions: true}').deps;
    const argv = (permissionMode: string) => launchArgv({ host: cfg.hosts[0], account: cfg.accounts[0], repoPath: '/r', windowName: 'r',
      options: validateOptions(cfg, caps, { permissionMode }) });
    for (const m of ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']) expect(argv(m).slice(-4)).toEqual(['--permission-mode', m, '-n', 'r']);
    for (const m of ['', 'manual']) expect(argv(m)).not.toContain('--permission-mode');
  });
});

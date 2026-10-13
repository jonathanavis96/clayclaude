import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec, type HostExec } from '../src/actions/exec.js';
import { SEND_CHOICE_SCRIPT, SendGuard, answer, cleanText, readPrompt, type AnswerDeps } from '../src/actions/answer.js';
import { parsePane } from '../src/actions/pane.js';
import { killOwn, testSessionName } from './helpers/tmux.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x}]`);

/** A fish binary for the login-shell tests: CLAYCLAUDE_TEST_FISH, or fish on PATH. */
const FISH = process.env.CLAYCLAUDE_TEST_FISH
  || (() => { try { return execFileSync('sh', ['-c', 'command -v fish'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();

const made: string[] = [];
afterEach(() => { made.splice(0).forEach(killOwn); });
// Keep one idle session for the whole file. Killing the last session makes the private tmux server exit, and a
// new-session sent while it is still exiting fails with "server exited unexpectedly" (seen under a loaded full suite).
const keeper = testSessionName('keep-');
beforeAll(() => { execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']); });
afterAll(() => killOwn(keeper));
const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A tmux session of our own running a fixture; returns the Session record Claude would have written. */
async function startFixture(script: string, host = 'local') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ans-'));
  const result = join(dir, 'result');
  const name = testSessionName('ans-');
  made.push(name);
  execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '30', '-s', name, `${fx(script)} ${result}`]);
  const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
  await wait(400);
  const session = { key: 'local:me:s1', host, account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, state: 'needs-you' } as any;
  return { dir, result, session, name };
}
const deps = (session: any, exec: HostExec = makeExec()): AnswerDeps =>
  ({ cfg, sessions: () => [session], exec, quickReplies: () => ['yes', 'no'], guard: new SendGuard() });

describe('answer against a real tmux pane', () => {
  it('reads a permission prompt and sends the chosen key', async () => {
    const f = await startFixture('prompt-menu.sh');
    const d = deps(f.session);
    const r = await readPrompt(d, 'local:me:s1');
    expect(r).toMatchObject({ ok: true, prompt: { kind: 'menu', quickReplies: ['yes', 'no'] } });
    const prompt = (r as any).prompt;
    expect(prompt.options.map((o: any) => o.key)).toEqual(['1', '2', '3']);
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: prompt.hash, choice: '2' })).toEqual({ ok: true, sent: 'option 2' });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe('2');
  });

  it('types a free-text reply and presses Enter', async () => {
    const f = await startFixture('prompt-text.sh');
    const d = deps(f.session);
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    const text = `leave it; $(touch ${f.dir}/pwned) 'quoted' "dq" \`id\` -n`;
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: true });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe(text);
    expect(existsSync(join(f.dir, 'pwned'))).toBe(false);
  });

  // tmux's own argument parser treats a trailing `;` on any argument as a command separator and a
  // trailing `\;` as an escaped `;`, so these used to arrive as `do it`, `a;`, an empty line and `a;`.
  it.each(['do it;', 'a\\;', ';', 'x ;;', 'run-shell id;'])('types a reply ending in a semicolon intact: %s', async (text) => {
    const f = await startFixture('prompt-text.sh');
    const d = deps(f.session);
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: true });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe(text);
  });

  // Words tmux itself might read: key names (only literal with -l), formats, braces (tmux 3.x command blocks),
  // option-shaped words, and escapes. Each must arrive exactly as typed.
  it.each(['C-c', 'Enter', '{', '}', '{ new-window }', '#{pane_id} #(touch pwned) #[fg=red]', '~ %1 %%', '-t %0 -l --',
    'end\\', 'mid\\;dle', '\\\\;', '; leading', '\u202eevil 😀 ünï'])('types %s literally', async (text) => {
    const f = await startFixture('prompt-text.sh');
    const d = deps(f.session);
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: true });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe(text);
    expect(existsSync(join(process.cwd(), 'pwned'))).toBe(false);
  });

  it('types a hostile reply intact through an ssh remote shell', async () => {
    // The fake ssh (Task 7) runs the joined command with `sh -c`, exactly as a remote login shell would,
    // against the same private tmux server.
    const f = await startFixture('prompt-text.sh', 'box');
    const d = deps(f.session, makeExec({ sshBin: makeFakeSsh().bin }));
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    const text = `it's "fine"; $(touch ${f.dir}/pwned) \`id\` \\ done \\;`;
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: true });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe(text);
    expect(existsSync(join(f.dir, 'pwned'))).toBe(false);
  });

  // sshd runs the command with the user's login shell. fish reads `\\` and `\'` as escapes inside single quotes, so
  // this reply used to close the quote and run `touch` on the remote host.
  it.skipIf(!FISH)('types a hostile reply intact when the remote login shell is fish', async () => {
    const f = await startFixture('prompt-text.sh', 'box');
    const d = deps(f.session, makeExec({ sshBin: makeFakeSsh(undefined, [FISH, '--no-config']).bin }));
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    const text = `x\\'; touch ${f.dir}/pwned; # and \\\\ \\`;
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: true });
    await wait(300);
    expect(existsSync(join(f.dir, 'pwned'))).toBe(false);
    expect(readFileSync(f.result, 'utf8')).toBe(text);
  });

  // Ctrl-Z suspends Claude and hands the terminal back to the shell that started it. Claude's input box is still on
  // screen and its pid is still under the pane, so the pane read as a text prompt and the reply ran in the shell.
  it('refuses a session whose claude is suspended, so the reply never reaches the shell below it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-ans-'));
    const name = testSessionName('ans-');
    made.push(name);
    execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '30', '-s', name, 'env', 'PS1=$ ', 'bash', '--norc', '--noprofile', '-i']);
    const [win, pane] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id}'], { encoding: 'utf8' }).trim().split(' ');
    await wait(300);
    execFileSync('tmux', ['send-keys', '-t', pane, '-l', '--', `${fx('prompt-suspended.sh')} ${dir}/pid`]);
    execFileSync('tmux', ['send-keys', '-t', pane, 'Enter']);
    for (let i = 0; i < 30 && !existsSync(join(dir, 'pid')); i++) await wait(100);
    await wait(400);
    const pid = Number(readFileSync(join(dir, 'pid'), 'utf8'));
    const session = { key: 'local:me:s1', host: 'local', account: 'me', sessionId: 's1', pid, tmux: `${name}:${win}.${pane}`, hostOnline: true, state: 'needs-you' } as any;
    const d = deps(session);
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r).toMatchObject({ ok: false, error: 'no_prompt' });
    const a = await answer(d, { sessionId: 'local:me:s1', promptHash: parsePane(execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', pane], { encoding: 'utf8' })).hash, text: `touch ${dir}/pwned` });
    expect(a).toMatchObject({ ok: false, error: 'no_prompt' });
    await wait(500);
    expect(existsSync(join(dir, 'pwned'))).toBe(false);
  });

  // synchronize-panes copies every key send-keys delivers (-l included) to the other panes of the window, so a
  // reply meant for Claude also ran in a shell beside it. Copy mode turns the keys into copy-mode commands
  // ('yes' was reported as sent while Claude got nothing), and a pane with input disabled drops them silently.
  it.each([
    ['synchronize-panes', (pane: string) => execFileSync('tmux', ['set-option', '-w', '-t', pane, 'synchronize-panes', 'on'])],
    ['copy mode', (pane: string) => execFileSync('tmux', ['copy-mode', '-t', pane])],
    ['input disabled', (pane: string) => execFileSync('tmux', ['select-pane', '-d', '-t', pane])],
  ])('refuses a pane with %s, so nothing reaches Claude or another pane', async (_label, setup) => {
    const f = await startFixture('prompt-text.sh');
    const pane = f.session.tmux.split('.').at(-1);
    const pwned = join(f.dir, 'pwned');
    execFileSync('tmux', ['split-window', '-d', '-t', pane, 'env', 'PS1=$ ', 'bash', '--norc', '--noprofile', '-i']);
    await wait(300);
    const hash = parsePane(execFileSync('tmux', ['capture-pane', '-p', '-J', '-t', pane], { encoding: 'utf8' })).hash;
    setup(pane);
    const d = deps(f.session);
    expect(await readPrompt(d, 'local:me:s1')).toMatchObject({ ok: false, error: 'no_prompt' });
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: `touch ${pwned}` })).toMatchObject({ ok: false, error: 'no_prompt' });
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: 'yes' })).toMatchObject({ ok: false, error: 'no_prompt' });
    await wait(500);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(f.result)).toBe(false);
  });

  // The same states, reached after the capture passed: the send script's own check must stop the keys.
  it.each([
    ['synchronize-panes', (pane: string) => execFileSync('tmux', ['set-option', '-w', '-t', pane, 'synchronize-panes', 'on'])],
    ['copy mode', (pane: string) => execFileSync('tmux', ['copy-mode', '-t', pane])],
  ])('the send-time check refuses a pane that went into %s after the capture', async (_label, setup) => {
    const f = await startFixture('prompt-text.sh');
    const pane = f.session.tmux.split('.').at(-1);
    const pwned = join(f.dir, 'pwned');
    execFileSync('tmux', ['split-window', '-d', '-t', pane, 'env', 'PS1=$ ', 'bash', '--norc', '--noprofile', '-i']);
    await wait(300);
    const spy: HostExec = (h, argv, o) => { if (argv[2]?.includes('send-keys')) setup(pane); return makeExec()(h, argv, o); };
    const d = deps(f.session, spy);
    const r: any = await readPrompt(d, 'local:me:s1');
    expect(r.prompt.kind).toBe('text');
    const a = await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: `touch ${pwned}` });
    expect(a).toMatchObject({ ok: false, error: 'no_prompt' });
    await wait(500);
    expect(existsSync(pwned)).toBe(false);
    expect(existsSync(f.result)).toBe(false);
  });

  it('sends nothing when the prompt has changed since it was read', async () => {
    const f = await startFixture('prompt-menu.sh');
    const sent: string[][] = [];
    const spy: HostExec = (h, argv, o) => { if (argv[2]?.includes('send-keys')) sent.push(argv); return makeExec()(h, argv, o); };
    const d = deps(f.session, spy);
    const r = await answer(d, { sessionId: 'local:me:s1', promptHash: 'stale-hash', choice: '1' });
    expect(r).toMatchObject({ ok: false, error: 'prompt_changed', prompt: { kind: 'menu' } });
    expect(sent).toEqual([]);
    await wait(200);
    expect(existsSync(f.result)).toBe(false);
  });

  it('refuses when the pane is not the session\'s (wrong pid or wrong ref) and when it is gone', async () => {
    const f = await startFixture('prompt-menu.sh');
    expect(await readPrompt(deps({ ...f.session, pid: 1 }), 'local:me:s1')).toMatchObject({ ok: false, error: 'pane_gone' });
    expect(await readPrompt(deps({ ...f.session, tmux: f.session.tmux.replace(/@\d+/, '@999') }), 'local:me:s1')).toMatchObject({ ok: false, error: 'pane_gone' });
    killOwn(f.name);
    expect(await readPrompt(deps(f.session), 'local:me:s1')).toMatchObject({ ok: false, error: 'pane_gone' });
  });
});

describe('answer validation (no tmux)', () => {
  const view = parsePane(readFileSync(join(import.meta.dirname, 'fixtures/panes/perm-bash.txt'), 'utf8'));
  const fakeExec = (calls: string[][], sendCode = 0): HostExec => async (_h, argv) => {
    calls.push(argv);
    if (argv[2].includes('capture-pane')) return { code: 0, stdout: 'OK\n' + readFileSync(join(import.meta.dirname, 'fixtures/panes/perm-bash.txt'), 'utf8'), stderr: '' };
    return { code: sendCode, stdout: '', stderr: sendCode ? 'that pane no longer belongs to this session\n' : '' };
  };
  const session = { key: 'k', host: 'local', pid: 5, tmux: 's:@1.%1', hostOnline: true } as any;
  const sends = (calls: string[][]) => calls.filter((c) => c[2].includes('send-keys'));

  it('rejects a choice that is not on screen, and text while a menu is showing', async () => {
    const calls: string[][] = [];
    const d = deps(session, fakeExec(calls));
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: '7' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: '1; id' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, text: 'hi' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(sends(calls)).toEqual([]);
  });
  it('sends exactly the key for a valid choice, with the expected ref for the send-time ownership check', async () => {
    const calls: string[][] = [];
    expect(await answer(deps(session, fakeExec(calls)), { sessionId: 'k', promptHash: view.hash, choice: '3' })).toMatchObject({ ok: true });
    expect(calls.at(-1)).toEqual(['sh', '-c', SEND_CHOICE_SCRIPT, '_', '%1', '3', 's:@1.%1']);
  });
  it('reports pane_gone when the pane changed hands between the check and the send', async () => {
    expect(await answer(deps(session, fakeExec([], 3)), { sessionId: 'k', promptHash: view.hash, choice: '1' }))
      .toMatchObject({ ok: false, error: 'pane_gone' });
  });
  it('a double tap sends the answer once, and the same prompt is not answered twice in a row', async () => {
    const calls: string[][] = [];
    const d = deps(session, fakeExec(calls));
    const both = await Promise.all([1, 2].map(() => answer(d, { sessionId: 'k', promptHash: view.hash, choice: '1' })));
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(both.find((r) => !r.ok)).toMatchObject({ error: 'duplicate' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: '1' })).toMatchObject({ ok: false, error: 'duplicate' });
    expect(sends(calls)).toHaveLength(1);
  });
  it('reports unknown sessions, offline hosts and sessions without tmux', async () => {
    expect(await readPrompt(deps(session), 'nope')).toMatchObject({ error: 'unknown_session' });
    expect(await readPrompt(deps({ ...session, hostOnline: false }), 'k')).toMatchObject({ error: 'host_offline' });
    expect(await readPrompt(deps({ ...session, tmux: undefined }), 'k')).toMatchObject({ error: 'no_tmux' });
    expect(await readPrompt(deps({ ...session, tmux: "x';id:@1.%1" }), 'k')).toMatchObject({ error: 'no_tmux' });
  });
  it('reads the prompt past text a remote shell startup file prints first', async () => {
    // Debian bash sources ~/.bashrc for ssh commands; an echo or a conda banner there lands before the script's OK.
    const pane = readFileSync(join(import.meta.dirname, 'fixtures/panes/perm-bash.txt'), 'utf8');
    const motd: HostExec = async () => ({ code: 0, stdout: 'Welcome to box!\nOK not really\n\nOK\n' + pane, stderr: '' });
    expect(await readPrompt(deps(session, motd), 'k')).toMatchObject({ ok: true, prompt: { kind: 'menu', hash: view.hash } });
    const gone: HostExec = async () => ({ code: 0, stdout: 'Welcome to box!\nERR gone\n', stderr: '' });
    expect(await readPrompt(deps(session, gone), 'k')).toMatchObject({ ok: false, error: 'pane_gone' });
  });
  it('reports the last stderr line (the actual error), not a shell warning printed before it', async () => {
    const exec: HostExec = async (_h, argv) => argv[2].includes('capture-pane')
      ? { code: 0, stdout: 'OK\n' + readFileSync(join(import.meta.dirname, 'fixtures/panes/perm-bash.txt'), 'utf8'), stderr: '' }
      : { code: 1, stdout: '', stderr: 'bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)\nno server running on /tmp/tmux-1000/default\n' };
    expect(await answer(deps(session, exec), { sessionId: 'k', promptHash: view.hash, choice: '1' }))
      .toMatchObject({ ok: false, error: 'failed', message: 'no server running on /tmp/tmux-1000/default' });
  });
  it('cleans reply text', () => {
    expect(cleanText(' a\r\nb\tc ')).toBe('a b c');
    expect(cleanText('x\x1b[31m')).toMatchObject({ error: 'bad_request' });
    expect(cleanText('x\x03')).toMatchObject({ error: 'bad_request' });
    expect(cleanText('x\u009b1m')).toMatchObject({ error: 'bad_request' });
    expect(cleanText('   ')).toMatchObject({ error: 'bad_request' });
    expect(cleanText('é'.repeat(4000))).toBe('é'.repeat(4000));
    expect(cleanText('x'.repeat(4001))).toMatchObject({ error: 'too_long' });
  });
});

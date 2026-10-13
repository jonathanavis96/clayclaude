import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec, type HostExec } from '../src/actions/exec.js';
import { CAPTURE_SCRIPT, SEND_CHOICE_SCRIPT, SEND_ENTER_SCRIPT, SEND_MOVE_SCRIPT, SEND_PASTE_SCRIPT, SEND_PERMISSION_SCRIPT, SendGuard, answer, cleanText, readPrompt, type AnswerDeps } from '../src/actions/answer.js';
import { inputBoxTail, parsePane } from '../src/actions/pane.js';
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

/**
 * Every pane fixture through the real answer path: drawn in a tmux pane of our own on the suite's private server, read,
 * answered with each button the sheet offers, and the keys that reached the pane recorded (prompt-screen.sh).
 * A permission prompt offers Yes and No only: Yes is exactly "1", No is exactly Escape, and nothing else (a digit, a typed
 * reply) is accepted for it. Real 2.1.296 captures: perm-bash-dashed, perm-write-dashed, trust-folder, and every one in
 * real-2.1.296 (REAL_PERMISSION, REAL_MENUS, the plan approval).
 */
const PANES = join(import.meta.dirname, 'fixtures', 'panes');
const PERMISSION = readdirSync(PANES).filter((f) => /^(perm|spoof)-.*\.txt$/.test(f)).sort();
const menuKeys: [string, string, string][] = [
  // fixture, choice, keys Claude must receive (its own numbering; the confirm dialogs move the cursor, then Enter)
  ['askuser.txt', '1', '1'], ['askuser.txt', '2', '2'], ['askuser.txt', '3', '3'],
  ['trust-folder.txt', '1', 'ENTER'], ['trust-folder.txt', '2', 'ESC[BENTER'],
  ['imports-dialog.txt', '1', 'ENTER'], ['imports-dialog.txt', '2', 'ESC[BENTER'],
  // Real Claude Code 2.1.296 captures (fixtures/panes/real-2.1.296/menu-captures.md). Its AskUserQuestion draws a rule
  // between "4. Type something." and "5. Chat about this" and numbers straight on: every key is Claude's own number.
  ...['1', '2', '3', '4', '5'].map((k): [string, string, string] => ['real-2.1.296/askuser.txt', k, k]),
  ['real-2.1.296/trust-folder.txt', '1', 'ENTER'], ['real-2.1.296/trust-folder.txt', '2', 'ESC[BENTER'],
  ['real-2.1.296/external-imports.txt', '1', 'ENTER'], ['real-2.1.296/external-imports.txt', '2', 'ESC[BENTER'],
];
/** Real Claude Code 2.1.296 tool-approval captures: option 1 is a plain "Yes" in every one. */
const REAL_PERMISSION = readdirSync(join(PANES, 'real-2.1.296')).filter((f) => /^perm-.*\.txt$/.test(f)).sort().map((f) => `real-2.1.296/${f}`);
const REAL_MENUS = ['real-2.1.296/askuser.txt', 'real-2.1.296/trust-folder.txt', 'real-2.1.296/external-imports.txt'];
/** Plan approvals: option 1 also switches the session's permission mode, so the tablet offers only No. */
const PLAN = readdirSync(PANES).filter((f) => /^plan-.*\.txt$/.test(f)).sort();
const TEXT = ['idle-text.txt', 'draft-numbered.txt', 'old-list.txt', 'old-list-draft.txt', 'old-list-tall-status.txt'];

/** A pane drawing one fixture; its own tmux session, killed by the caller. */
async function screen(fixture: string, then?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-ans-'));
  const result = join(dir, 'result');
  const name = testSessionName('scr-');
  const cmd = [fx('prompt-screen.sh'), result, join(PANES, fixture), ...(then ? [join(PANES, then)] : [])].map((a) => `'${a}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '40', '-s', name, cmd]);
  const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
  await wait(500);
  const session = { key: 'local:me:s1', host: 'local', account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, state: 'needs-you' } as any;
  return { result, session, name };
}
/** The keys the pane received, once it has stopped receiving them (or '' if none came). */
async function received(result: string, ms = 10000): Promise<string> {
  for (let t = 0; t < ms && !existsSync(result); t += 100) await wait(100);
  return existsSync(result) ? readFileSync(result, 'utf8') : '';
}
async function withScreen(fixture: string, run: (s: Awaited<ReturnType<typeof screen>>) => Promise<void>, then?: string) {
  const s = await screen(fixture, then);
  try { await run(s); } finally { killOwn(s.name); }
}

describe.concurrent('every pane fixture through the real answer path', () => {
  it.each(PERMISSION.flatMap((f) => [[f, 'yes', '1'], [f, 'no', 'ESC']]))('%s: %s sends %s', async (f, choice, keys) => {
    await withScreen(f, async (s) => {
      const d = deps(s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('permission');
      // Yes only where Claude's option 1 is a plain "Yes" (pane.test.ts, PLAIN_YES); spoof-wrap-blank's fake "1. No"
      // breaks that, and spoof-loose-footer's option 1 is "Red", so they are No only and their Yes sends nothing.
      const plainYes = !['spoof-wrap-blank.txt', 'spoof-loose-footer.txt'].includes(f);
      expect(r.prompt.options.map((o: any) => [o.key, o.label])).toEqual(plainYes ? [['yes', 'Yes'], ['no', 'No']] : [['no', 'No']]);
      expect(r.prompt.detail).toContain(readFileSync(join(PANES, f), 'utf8').trimEnd().split('\n').at(-1)!.trimEnd());
      if (!plainYes && choice === 'yes') {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice })).toMatchObject({ ok: false, error: 'bad_request' });
        expect(await received(s.result, 3000)).toBe('');
        return;
      }
      // Nothing but yes / no is accepted for a permission prompt, and a refusal sends nothing (the recorder sees all).
      for (const bad of ['1', '2', '3', '4', '9', 'Yes', 'esc']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad }), bad).toMatchObject({ ok: false, error: 'bad_request' });
      }
      for (const text of ['1', 'yes', 'no']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text })).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice })).toEqual({ ok: true, sent: choice === 'yes' ? 'Yes' : 'No' });
      expect(await received(s.result)).toBe(keys);
    });
  });

  it.each(REAL_PERMISSION.flatMap((f) => [[f, 'yes', '1'], [f, 'no', 'ESC']]))('%s: %s sends %s', async (f, choice, keys) => {
    await withScreen(f, async (s) => {
      const d = deps(s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('permission');
      expect(r.prompt.options.map((o: any) => [o.key, o.label])).toEqual([['yes', 'Yes'], ['no', 'No']]);
      for (const bad of ['1', '2', '3', '4', 'Yes', 'esc']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad }), bad).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'yes' })).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice })).toEqual({ ok: true, sent: choice === 'yes' ? 'Yes' : 'No' });
      expect(await received(s.result)).toBe(keys);
    });
  });

  it.each(menuKeys)('%s: option %s sends %s', async (f, choice, keys) => {
    await withScreen(f, async (s) => {
      // Claude's startup dialogs (folder trust, external imports) are answered only for a launch that is still starting.
      const d = deps(/trust|imports/.test(f) ? { ...s.session, starting: true } : s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('menu');
      for (const bad of ['yes', 'no', '7']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad })).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'hi' })).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice })).toEqual({ ok: true, sent: `option ${choice}` });
      expect(await received(s.result)).toBe(keys);
    });
  });

  it.each(TEXT)('%s: a typed reply is one bracketed paste and Enter; Yes / No and digits are refused', async (f) => {
    await withScreen(f, async (s) => {
      const d = deps(s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('text');
      for (const bad of ['yes', 'no', '1']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad })).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'go on' })).toMatchObject({ ok: true });
      expect(await received(s.result)).toBe('ESC[200~go onESC[201~ENTER');
    });
  });

  // Claude working: a reply is still typed (Claude Code queues it and the model reads it at its next pause). It goes in
  // as a bracketed paste, and Enter follows only onto the same input box (answer-race.test.ts).
  it.each(['busy.txt', 'real-2.1.296/busy.txt', 'real-2.1.296/busy-queued.txt'])('%s: Claude working: a typed reply is one bracketed paste and Enter', async (f) => {
    await withScreen(f, async (s) => {
      const d = deps(s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt).toMatchObject({ kind: 'text', busy: true });
      for (const bad of ['yes', 'no', '1']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad })).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'go on' })).toMatchObject({ ok: true });
      expect(await received(s.result)).toBe('ESC[200~go onESC[201~ENTER');
    });
  });

  // Yes types 1, which picks Claude's option 1: offered only when that option is a plain "Yes" on screen. A plan
  // approval's option 1 also switches the session to bypass, auto or accept-edits mode, so it is No only.
  it.each(PLAN.flatMap((f) => [[f, false], [f, true]] as const))('%s (pending permission reported: %s): No only; Yes sends nothing, No sends Escape', async (f, pending) => {
    await withScreen(f, async (s) => {
      const d = deps({ ...s.session, permission: pending });
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('permission');
      expect(r.prompt.options.map((o: any) => [o.key, o.label])).toEqual([['no', 'No']]);
      expect(r.prompt.detail).toContain('rm -rf ~/code/orchard-api ~/.ssh');
      for (const bad of ['yes', '1', '2', 'no; yes']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad }), bad).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'yes' })).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
      expect(await received(s.result)).toBe('ESC');
    });
  });

  it.each([false, true])('real 2.1.296 plan approval (pending permission reported: %s): No only; Yes sends nothing, No sends Escape', async (pending) => {
    await withScreen('real-2.1.296/plan-approval.txt', async (s) => {
      const d = deps({ ...s.session, permission: pending });
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('permission');
      expect(r.prompt.options.map((o: any) => [o.key, o.label])).toEqual([['no', 'No']]);
      for (const bad of ['yes', '1', '2', '3']) {
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad }), bad).toMatchObject({ ok: false, error: 'bad_request' });
      }
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
      expect(await received(s.result)).toBe('ESC');
    });
  });

  it.each([...TEXT, 'askuser.txt', 'trust-folder.txt', 'imports-dialog.txt', 'shell.txt', ...REAL_MENUS])(
    '%s with a pending permission reported by the session: No only, and it sends Escape', async (f) => {
      await withScreen(f, async (s) => {
        const d = deps({ ...s.session, permission: true });
        const r: any = await readPrompt(d, 'local:me:s1');
        expect(r.prompt.kind).toBe('permission');
        expect(r.prompt.options.map((o: any) => o.key)).toEqual(['no']);
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'go on' })).toMatchObject({ ok: false, error: 'bad_request' });
        for (const bad of ['1', 'yes']) expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: bad }), bad).toMatchObject({ ok: false, error: 'bad_request' });
        expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: 'no' })).toMatchObject({ ok: true });
        expect(await received(s.result)).toBe('ESC');
      });
    });

  // The startup dialogs are answered with arrow keys and Enter (SEND_MOVE_SCRIPT), so only for a launch the board started
  // and Claude has not registered yet: a registered session's screen shaped like one is never answered that way.
  it.each(['trust-folder.txt', 'imports-dialog.txt', 'real-2.1.296/trust-folder.txt', 'real-2.1.296/external-imports.txt'])(
    '%s in a session that is not starting: refused, and nothing is sent', async (f) => {
      await withScreen(f, async (s) => {
        const d = deps(s.session);
        expect(await readPrompt(d, 'local:me:s1')).toMatchObject({ ok: false, error: 'no_prompt' });
        const hash = parsePane(readFileSync(join(PANES, f), 'utf8')).hash;
        for (const choice of ['1', '2', 'yes', 'no']) {
          expect(await answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice }), choice).toMatchObject({ ok: false });
        }
        expect(await received(s.result, 3000)).toBe('');
      });
    });

  it('shell.txt: nothing is waiting, nothing is sent', async () => {
    await withScreen('shell.txt', async (s) => {
      const d = deps(s.session);
      expect(await readPrompt(d, 'local:me:s1')).toMatchObject({ ok: false, error: 'no_prompt' });
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: 'x', choice: 'yes' })).toMatchObject({ ok: false, error: 'no_prompt' });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  // A prompt drawn the instant the reply reaches the pane (after every check could pass): the reply reaches it only as a
  // bracketed paste, never as keystrokes (a "2" would be "Yes, and don't ask again"), and the screen read after the paste
  // is not the input box, so no Enter follows (Enter would pick the highlighted "Yes").
  it.each(['perm-bash-dashed.txt', 'real-2.1.296/perm-bash.txt', 'askuser.txt', 'real-2.1.296/askuser.txt', 'trust-folder.txt'])('%s drawn as the reply arrives: it gets one bracketed paste and no Enter', async (then) => {
    await withScreen('idle-text.txt', async (s) => {
      const d = deps(s.session);
      const r: any = await readPrompt(d, 'local:me:s1');
      expect(r.prompt.kind).toBe('text');
      expect(await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, text: 'go on' })).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect(await received(s.result)).toBe('ESC[200~go onESC[201~');
    }, then);
  });
});

describe('answer against a real tmux pane', () => {
  it('reads an older-layout permission prompt as Yes / No and sends Escape for No', async () => {
    const f = await startFixture('prompt-menu.sh');
    const d = deps(f.session);
    const r = await readPrompt(d, 'local:me:s1');
    expect(r).toMatchObject({ ok: true, prompt: { kind: 'permission', quickReplies: ['yes', 'no'] } });
    const prompt = (r as any).prompt;
    expect(prompt.options.map((o: any) => o.key)).toEqual(['yes', 'no']);
    expect(prompt.detail).toContain("2. Yes, and don't ask again for npm test commands in /home/demo/orchard-api");
    expect(await answer(d, { sessionId: 'local:me:s1', promptHash: prompt.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
    await wait(300);
    expect(readFileSync(f.result, 'utf8')).toBe('\x1b');
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
    const spy: HostExec = (h, argv, o) => { if (argv[2] !== CAPTURE_SCRIPT) setup(pane); return makeExec()(h, argv, o); };
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
    const spy: HostExec = (h, argv, o) => { if (argv[2] !== CAPTURE_SCRIPT) sent.push(argv); return makeExec()(h, argv, o); };
    const d = deps(f.session, spy);
    const r = await answer(d, { sessionId: 'local:me:s1', promptHash: 'stale-hash', choice: 'yes' });
    expect(r).toMatchObject({ ok: false, error: 'prompt_changed', prompt: { kind: 'permission' } });
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
  const SHA = 'a'.repeat(64);
  /** A host whose capture prints perm-bash.txt with hash SHA, and whose send scripts print `sendOut`. */
  const fakeExec = (calls: string[][], sendOut = 'SENT\n', screen = 'fixtures/panes/perm-bash.txt'): HostExec => async (_h, argv) => {
    calls.push(argv);
    if (argv[2] === CAPTURE_SCRIPT) return { code: 0, stdout: `OK ${SHA}\n` + readFileSync(join(import.meta.dirname, screen), 'utf8'), stderr: '' };
    return { code: 0, stdout: sendOut, stderr: '' };
  };
  const session = { key: 'k', host: 'local', pid: 5, tmux: 's:@1.%1', hostOnline: true } as any;
  const sends = (calls: string[][]) => calls.filter((c) => c[2] !== CAPTURE_SCRIPT);

  it('rejects anything but yes / no for a permission prompt, and text', async () => {
    const calls: string[][] = [];
    const d = deps(session, fakeExec(calls));
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: '1' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: 'yes; id' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, text: 'hi' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(sends(calls)).toEqual([]);
  });
  it('sends exactly the permission script with yes or no, the expected ref and pid, and the hash of the screen it parsed', async () => {
    for (const choice of ['yes', 'no']) {
      const calls: string[][] = [];
      expect(await answer(deps(session, fakeExec(calls)), { sessionId: 'k', promptHash: view.hash, choice })).toMatchObject({ ok: true });
      expect(calls.at(-1)).toEqual(['sh', '-c', SEND_PERMISSION_SCRIPT, '_', '%1', 's:@1.%1', '5', SHA, choice, '0']);
    }
  });
  it('a reply goes on stdin to the paste script, never as an argument, and Enter only to the screen read after the paste', async () => {
    const idle = 'fixtures/panes/idle-text.txt';
    const v = parsePane(readFileSync(join(import.meta.dirname, idle), 'utf8'));
    const after = readFileSync(join(import.meta.dirname, idle), 'utf8').replace('❯ ', '❯ go on');
    const calls: { argv: string[]; input?: string }[] = [];
    const exec: HostExec = async (_h, argv, o) => {
      calls.push({ argv, input: o?.input });
      if (argv[2] === CAPTURE_SCRIPT) return { code: 0, stdout: `OK ${SHA}\n${readFileSync(join(import.meta.dirname, idle), 'utf8')}`, stderr: '' };
      if (argv[2] === SEND_PASTE_SCRIPT) return { code: 0, stdout: `PASTED ${'b'.repeat(64)}\n${after}`, stderr: '' };
      return { code: 0, stdout: 'SENT\n', stderr: '' };
    };
    expect(await answer(deps(session, exec), { sessionId: 'k', promptHash: v.hash, text: 'go on; $(id)' })).toEqual({ ok: true, sent: 'reply (12 characters)' });
    const [paste, enter] = calls.filter((c) => c.argv[2] !== CAPTURE_SCRIPT);
    // The last checks compare Claude's input box and the rows under it (4 rows here), before and after the paste.
    const box = (screen: string) => { const t = inputBoxTail(screen)!; return [createHash('sha256').update(t).digest('hex'), String(t.split('\n').length)]; };
    expect(box(readFileSync(join(import.meta.dirname, idle), 'utf8'))[1]).toBe('4');
    expect(paste.argv.slice(0, 8)).toEqual(['sh', '-c', SEND_PASTE_SCRIPT, '_', '%1', 's:@1.%1', '5', box(readFileSync(join(import.meta.dirname, idle), 'utf8'))[0]]);
    expect(paste.argv[8]).toMatch(/^clayclaude-[0-9a-f]{16}$/);
    expect(paste.argv[9]).toBe('4');
    expect(paste.argv.join(' ')).not.toContain('go on');
    expect(paste.input).toBe('go on; $(id)');
    expect(enter.argv).toEqual(['sh', '-c', SEND_ENTER_SCRIPT, '_', '%1', 's:@1.%1', '5', box(after)[0], '-', box(after)[1]]);
    expect(box(after)[0]).not.toBe(box(readFileSync(join(import.meta.dirname, idle), 'utf8'))[0]);
  });
  it('no Enter when the screen after the paste is not the idle input box', async () => {
    const idle = 'fixtures/panes/idle-text.txt';
    const v = parsePane(readFileSync(join(import.meta.dirname, idle), 'utf8'));
    for (const after of ['fixtures/panes/real-2.1.296/perm-bash.txt', 'fixtures/panes/real-2.1.296/perm-bash-manual.txt', 'fixtures/panes/real-2.1.296/askuser.txt', 'fixtures/panes/real-2.1.296/trust-folder.txt', 'fixtures/panes/shell.txt']) {
      const calls: string[][] = [];
      const exec: HostExec = async (_h, argv) => {
        calls.push(argv);
        if (argv[2] === CAPTURE_SCRIPT) return { code: 0, stdout: `OK ${SHA}\n${readFileSync(join(import.meta.dirname, idle), 'utf8')}`, stderr: '' };
        return { code: 0, stdout: `PASTED ${'b'.repeat(64)}\n${readFileSync(join(import.meta.dirname, after), 'utf8')}`, stderr: '' };
      };
      expect(await answer(deps(session, exec), { sessionId: 'k', promptHash: v.hash, text: 'go on' }), after).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect(calls.filter((c) => c[2] === SEND_ENTER_SCRIPT), after).toEqual([]);
    }
  });
  it('a screen that changed under the send is read again; the same prompt is sent to, a different one is not', async () => {
    // The first send finds the screen changed (a spinner tick, a clock): read again, still the same prompt, send again.
    let n = 0;
    const calls: string[][] = [];
    const flaky = (sendOut: () => string): HostExec => async (h, argv, o) => argv[2] === CAPTURE_SCRIPT ? fakeExec(calls)(h, argv, o) : (calls.push(argv), { code: 0, stdout: sendOut(), stderr: '' });
    expect(await answer(deps(session, flaky(() => (++n === 1 ? 'ERR changed\n' : 'SENT\n'))), { sessionId: 'k', promptHash: view.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
    expect(sends(calls)).toHaveLength(2);
    // A screen that never holds still: nothing is sent, after a bounded number of tries.
    calls.length = 0;
    expect(await answer(deps(session, flaky(() => 'ERR changed\n')), { sessionId: 'k', promptHash: view.hash, choice: 'no' })).toMatchObject({ ok: false, error: 'prompt_changed' });
    expect(sends(calls)).toHaveLength(3);
    // The prompt itself changed: the re-read's hash differs, so nothing more is sent.
    let screen = 'fixtures/panes/perm-bash.txt';
    const calls2: string[][] = [];
    const swap: HostExec = async (h, argv, o) => {
      if (argv[2] === CAPTURE_SCRIPT) return fakeExec(calls2, '', screen)(h, argv, o);
      calls2.push(argv); screen = 'fixtures/panes/real-2.1.296/perm-write.txt';
      return { code: 0, stdout: 'ERR changed\n', stderr: '' };
    };
    expect(await answer(deps(session, swap), { sessionId: 'k', promptHash: view.hash, choice: 'yes' })).toMatchObject({ ok: false, error: 'prompt_changed', prompt: { kind: 'permission' } });
    expect(calls2.filter((c) => c[2] !== CAPTURE_SCRIPT)).toHaveLength(1);
  });
  it('refuses Yes, sending nothing, when Claude\'s option 1 is not a plain "Yes" (a plan approval)', async () => {
    const calls: string[][] = [];
    const exec = fakeExec(calls, 'SENT\n', 'fixtures/panes/plan-approve.txt');
    const v = parsePane(readFileSync(join(import.meta.dirname, 'fixtures/panes/plan-approve.txt'), 'utf8'));
    for (const pending of [false, true]) {
      const d = deps({ ...session, permission: pending }, exec);
      const r = await answer(d, { sessionId: 'k', promptHash: v.hash, choice: 'yes' });
      expect(r).toMatchObject({ ok: false, error: 'bad_request' });
      expect((r as any).message).toMatch(/on the PC/);
    }
    expect(sends(calls)).toEqual([]);
  });
  it('every send script checks the screen hash, in the same shell, right before its keys', () => {
    for (const sc of [SEND_PERMISSION_SCRIPT, SEND_CHOICE_SCRIPT, SEND_MOVE_SCRIPT, SEND_ENTER_SCRIPT, SEND_PASTE_SCRIPT]) {
      const lines = sc.split('\n');
      const check = lines.findIndex((l) => l.includes('= "$4" ]') && l.includes('ERR changed'));
      const firstKey = lines.findIndex((l) => /send-keys|paste-buffer/.test(l));
      expect(check, sc).toBeGreaterThan(-1);
      // Between the hash check and the first key: nothing but a case label (no tmux call, no sleep, no other command).
      expect(lines.slice(check + 1, firstKey).filter((l) => !/^\s*(case "\$5" in|esac)?\s*$/.test(l)), sc).toEqual([]);
    }
  });
  it('the permission script itself sends only 1 or Escape', () => {
    expect(SEND_PERMISSION_SCRIPT).toContain('yes) tmux send-keys -t "$pane" -l -- 1 || exit 1;;');
    expect(SEND_PERMISSION_SCRIPT).toContain('no) tmux send-keys -t "$pane" Escape || exit 1;;');
    expect(SEND_PERMISSION_SCRIPT.match(/send-keys/g)).toHaveLength(2);
    // The request's word only picks a branch; it never reaches send-keys.
    expect(SEND_PERMISSION_SCRIPT.split('\n').filter((l) => l.includes('send-keys') && l.includes('$5'))).toEqual([]);
  });
  it('reports pane_gone when the pane changed hands between the check and the send', async () => {
    expect(await answer(deps(session, fakeExec([], 'ERR moved\n')), { sessionId: 'k', promptHash: view.hash, choice: 'yes' }))
      .toMatchObject({ ok: false, error: 'pane_gone' });
  });
  it('a double tap sends the answer once, and the same prompt is not answered twice in a row', async () => {
    const calls: string[][] = [];
    const d = deps(session, fakeExec(calls));
    const both = await Promise.all([1, 2].map(() => answer(d, { sessionId: 'k', promptHash: view.hash, choice: 'yes' })));
    expect(both.map((r) => r.ok).sort()).toEqual([false, true]);
    expect(both.find((r) => !r.ok)).toMatchObject({ error: 'duplicate' });
    expect(await answer(d, { sessionId: 'k', promptHash: view.hash, choice: 'no' })).toMatchObject({ ok: false, error: 'duplicate' });
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
    const motd: HostExec = async () => ({ code: 0, stdout: `Welcome to box!\nOK not really\n\nOK ${'c'.repeat(64)}\n` + pane, stderr: '' });
    expect(await readPrompt(deps(session, motd), 'k')).toMatchObject({ ok: true, prompt: { kind: 'permission', hash: view.hash } });
    const gone: HostExec = async () => ({ code: 0, stdout: 'Welcome to box!\nERR gone\n', stderr: '' });
    expect(await readPrompt(deps(session, gone), 'k')).toMatchObject({ ok: false, error: 'pane_gone' });
  });
  it('reports the last stderr line (the actual error), not a shell warning printed before it', async () => {
    const exec: HostExec = async (_h, argv) => argv[2] === CAPTURE_SCRIPT
      ? { code: 0, stdout: `OK ${SHA}\n` + readFileSync(join(import.meta.dirname, 'fixtures/panes/perm-bash.txt'), 'utf8'), stderr: '' }
      : { code: 1, stdout: '', stderr: 'bash: warning: setlocale: LC_ALL: cannot change locale (en_US.UTF-8)\nno server running on /tmp/tmux-1000/default\n' };
    expect(await answer(deps(session, exec), { sessionId: 'k', promptHash: view.hash, choice: 'yes' }))
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

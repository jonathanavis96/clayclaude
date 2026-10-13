import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec, type HostExec } from '../src/actions/exec.js';
import { CAPTURE_SCRIPT, SEND_PASTE_SCRIPT, SendGuard, answer, readPrompt, type AnswerDeps } from '../src/actions/answer.js';
import { killOwn, testSessionName } from './helpers/tmux.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

/*
 * The answer race (TOCTOU): the screen is checked, then keys are sent. A permission prompt that appears in between (the
 * model's next tool call reaching Claude) must never receive the keys meant for the screen that was checked: a typed
 * "2 please" landing on it as keystrokes is "Yes, and don't ask again". Each test draws a screen in a tmux pane of our
 * own (the suite's private tmux server, test/setup/safety.ts), replaces it with a permission prompt at a chosen moment,
 * and records every byte that reached the pane and which screen it reached (fixtures/race-screen.sh).
 */

const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x}]`);
const PANES = join(import.meta.dirname, 'fixtures', 'panes');
const STUB = join(import.meta.dirname, 'fixtures', 'race-screen.sh');
const PERM = 'real-2.1.296/perm-bash.txt';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keeper = testSessionName('race-keep-');
beforeAll(() => { execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']); });
afterAll(() => killOwn(keeper));

/**
 * When the second screen appears: after the n-th capture (1 = readPrompt's, 2 = answer's own re-read) has returned, or
 * just before the first send reaches the host (an ssh round trip, or a slow host). null: never.
 */
type Flip = { afterCapture: number } | { beforeSend: true } | { afterSend: number } | null;

/**
 * `spin`: the row of the first screen redrawn every 50 ms as Claude's spinner while it works (race-screen.sh), so the
 * screen never holds still. `width`: the pane's columns (the real 2.1.296 busy captures are 120 wide).
 */
async function race(o: { first: string; then?: string; flip: Flip; host?: 'local' | 'box'; session?: object; spin?: number; width?: number },
  act: (d: AnswerDeps, hash: string) => Promise<unknown>): Promise<{ res: any; keys: string[]; read: any }> {
  const dir = mkdtempSync(join(tmpdir(), 'cc-race-'));
  const log = join(dir, 'log'), flag = join(dir, 'flag');
  const name = testSessionName('race-');
  const cmd = [STUB, log, join(PANES, o.first), flag, join(PANES, o.then ?? PERM), ...(o.spin ? [String(o.spin)] : [])].map((a) => `'${a}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-x', String(o.width ?? 100), '-y', '40', '-s', name, cmd]);
  try {
    const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
    await wait(500);
    const session = { key: 'local:me:s1', host: o.host ?? 'local', account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, state: 'needs-you', ...o.session };
    const base = o.host === 'box' ? makeExec({ sshBin: makeFakeSsh().bin }) : makeExec();
    let captures = 0, sends = 0;
    const flipNow = async () => { if (!existsSync(flag)) { writeFileSync(flag, ''); await wait(300); } };
    const exec: HostExec = async (h, argv, opt) => {
      const isCapture = argv[2] === CAPTURE_SCRIPT;
      if (!isCapture && ++sends === 1 && o.flip && 'beforeSend' in o.flip) await flipNow();
      const r = await base(h, argv, opt);
      if (!isCapture && o.flip && 'afterSend' in o.flip && sends === o.flip.afterSend) await flipNow();
      if (isCapture && ++captures === (o.flip && 'afterCapture' in o.flip ? o.flip.afterCapture : -1)) await flipNow();
      return r;
    };
    const d: AnswerDeps = { cfg, sessions: () => [session as any], exec, quickReplies: () => [], guard: new SendGuard() };
    const read: any = await readPrompt(d, 'local:me:s1');
    const res = await act(d, read.ok ? read.prompt.hash : 'none');
    // Every key that is coming has come once the log has not grown for 700 ms (the stub logs one byte at a time).
    const size = () => (existsSync(log) ? readFileSync(log, 'utf8').length : 0);
    for (let last = -1, still = 0, t = 0; still < 700 && t < 6000; t += 100) { await wait(100); const n = size(); still = n === last ? still + 100 : 0; last = n; }
    const keys = existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
    return { res, keys, read };
  } finally { killOwn(name); }
}
const typed = (keys: string[], screen: 'B' | 'P') => keys.filter((k) => k.startsWith(`${screen}:`)).map((k) => k.slice(2)).join('');

describe.concurrent('the answer race: a permission prompt appearing between the check and the keys', () => {
  it('control: a reply to an idle input box arrives as one bracketed paste, then Enter', async () => {
    const r = await race({ first: 'idle-text.txt', flip: null }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: true });
    expect(r.keys.every((k) => k.startsWith('B:'))).toBe(true);
    expect(typed(r.keys, 'B')).toBe('ESC[200~2 pleaseESC[201~ENTER');
  });

  it.each(['local', 'box'] as const)('a prompt drawn after the last capture never receives the reply (%s)', async (host) => {
    const r = await race({ first: 'idle-text.txt', flip: { afterCapture: 2 }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  it.each(['local', 'box'] as const)('a prompt drawn while the send is on its way never receives the reply (%s)', async (host) => {
    const r = await race({ first: 'idle-text.txt', flip: { beforeSend: true }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  it.each(['local', 'box'] as const)('an AskUserQuestion choice never lands on a permission prompt drawn after the check (%s)', async (host) => {
    const r = await race({ first: 'real-2.1.296/askuser.txt', flip: { beforeSend: true }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice: '2' }));
    expect(r.read.prompt.kind).toBe('menu');
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  it.each(['local', 'box'] as const)('Yes on one permission prompt never approves the next one drawn after the check (%s)', async (host) => {
    const r = await race({ first: PERM, then: 'real-2.1.296/perm-write.txt', flip: { beforeSend: true }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice: 'yes' }));
    expect(r.read.prompt.kind).toBe('permission');
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  // Claude working: a reply typed then is queued by Claude Code and read by the model at its next pause (Jonathan,
  // 2026-10-13: the tablet keeps that). Its spinner redraws the screen every frame, so the last check covers Claude's
  // input box and the rows under it (answer.ts, inputBoxTail): a permission prompt replaces the input box.
  const BUSY = { first: 'real-2.1.296/busy.txt', spin: 32, width: 120 };
  it('a reply while Claude works (its spinner redrawn every 50 ms) is one bracketed paste, then Enter: Claude queues it', async () => {
    const r = await race({ ...BUSY, flip: null }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.read.prompt).toMatchObject({ kind: 'text', busy: true });
    expect(r.res).toMatchObject({ ok: true });
    expect(r.keys.every((k) => k.startsWith('B:'))).toBe(true);
    expect(typed(r.keys, 'B')).toBe('ESC[200~2 pleaseESC[201~ENTER');
  });

  it('a reply while Claude Code reports the session busy (its registry) is sent the same way', async () => {
    const r = await race({ first: 'idle-text.txt', flip: null, session: { busy: true } }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: true });
    expect(typed(r.keys, 'B')).toBe('ESC[200~2 pleaseESC[201~ENTER');
  });

  it.each([
    ['local', { afterCapture: 2 }], ['box', { afterCapture: 2 }], ['local', { beforeSend: true }], ['box', { beforeSend: true }],
  ] as const)('Claude working: a permission prompt drawn after the last check never receives the reply (%s, %o)', async (host, flip) => {
    const r = await race({ ...BUSY, flip, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  it.each(['local', 'box'] as const)('Claude working: a permission prompt drawn after the paste, before Enter, gets no Enter (%s)', async (host) => {
    const r = await race({ ...BUSY, flip: { afterSend: 1 }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: false, error: 'prompt_changed' });
    expect(typed(r.keys, 'B')).toBe('ESC[200~2 pleaseESC[201~');
    expect(typed(r.keys, 'P')).toBe('');
  });

  it.each(['local', 'box'] as const)('idle: a permission prompt drawn after the paste, before Enter, gets no Enter (%s)', async (host) => {
    const r = await race({ first: 'idle-text.txt', flip: { afterSend: 1 }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, text: '2 please' }));
    expect(r.res).toMatchObject({ ok: false, error: 'prompt_changed' });
    expect(typed(r.keys, 'B')).toBe('ESC[200~2 pleaseESC[201~');
    expect(typed(r.keys, 'P')).toBe('');
  });

  // Claude's startup dialogs (folder trust, external imports): the cursor is moved, then Enter is pressed by a second
  // host-side script whose last check is the screen read after the move (answer.ts, SEND_MOVE_SCRIPT, confirmMove).
  const TRUST = { first: 'real-2.1.296/trust-folder.txt', session: { starting: true } };
  it('control: a starting launch\'s trust question gets the move, then Enter', async () => {
    const r = await race({ ...TRUST, flip: null }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice: '2' }));
    expect(r.res).toEqual({ ok: true, sent: 'option 2' });
    expect(typed(r.keys, 'B')).toBe('ESC[BENTER');
  });

  it.each([['local', '2'], ['box', '2'], ['local', '1'], ['box', '1']] as const)(
    'a prompt drawn after the cursor moved, before Enter, gets no Enter (%s, option %s)', async (host, choice) => {
      const r = await race({ ...TRUST, flip: { afterSend: 1 }, host }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice }));
      expect(r.res).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect(typed(r.keys, 'B')).toBe(choice === '2' ? 'ESC[B' : '');
      expect(typed(r.keys, 'P')).toBe('');
    });

  it('a session that is not starting never gets the move or the Enter, whatever its screen', async () => {
    const r = await race({ first: 'real-2.1.296/trust-folder.txt', flip: null }, (d, hash) => answer(d, { sessionId: 'local:me:s1', promptHash: hash, choice: '2' }));
    expect(r.res).toMatchObject({ ok: false });
    expect(r.keys).toEqual([]);
  });

  // Layer 3, the gap no check can close (between the script's last capture and its paste): a reply that reaches a
  // permission prompt arrives as one bracketed paste, never as a keystroke. A real 2.1.296 Select menu ignores a paste
  // ("2 please", "2", "1": fixtures/panes/real-2.1.296/menu-captures.md); the keystroke "4" picks option 4.
  it('a reply that reaches a permission prompt anyway arrives as a bracketed paste, never as keystrokes, and no Enter follows', async () => {
    const r = await race({ first: PERM, flip: null }, async (d) => {
      const s = d.sessions()[0];
      const ref = s.tmux!.split(':');
      const cap = await d.exec(cfg.hosts[0], ['sh', '-c', CAPTURE_SCRIPT, '_', ref[1].split('.')[1], s.tmux!, String(s.pid)], {});
      const sha = /^OK ([0-9a-f]{64})$/m.exec(cap.stdout)![1];
      return d.exec(cfg.hosts[0], ['sh', '-c', SEND_PASTE_SCRIPT, '_', ref[1].split('.')[1], s.tmux!, String(s.pid), sha, 'clayclaude-0123456789abcdef', '0'], { input: '2' });
    });
    expect(r.res.stdout).toMatch(/^PASTED [0-9a-f]{64}$/m);
    expect(typed(r.keys, 'B')).toBe('ESC[200~2ESC[201~');
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec, type HostExec } from '../src/actions/exec.js';
import { CAPTURE_SCRIPT, SendGuard, type AnswerDeps } from '../src/actions/answer.js';
import { idleGate, message } from '../src/actions/message.js';
import { deriveSession } from '../src/core/status.js';
import { killOwn, testSessionName } from './helpers/tmux.js';

/*
 * Task 43: a new message to an idle session. Keys are typed only when all three hold (the idle gate, shared with Task
 * 42): Claude Code itself reports the session idle and waiting for a new prompt (Session.idle, from its hooks or its
 * registry; never with a permission pending, never needs-you, working or starting); the pane, captured just before
 * sending, shows Claude's empty idle input box at the bottom and nothing under it; and the answer path's pane identity
 * checks pass. The text then goes in as one bracketed paste through the atomic check-and-send script, then Enter.
 * Every pane here is a stub in a tmux session of our own on the suite's private server (test/setup/safety.ts).
 */

const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x}]`);
const FX = join(import.meta.dirname, 'fixtures');
const PANES = join(FX, 'panes');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = 'local:me:s1';

const keeper = testSessionName('msg-keep-');
let keeperPid = 0;
beforeAll(() => {
  execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']);
  keeperPid = Number(execFileSync('tmux', ['display-message', '-p', '-t', `=${keeper}:`, '#{pane_pid}'], { encoding: 'utf8' }).trim());
});
afterAll(() => killOwn(keeper));

/** An idle session as the collector reports it: asleep, and Claude Code says it waits for a new prompt. */
const IDLE = { state: 'asleep', idle: true } as const;

/** A pane drawing one fixture and recording every key that reaches it (prompt-screen.sh); its own tmux session. */
async function screen(fixture: string, session: object = IDLE) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-msg-'));
  const result = join(dir, 'result');
  const name = testSessionName('msg-');
  const cmd = [join(FX, 'prompt-screen.sh'), result, join(PANES, fixture)].map((a) => `'${a}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '40', '-s', name, cmd]);
  const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
  await wait(500);
  const s = { key: ID, host: 'local', account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, live: true, ...session } as any;
  return { result, session: s, name, win, pane };
}
async function received(result: string, ms = 10000): Promise<string> {
  for (let t = 0; t < ms && !existsSync(result); t += 100) await wait(100);
  return existsSync(result) ? readFileSync(result, 'utf8') : '';
}
const deps = (session: any, exec: HostExec = makeExec(), guard = new SendGuard()): AnswerDeps =>
  ({ cfg, sessions: () => [session], exec, quickReplies: () => [], guard });
async function withScreen(fixture: string, session: object, run: (s: Awaited<ReturnType<typeof screen>>) => Promise<void>) {
  const s = await screen(fixture, session);
  try { await run(s); } finally { killOwn(s.name); }
}

describe('the idle gate, condition 1: what Claude Code reports', () => {
  const base = { key: ID, host: 'local', account: 'me', sessionId: 's1', pid: 1, tmux: 'x:@1.%1', hostOnline: true, live: true, state: 'asleep', idle: true } as any;
  it('passes only an asleep session Claude Code reports idle, with no permission pending', () => {
    expect(idleGate(base)).toBeNull();
    for (const over of [{ idle: undefined }, { permission: true }, { busy: true }, { starting: true }, { state: 'needs-you' }, { state: 'working' },
      { state: 'compacting' }, { state: 'limit' }, { state: 'stopped' }, { live: false }, { hostOnline: false }, { tmux: undefined }]) {
      expect(idleGate({ ...base, ...over }), JSON.stringify(over)).toEqual(expect.stringContaining('Nothing was sent'));
    }
  });
});

describe.concurrent('a message to an idle session', () => {
  it.each(['idle-text.txt', 'old-list.txt', 'old-list-tall-status.txt'])('%s, idle: the text is pasted literally, then Enter', async (f) => {
    await withScreen(f, IDLE, async (s) => {
      const text = `fix it: $(echo pwned) 'a' "b" ; \\ & | > < * ? # ~ \`x\` café`;
      expect(await message(deps(s.session), { sessionId: ID, text })).toEqual({ ok: true, sent: `message (${text.length} characters)` });
      expect(await received(s.result)).toBe(`ESC[200~${text}ESC[201~ENTER`);
    });
  });

  it('refuses empty, over-long and control-character text before touching the pane', async () => {
    await withScreen('idle-text.txt', IDLE, async (s) => {
      const d = deps(s.session);
      expect(await message(d, { sessionId: ID, text: '   ' })).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await message(d, { sessionId: ID, text: 'x'.repeat(4001) })).toMatchObject({ ok: false, error: 'too_long' });
      expect(await message(d, { sessionId: ID, text: 'a\u001b[201~b' })).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it('a pending permission from the hooks (a Notification after the Stop) is refused, though the screen shows an idle box', async () => {
    // The session as the collector derives it from Claude Code's own hook events: a permission note after its last Stop.
    const now = Date.now();
    const derived = deriveSession({
      host: 'local', account: 'me', usageExhausted: false, cacheTtlMinutes: 60, contextWindows: { default: 200000 }, hostOnline: true, lastSeen: now,
      events: [{ event: 'Stop', sessionId: 's1', ts: now - 60_000 }, { event: 'Notification', sessionId: 's1', ts: now - 1000, message: 'Claude needs your permission to use Bash' }],
      reg: { file: '1.json', mtimeMs: now, live: true, transcript: [], data: { pid: 1, sessionId: 's1', cwd: '/w', startedAt: now - 3600_000, status: 'idle' } },
    }, now)!;
    expect(derived).toMatchObject({ state: 'needs-you', permission: true });
    expect(derived.idle).toBeUndefined();
    await withScreen('idle-text.txt', {}, async (s) => {
      const session = { ...derived, key: ID, pid: s.session.pid, tmux: s.session.tmux };
      const r = await message(deps(session), { sessionId: ID, text: 'go on' });
      expect(r).toMatchObject({ ok: false, error: 'no_prompt' });
      expect((r as any).message).toMatch(/Nothing was sent/);
      // Even a record that claims idle is refused while a permission is reported pending.
      expect(await message(deps({ ...session, state: 'asleep', idle: true }), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it.each([['working', { state: 'working', busy: true }], ['working, not reported busy', { state: 'working' }], ['starting', { state: 'working', starting: true }],
    ['needs you', { state: 'needs-you' }], ['compacting', { state: 'compacting', busy: true }], ['not reported idle', { state: 'asleep' }], ['stopped', { state: 'stopped', live: false }]] as const)(
    '%s: refused, nothing sent', async (_label, over) => {
      await withScreen('idle-text.txt', over, async (s) => {
        expect(await message(deps(s.session), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false });
        expect(await received(s.result, 3000)).toBe('');
      });
    });

  it.each(['perm-bash.txt', 'real-2.1.296/perm-bash.txt', 'real-2.1.296/plan-approval.txt', 'askuser.txt', 'real-2.1.296/askuser.txt',
    'trust-folder.txt', 'spoof-input-box.txt', 'shell.txt'])('%s on screen of a session reported idle: refused, nothing sent', async (f) => {
    await withScreen(f, IDLE, async (s) => {
      const r = await message(deps(s.session), { sessionId: ID, text: 'go on' });
      expect(r).toMatchObject({ ok: false, error: 'no_prompt' });
      expect((r as any).message).toMatch(/Nothing was sent/);
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it.each(['busy.txt', 'real-2.1.296/busy.txt', 'real-2.1.296/busy-later.txt', 'real-2.1.296/busy-queued.txt', 'real-2.1.296/busy-draft.txt', 'draft-numbered.txt', 'old-list-draft.txt'])(
    '%s (Claude working on screen, or a draft in the box) of a session reported idle: refused, nothing sent', async (f) => {
      await withScreen(f, IDLE, async (s) => {
        expect(await message(deps(s.session), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'no_prompt' });
        expect(await received(s.result, 3000)).toBe('');
      });
    });

  it('pane identity: another process, another window, copy mode or synchronize-panes: refused, nothing sent', async () => {
    await withScreen('idle-text.txt', IDLE, async (s) => {
      expect(await message(deps({ ...s.session, pid: keeperPid }), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'pane_gone' });
      expect(await message(deps({ ...s.session, tmux: `${s.name}:@999.${s.pane}` }), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'pane_gone' });
      expect(await message(deps({ ...s.session, tmux: `${s.name}:${s.win}.%99999` }), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'pane_gone' });
      execFileSync('tmux', ['set-window-option', '-t', s.pane, 'synchronize-panes', 'on']);
      expect(await message(deps(s.session), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'no_prompt', message: expect.stringContaining('synchronize-panes') });
      execFileSync('tmux', ['set-window-option', '-t', s.pane, 'synchronize-panes', 'off']);
      execFileSync('tmux', ['copy-mode', '-t', s.pane]);
      expect(await message(deps(s.session), { sessionId: ID, text: 'go on' })).toMatchObject({ ok: false, error: 'no_prompt', message: expect.stringContaining('copy mode') });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it('a second message within a few seconds, or one while another is being sent, is refused', async () => {
    await withScreen('idle-text.txt', IDLE, async (s) => {
      const guard = new SendGuard();
      const d = deps(s.session, makeExec(), guard);
      const [a, b] = await Promise.all([message(d, { sessionId: ID, text: 'one' }), message(d, { sessionId: ID, text: 'two' })]);
      expect([a.ok, b.ok].sort()).toEqual([false, true]);
      expect((a.ok ? b : a)).toMatchObject({ error: 'duplicate' });
      expect(await message(d, { sessionId: ID, text: 'three' })).toMatchObject({ ok: false, error: 'duplicate' });
      expect(await received(s.result)).toMatch(/^ESC\[200~(one|two)ESC\[201~ENTER$/);
    });
  });
});

/**
 * A stale capture: the screen changes after the capture the gate parsed and before the send script runs. The send
 * script compares the whole screen (in the same invocation as the paste), so nothing reaches the pane, whatever the new
 * screen is (race-screen.sh logs every byte that arrives).
 */
describe.concurrent('a message whose capture is stale', () => {
  it.each(['real-2.1.296/perm-bash.txt', 'askuser.txt', 'old-list.txt', 'busy.txt'])('the screen becomes %s after the capture: refused, nothing sent', async (then) => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-msg-race-'));
    const log = join(dir, 'log'), flag = join(dir, 'flag');
    const name = testSessionName('msg-race-');
    const cmd = [join(FX, 'race-screen.sh'), log, join(PANES, 'idle-text.txt'), flag, join(PANES, then)].map((a) => `'${a}'`).join(' ');
    execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '40', '-s', name, cmd]);
    try {
      const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
      await wait(500);
      const session = { key: ID, host: 'local', account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, live: true, ...IDLE } as any;
      const base = makeExec();
      const exec: HostExec = async (h, argv, opt) => {
        const r = await base(h, argv, opt);
        if (argv[2] === CAPTURE_SCRIPT && !existsSync(flag)) { writeFileSync(flag, ''); await wait(400); }
        return r;
      };
      const r = await message(deps(session, exec), { sessionId: ID, text: 'go on' });
      expect(r).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect((r as any).message).toMatch(/Nothing was sent/);
      await wait(1000);
      expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
    } finally { killOwn(name); }
  });
});

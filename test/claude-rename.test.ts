import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec } from '../src/actions/exec.js';
import { createActionService } from '../src/actions/service.js';
import { emptyIdleBox, parsePane } from '../src/actions/pane.js';
import { claudeRenameCommand } from '../src/actions/message.js';
import { deriveSession } from '../src/core/status.js';
import { NicknameStore } from '../src/nicknames.js';
import { killOwn, testSessionName } from './helpers/tmux.js';

/*
 * Task 42: the rename sheet's "Also rename in Claude Code" tick (off by default). Claude Code 2.1.296 renames a
 * running session with its /rename command (`/rename <name>`; real captures in fixtures/panes/real-2.1.296). It is
 * typed only under the idle gate shared with Task 43 (message.ts): Claude Code reports the session idle, the pane shows
 * Claude's empty idle input box, the pane identity checks pass. It goes in as one bracketed paste through the answer
 * path's atomic check-and-send script, then Enter, only while the screen after the paste shows the command as the draft
 * and nothing new above the box (a suggestion menu Claude draws as the text arrives would take the Enter).
 * Every pane here is a stub (idle-claude.sh) in a tmux session of our own on the suite's private server.
 */

const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x}]`);
const FX = join(import.meta.dirname, 'fixtures');
const PANES = join(FX, 'panes');
const REAL = join(PANES, 'real-2.1.296');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ID = 'local:me:s1';
const IDLE = { state: 'asleep', idle: true } as const;
const real = (f: string) => readFileSync(join(REAL, f), 'utf8');

const keeper = testSessionName('crn-keep-');
let keeperPid = 0;
beforeAll(() => {
  execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']);
  keeperPid = Number(execFileSync('tmux', ['display-message', '-p', '-t', `=${keeper}:`, '#{pane_pid}'], { encoding: 'utf8' }).trim());
});
afterAll(() => killOwn(keeper));

/** A stub pane drawing one fixture, recording every key that reaches it; then (with `after`) that fixture after a paste. */
async function stub(fixture: string, session: object = IDLE, after?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-crn-'));
  const result = join(dir, 'result');
  const name = testSessionName('crn-');
  const cmd = [join(FX, 'idle-claude.sh'), result, join(PANES, fixture), ...(after ? [join(PANES, after)] : [])].map((a) => `'${a}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '40', '-n', 'before', '-s', name, cmd]);
  const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
  await wait(500);
  const s = { key: ID, host: 'local', account: 'me', sessionId: 's1', name: 'own-name', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, live: true, ...session } as any;
  return { result, session: s, name, win, pane };
}
async function received(result: string, ms = 10000): Promise<string> {
  for (let t = 0; t < ms && !existsSync(result); t += 100) await wait(100);
  return existsSync(result) ? readFileSync(result, 'utf8') : '';
}
function service(session: any) {
  const names = new NicknameStore(null);
  return { names, svc: createActionService({ cfg, sessions: () => [session], probe: async () => ({}), exec: makeExec(), names }) };
}
async function withStub(fixture: string, session: object, run: (s: Awaited<ReturnType<typeof stub>>) => Promise<void>, after?: string) {
  const s = await stub(fixture, session, after);
  try { await run(s); } finally { killOwn(s.name); }
}
const windowName = (win: string) => execFileSync('tmux', ['display-message', '-p', '-t', win, '#{window_name}'], { encoding: 'utf8' }).trim();

describe('Claude\'s input box with the session\'s name on its top rule (real 2.1.296 captures)', () => {
  // A named session (`claude --name`, or after /rename) draws its name at the right of the box's top rule; in a narrow
  // pane the rule is cut to one dash, or the name to an ellipsis with no dash before it.
  it.each(['named-idle.txt', 'named-idle-44.txt', 'named-idle-30.txt'])('%s is Claude\'s empty idle input box', (f) => {
    expect(parsePane(real(f))).toMatchObject({ kind: 'text' });
    expect(emptyIdleBox(real(f))).toBe(true);
  });
  it('the pasted command is a draft, not an empty box; the slash-command suggestions are not an empty box', () => {
    for (const f of ['rename-pasted.txt', 'slash-suggest.txt']) expect(emptyIdleBox(real(f)), f).toBe(false);
  });
  it('a fresh session\'s placeholder hint ("Try …") is not read as an empty box (it cannot be told from typed text)', () => {
    expect(emptyIdleBox(real('fresh-placeholder.txt'))).toBe(false);
  });
});

describe('the /rename command', () => {
  it('is "/rename " and the name, as Claude Code takes it', () => {
    expect(claudeRenameCommand('api work')).toBe('/rename api work');
  });
});

describe.concurrent('Also rename in Claude Code', () => {
  it.each(['idle-text.txt', 'real-2.1.296/named-idle.txt'])('%s, idle: /rename and the name, pasted literally, then Enter; the board name too', async (f) => {
    await withStub(f, IDLE, async (s) => {
      const { svc, names } = service(s.session);
      const name = `a "b" $(x) ; café #1 \\ end`;
      const r = await svc.rename(ID, name, { claude: true });
      expect(r).toMatchObject({ ok: true, name });
      expect((r as any).message).toMatch(/Claude Code/);
      expect(await received(s.result)).toBe(`ESC[200~/rename ${name}ESC[201~ENTER`);
      expect(names.get(ID)).toBe(name);
    });
  });

  it('off (the default): nothing reaches the pane', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      const { svc, names } = service(s.session);
      expect(await svc.rename(ID, 'board only', {})).toMatchObject({ ok: true });
      expect(await svc.rename(ID, 'board again')).toMatchObject({ ok: true });
      expect(await svc.rename(ID, 'tmux only', { tmux: true, claude: false })).toMatchObject({ ok: true });
      expect(await received(s.result, 3000)).toBe('');
      expect(names.get(ID)).toBe('tmux only');
    });
  });

  it('with both ticks: the tmux window and Claude Code both take the name', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      const { svc } = service(s.session);
      const r = await svc.rename(ID, 'both ways', { tmux: true, claude: true });
      expect(r).toMatchObject({ ok: true, name: 'both ways' });
      expect(await received(s.result)).toBe('ESC[200~/rename both waysESC[201~ENTER');
      expect(windowName(s.win)).toBe('both ways');
    });
  });

  it('Reset, or the session\'s own name: nothing is typed (Claude Code already has its own name)', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      const { svc } = service(s.session);
      expect(await svc.rename(ID, null, { claude: true })).toMatchObject({ ok: true, name: 'own-name' });
      expect(await svc.rename(ID, 'own-name', { claude: true })).toMatchObject({ ok: true, name: 'own-name' });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it('a bad name is refused before anything reaches the pane', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      const { svc } = service(s.session);
      for (const bad of ['', '   ', 'x'.repeat(41), 'a‮b']) expect(await svc.rename(ID, bad, { claude: true }), bad).toMatchObject({ ok: false, error: 'bad_request' });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it.each([['working', { state: 'working', busy: true }], ['starting', { state: 'working', starting: true }], ['needs you', { state: 'needs-you' }],
    ['permission pending', { state: 'asleep', idle: true, permission: true }], ['not reported idle', { state: 'asleep' }], ['compacting', { state: 'compacting' }]] as const)(
    '%s: refused, nothing sent, the board name unchanged', async (_l, over) => {
      await withStub('idle-text.txt', over, async (s) => {
        const { svc, names } = service(s.session);
        const r = await svc.rename(ID, 'new name', { claude: true, tmux: true });
        expect(r).toMatchObject({ ok: false, error: 'no_prompt' });
        expect((r as any).message).toMatch(/Nothing was sent|nothing was renamed/i);
        expect(names.get(ID)).toBeUndefined();
        expect(windowName(s.win)).toBe('before');
        expect(await received(s.result, 3000)).toBe('');
      });
    });

  it('a permission note from the hooks after the Stop: refused, though the screen shows an idle box', async () => {
    const now = Date.now();
    const derived = deriveSession({
      host: 'local', account: 'me', usageExhausted: false, cacheTtlMinutes: 60, contextWindows: { default: 200000 }, hostOnline: true, lastSeen: now,
      events: [{ event: 'Stop', sessionId: 's1', ts: now - 60_000 }, { event: 'Notification', sessionId: 's1', ts: now - 1000, message: 'Claude needs your permission to use Bash' }],
      reg: { file: '1.json', mtimeMs: now, live: true, transcript: [], data: { pid: 1, sessionId: 's1', cwd: '/w', startedAt: now - 3600_000, status: 'idle' } },
    }, now)!;
    await withStub('idle-text.txt', {}, async (s) => {
      const { svc, names } = service({ ...derived, key: ID, pid: s.session.pid, tmux: s.session.tmux });
      expect(await svc.rename(ID, 'new name', { claude: true })).toMatchObject({ ok: false, error: 'no_prompt' });
      expect(names.get(ID)).toBeUndefined();
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it.each(['real-2.1.296/perm-bash.txt', 'real-2.1.296/askuser.txt', 'real-2.1.296/busy.txt', 'real-2.1.296/busy-draft.txt', 'real-2.1.296/rename-pasted.txt',
    'real-2.1.296/slash-suggest.txt', 'real-2.1.296/fresh-placeholder.txt', 'trust-folder.txt', 'shell.txt'])(
    '%s on screen of a session reported idle: refused, nothing sent, the board name unchanged', async (f) => {
      await withStub(f, IDLE, async (s) => {
        const { svc, names } = service(s.session);
        const r = await svc.rename(ID, 'new name', { claude: true });
        expect(r).toMatchObject({ ok: false, error: 'no_prompt' });
        expect((r as any).message).toMatch(/Nothing was sent/);
        expect(names.get(ID)).toBeUndefined();
        expect(await received(s.result, 3000)).toBe('');
      });
    });

  it('the pane is not the session\'s (another process, another window, copy mode): refused, nothing sent', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      expect(await service({ ...s.session, pid: keeperPid }).svc.rename(ID, 'x', { claude: true })).toMatchObject({ ok: false, error: 'pane_gone' });
      expect(await service({ ...s.session, tmux: `${s.name}:@999.${s.pane}` }).svc.rename(ID, 'x', { claude: true })).toMatchObject({ ok: false });
      execFileSync('tmux', ['copy-mode', '-t', s.pane]);
      expect(await service(s.session).svc.rename(ID, 'x', { claude: true })).toMatchObject({ ok: false, error: 'no_prompt', message: expect.stringContaining('copy mode') });
      expect(await received(s.result, 3000)).toBe('');
    });
  });

  it('a menu drawn above the box as the text arrives (slash-command suggestions): no Enter, and the board name unchanged', async () => {
    await withStub('real-2.1.296/named-idle.txt', IDLE, async (s) => {
      const { svc, names } = service(s.session);
      const r = await svc.rename(ID, 'new name', { claude: true });
      expect(r).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect((r as any).message).toMatch(/Enter was not pressed/);
      expect(names.get(ID)).toBeUndefined();
      expect(await received(s.result)).toBe('ESC[200~/rename new nameESC[201~');
    }, 'real-2.1.296/slash-suggest.txt');
  });

  it('a draft that is not the command after the paste: no Enter', async () => {
    await withStub('idle-text.txt', IDLE, async (s) => {
      const r = await service(s.session).svc.rename(ID, 'new name', { claude: true });
      expect(r).toMatchObject({ ok: false, error: 'prompt_changed' });
      expect(await received(s.result)).toBe('ESC[200~/rename new nameESC[201~');
    }, 'real-2.1.296/rename-pasted.txt');   // the screen shows "/rename t42 probe one", not "/rename new name"
  });
});

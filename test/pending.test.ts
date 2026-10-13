import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec, type HostExec } from '../src/actions/exec.js';
import { SendGuard, answer, readPrompt, type AnswerDeps } from '../src/actions/answer.js';
import { PENDING_MAX_MS, PendingLaunches } from '../src/actions/pending.js';
import { createActionService } from '../src/actions/service.js';
import { Collector } from '../src/collector.js';
import type { Session } from '../src/types.js';
import { killOwn, testSessionName } from './helpers/tmux.js';

/** A capture's status line carries the screen's SHA-256 (answer.ts, CAPTURE_SCRIPT). */
const SHA = '0'.repeat(64);

// Task 40: a session started with + New in a folder the account never trusted stops at Claude's trust question
// before it writes its registry file. The daemon shows the launch as a pending row and lets the tablet answer it.

const NOW = Date.parse('2026-10-13T12:00:00Z');
const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
  - {id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w}`);
const fx = (n: string) => join(import.meta.dirname, 'fixtures', n);
const TRUST = readFileSync(fx('panes/trust-folder.txt'), 'utf8');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const launch = (over: object = {}) => ({ host: 'local', account: 'me', target: 'work:@3.%7', pid: 4242, cwd: '/home/demo/code/harbor-notes', name: 'harbor-notes', ...over });

/** A fake exec that answers the capture script with `screen`, and records every argv. */
function fakeExec(screen: () => string) {
  const calls: string[][] = [];
  const exec: HostExec = async (_h, argv) => { calls.push(argv); return { code: 0, stdout: screen(), stderr: '' }; };
  return { exec, calls };
}

describe('PendingLaunches', () => {
  it('shows a launch as a starting row named after the folder until something else is known', () => {
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n`).exec, now: () => NOW });
    p.add(launch());
    const [s] = p.sessions();
    expect(s).toMatchObject({ host: 'local', account: 'me', name: 'harbor-notes', cwd: '/home/demo/code/harbor-notes', tmux: 'work:@3.%7', pid: 4242,
      state: 'working', starting: true, live: true, hostOnline: true, stateSince: NOW, overContext: false });
    expect(s.key.startsWith('local:me:')).toBe(true);
    expect(s.currentAction).toMatch(/starting/i);
  });

  it('turns the row into NEEDS YOU with the dialog\'s question while the pane shows the trust question, and back when it goes', async () => {
    let screen = `OK ${SHA}\n${TRUST}`;
    let t = NOW;
    const f = fakeExec(() => screen);
    const p = new PendingLaunches({ cfg, exec: f.exec, now: () => t });
    p.add(launch());
    t += 2000;
    await p.refresh([]);
    expect(p.sessions()[0]).toMatchObject({ state: 'needs-you', starting: true, question: 'Is this a project you created or one you trust?', stateSince: NOW + 2000 });
    // It read the launched pane with the capture script, checking the pane id, its window and the recorded pid.
    expect(f.calls[0].slice(0, 2)).toEqual(['sh', '-c']);
    expect(f.calls[0].slice(-3)).toEqual(['%7', 'work:@3.%7', '4242']);
    t += 2000;
    await p.refresh([]);
    expect(p.sessions()[0].stateSince).toBe(NOW + 2000);   // still the same question: its age keeps counting
    screen = `OK ${SHA}\n Starting…\n`;
    await p.refresh([]);
    expect(p.sessions()[0]).toMatchObject({ state: 'working', starting: true });
    expect(p.sessions()[0].question).toBeUndefined();
  });

  // The external CLAUDE.md imports dialog (2.1.296) used to be titled with the trust question: the "." in "CLAUDE.md"
  // stopped the question pattern.
  it('titles the external-imports dialog with its own question', async () => {
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n${readFileSync(fx('panes/imports-dialog.txt'), 'utf8')}`).exec, now: () => NOW });
    p.add(launch());
    await p.refresh([]);
    expect(p.sessions()[0]).toMatchObject({ state: 'needs-you', starting: true, question: 'Allow external CLAUDE.md file imports?' });
  });

  it('is replaced once Claude registers a session for that pane (by tmux pane or by pid)', async () => {
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n${TRUST}`).exec, now: () => NOW });
    p.add(launch());
    p.add(launch({ target: 'work:@4.%8', pid: 5151, name: 'other' }));
    const real = (o: Partial<Session>) => ({ key: 'local:me:abc', host: 'local', account: 'me', sessionId: 'abc', live: true, state: 'working', pid: 1, ...o }) as Session;
    // A session on another host with the same pane id is someone else's.
    await p.refresh([real({ host: 'box', tmux: 'work:@3.%7' })]);
    expect(p.sessions()).toHaveLength(2);
    await p.refresh([real({ tmux: 'work:@3.%7' })]);
    expect(p.sessions().map((s) => s.name)).toEqual(['other']);
    await p.refresh([real({ pid: 5151 })]);
    expect(p.sessions()).toEqual([]);
  });

  it('Task 42a: a launch named in + New shows that name, and hands it on to the session Claude registers for it', async () => {
    const handed: [string | undefined, string][] = [];
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n`).exec, now: () => NOW, onRegistered: (l, s) => handed.push([l.nickname, s.key]) });
    p.add(launch({ name: 'api work', nickname: 'api work' }));
    p.add(launch({ target: 'work:@4.%8', pid: 5151 }));
    expect(p.sessions().map((s) => s.name)).toEqual(['api work', 'harbor-notes']);
    const real = (o: Partial<Session>) => ({ key: 'local:me:abc', host: 'local', account: 'me', sessionId: 'abc', live: true, state: 'working', pid: 1, ...o }) as Session;
    await p.refresh([real({ tmux: 'work:@3.%7' })]);
    expect(handed).toEqual([['api work', 'local:me:abc']]);
    await p.refresh([real({ key: 'local:me:def', pid: 5151 })]);
    expect(handed).toEqual([['api work', 'local:me:abc'], [undefined, 'local:me:def']]);
  });

  it('drops the row when the pane is gone or now belongs to something else', async () => {
    for (const reply of ['ERR gone', 'ERR moved', 'ERR notowner']) {
      const p = new PendingLaunches({ cfg, exec: fakeExec(() => `${reply}\n`).exec, now: () => NOW });
      p.add(launch());
      await p.refresh([]);
      expect(p.sessions(), reply).toEqual([]);
    }
  });

  it('keeps the row when the pane cannot be read for now (host unreachable, Claude suspended)', async () => {
    for (const exec of [(async () => ({ code: 255, stdout: '', stderr: 'ssh: connect: timed out' })) as HostExec, fakeExec(() => 'ERR stopped\n').exec]) {
      const p = new PendingLaunches({ cfg, exec, now: () => NOW });
      p.add(launch());
      await p.refresh([]);
      expect(p.sessions()).toHaveLength(1);
    }
  });

  it('gives up after about ten minutes, even if the question is still waiting', async () => {
    let t = NOW;
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n${TRUST}`).exec, now: () => t });
    p.add(launch());
    t = NOW + PENDING_MAX_MS - 1;
    await p.refresh([]);
    expect(p.sessions()).toHaveLength(1);
    expect(PENDING_MAX_MS).toBe(10 * 60_000);
    t = NOW + PENDING_MAX_MS;
    await p.refresh([]);
    expect(p.sessions()).toEqual([]);
  });

  it('only takes a launch that tmux reported: a target that is not a pane reference is ignored', () => {
    const p = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n`).exec, now: () => NOW });
    p.add(launch({ target: 'not a pane' }));
    p.add(launch({ host: 'nowhere' }));
    p.add(launch({ pid: 0 }));
    expect(p.sessions()).toEqual([]);
  });
});

describe('Start → pending row', () => {
  it('a successful Start adds the pending row at once and tells the board', async () => {
    const pending = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n`).exec, now: () => NOW });
    let changed = 0;
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: '  --model <m>  x\n', version: '9' } : { ok: true, repos: [{ path: '/home/demo/code/harbor-notes', name: 'harbor-notes', lastUsedMs: 1 }] };
    const exec: HostExec = async () => ({ code: 0, stdout: 'work:@3.%7 4242\n', stderr: '' });
    const svc = createActionService({ cfg, sessions: () => [], probe, exec, pending: { store: pending, changed: () => changed++ } });
    const r = await svc.launch({ account: 'me', repo: '/home/demo/code/harbor-notes', options: {} });
    expect(r).toEqual({ ok: true, message: 'Started in work:@3.%7', target: 'work:@3.%7' });
    expect(pending.sessions()).toMatchObject([{ name: 'harbor-notes', tmux: 'work:@3.%7', pid: 4242, starting: true }]);
    expect(changed).toBe(1);
  });

  it('a failed Start adds nothing', async () => {
    const pending = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n`).exec, now: () => NOW });
    const probe = async (_h: unknown, req: any) => req.mode === 'cli' ? { ok: true, help: '', version: '9' } : { ok: true, repos: [{ path: '/r', name: 'r', lastUsedMs: 1 }] };
    const exec: HostExec = async () => ({ code: 1, stdout: '', stderr: 'tmux: no server' });
    const svc = createActionService({ cfg, sessions: () => [], probe, exec, pending: { store: pending, changed: () => {} } });
    expect(await svc.launch({ account: 'me', repo: '/r', options: {} })).toMatchObject({ ok: false });
    expect(pending.sessions()).toEqual([]);
  });

  it('the collector lists the pending row, then swaps it for the registered session', async () => {
    const pending = new PendingLaunches({ cfg, exec: fakeExec(() => `OK ${SHA}\n${TRUST}`).exec, now: () => NOW });
    let regs: object[] = [];
    const snap = (dir: string, r: object[]) => ({ ok: true, nowMs: NOW, dirs: [{ configDir: dir, registries: r, events: [] }] });
    const c = new Collector(cfg, { now: () => NOW, pending, probe: async (h) => h.id === 'local' ? snap('/c/me', regs) : snap('~/.claude-w', []) });
    pending.add(launch());
    let list = await c.pollOnce();
    expect(list.map((s) => [s.name, s.state, !!s.starting])).toEqual([['harbor-notes', 'needs-you', true]]);
    regs = [{ file: 'abc.json', mtimeMs: NOW, live: true, transcript: [],
      data: { pid: 4242, sessionId: 'abc', cwd: '/home/demo/code/harbor-notes', startedAt: NOW, status: 'busy', updatedAt: NOW, tmux: 'work:@3.%7' } }];
    list = await c.pollOnce();
    expect(list.map((s) => [s.key, !!s.starting])).toEqual([['local:me:abc', false]]);
  });
});

// Real tmux (the suite's private server): the fixture draws the captured 2.1.296 dialog and records the keys it gets.
const made: string[] = [];
afterEach(() => { made.splice(0).forEach(killOwn); });
const keeper = testSessionName('keep-');
beforeAll(() => { execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']); });
afterAll(() => killOwn(keeper));

async function startTrust(script = 'prompt-trust.sh') {
  const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'));
  const result = join(dir, 'result');
  const name = testSessionName('trust-');
  made.push(name);
  execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '40', '-s', name, `${fx(script)} ${result}`]);
  const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
  await wait(400);
  return { result, target: `${name}:${win}.${pane}`, pid: Number(pid) };
}
const deps = (sessions: () => Session[]): AnswerDeps => ({ cfg, sessions, exec: makeExec(), quickReplies: () => [], guard: new SendGuard() });

describe('answering the trust question in a real tmux pane', () => {
  it.each([['2', 'ESC[BENTER'], ['1', 'ENTER']])('choice %s sends the arrow keys and Enter to the launched pane only', async (choice, keys) => {
    const f = await startTrust();
    const other = await startTrust();   // a second pane showing the same dialog, never launched from the board
    const p = new PendingLaunches({ cfg, exec: makeExec() });
    p.add(launch({ target: f.target, pid: f.pid }));
    await p.refresh([]);
    const [row] = p.sessions();
    expect(row).toMatchObject({ state: 'needs-you', question: 'Is this a project you created or one you trust?' });
    const d = deps(() => p.sessions());
    const r: any = await readPrompt(d, row.key);
    expect(r).toMatchObject({ ok: true, prompt: { kind: 'menu', trust: true } });
    expect(r.prompt.options.map((o: any) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(await answer(d, { sessionId: row.key, promptHash: r.prompt.hash, choice })).toEqual({ ok: true, sent: `option ${choice}` });
    await wait(700);
    expect(readFileSync(f.result, 'utf8')).toBe(keys);
    expect(existsSync(other.result)).toBe(false);
  });

  it('a pane that was not launched from the board cannot be answered this way', async () => {
    const f = await startTrust();
    const p = new PendingLaunches({ cfg, exec: makeExec() });
    const d = deps(() => p.sessions());
    // No pending entry for it: no row, so no key to answer.
    expect(await readPrompt(d, `local:me:launch-${f.target}`)).toMatchObject({ ok: false, error: 'unknown_session' });
    // A pending entry whose pid is not the pane's process (the pane id was reused by something else): refused, nothing typed.
    p.add(launch({ target: f.target, pid: f.pid + 100000 }));
    const key = p.sessions()[0].key;
    expect(await answer(d, { sessionId: key, promptHash: 'x', choice: '2' })).toMatchObject({ ok: false, error: 'pane_gone' });
    await p.refresh([]);
    expect(p.sessions()).toEqual([]);
    await wait(300);
    expect(existsSync(f.result)).toBe(false);
  });

  it('a launched pane showing anything but the trust question is not answerable before Claude registers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-trust-'));
    const name = testSessionName('trust-');
    made.push(name);
    execFileSync('tmux', ['new-session', '-d', '-x', '100', '-y', '30', '-s', name, `${fx('prompt-menu.sh')} ${join(dir, 'result')}`]);
    const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
    await wait(400);
    const p = new PendingLaunches({ cfg, exec: makeExec() });
    p.add(launch({ target: `${name}:${win}.${pane}`, pid: Number(pid) }));
    await p.refresh([]);
    expect(p.sessions()[0]).toMatchObject({ state: 'working', starting: true });
    const d = deps(() => p.sessions());
    expect(await readPrompt(d, p.sessions()[0].key)).toMatchObject({ ok: false, error: 'no_prompt' });
    const hash = (await readPrompt(deps(() => [{ ...p.sessions()[0], starting: undefined }]), p.sessions()[0].key) as any).prompt.hash;
    expect(await answer(d, { sessionId: p.sessions()[0].key, promptHash: hash, choice: '1' })).toMatchObject({ ok: false, error: 'no_prompt' });
    await wait(300);
    expect(existsSync(join(dir, 'result'))).toBe(false);
  });
});

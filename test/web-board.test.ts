// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { limitText, renderBoard, reconcileRows, type BoardState } from '../web/src/board.js';
import { showLink } from '../web/src/banner.js';

const session = (i: number, over: object = {}) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, ...over,
}) as any;

const board = (n: number): BoardState => ({
  sessions: Array.from({ length: n }, (_, i) => session(i)), usage: [], accounts: [],
  cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0,
});

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; });
const strips = () => root.querySelector<HTMLElement>('main.strips')!;
const chars = () => [...root.querySelectorAll<HTMLElement>('.char[data-key]')];

describe('renderBoard', () => {
  it('keeps the strip scroll container and its scroll position across re-renders', () => {
    renderBoard(root, board(8), { meters: 'rings' });
    const s = strips();
    expect(s.innerHTML).toContain('sess7');
    s.scrollTop = 300;
    renderBoard(root, board(9), { meters: 'bars' });
    expect(strips()).toBe(s);
    expect(s.scrollTop).toBe(300);
    expect(s.innerHTML).toContain('sess8');
    expect(root.querySelector('header.top')!.innerHTML).toContain('class="counts"');
  });

  it('a launch Claude has not registered yet reads STARTING, and its trust question is the usual NEEDS YOU bubble (Task 40)', () => {
    const b = board(2);
    b.sessions[0] = session(0, { starting: true, currentAction: 'Starting Claude…', name: 'harbor-notes' });
    b.sessions[1] = session(1, { starting: true, state: 'needs-you', question: 'Is this a project you created or one you trust?', tmux: 'w:@1.%1' });
    renderBoard(root, b, { meters: 'rings' });
    const rows = [...root.querySelectorAll<HTMLElement>('.row[data-key]')];
    const word = (k: string) => rows.find((r) => r.dataset.key === k)!.querySelector('.word')!.textContent;
    expect(word('h:a:s0')).toBe('STARTING');
    expect(rows.find((r) => r.dataset.key === 'h:a:s0')!.textContent).toContain('Starting Claude…');
    expect(word('h:a:s1')).toBe('NEEDS YOU');
    expect(rows.find((r) => r.dataset.key === 'h:a:s1')!.querySelector('button.qbubble')!.textContent).toContain('one you trust?');
  });

  it('puts the host-offline tag on its own line, outside the clipped meta line', () => {
    const b = board(1);
    b.sessions[0].hostOnline = false;
    b.sessions[0].lastSeen = Date.now() - 12 * 60_000;
    renderBoard(root, b, { meters: 'rings' });
    expect(root.querySelector('.meta')!.textContent).not.toContain('host offline');
    expect(root.querySelector('.tag')!.textContent).toBe('host offline · last seen 12m ago');
  });

  it('shows a bare dash, not "–%", when context is unknown', () => {
    const b = board(2);
    b.sessions[1].contextPct = 42;
    renderBoard(root, b, { meters: 'rings' });
    const ctx = [...root.querySelectorAll('.ctx')].map((e) => e.firstChild!.textContent);
    expect(ctx.sort()).toEqual(['42%', '–']);
    expect(strips().innerHTML).not.toContain('–%');
  });
});

describe('row text (spec §5.1, §7.2 N6/N7, S6/S7)', () => {
  const one = (over: object) => { const b = board(1); b.sessions[0] = session(0, over); renderBoard(root, b, { meters: 'rings' }); return root.querySelector('.action')!.textContent; };
  it('a needs-you row keeps its question when the cache is about to expire or has expired', () => {
    const q = 'Which database should the importer use?';
    expect(one({ state: 'needs-you', question: q, cacheExpiresAt: Date.now() + 3 * 60_000 - 1000 })).toBe(`Cache expires in 3 min · ${q}`);
    expect(one({ state: 'needs-you', question: q, cacheExpiresAt: Date.now() - 60_000 })).toBe(`Cache expired · ${q}`);
    expect(one({ state: 'needs-you', question: q, cacheExpiresAt: Date.now() + 30 * 60_000 })).toBe(q);
  });
  it('an asleep row says it is waiting, not the last tool call it made before it finished', () => {
    expect(one({ state: 'asleep', currentAction: 'Bash: mkdir -p out', cacheExpiresAt: Date.now() + 30 * 60_000 })).toBe('Waiting for the next prompt');
    expect(one({ state: 'asleep', currentAction: 'Bash: mkdir -p out', cacheExpiresAt: Date.now() - 60_000 })).toBe('Cache expired');
    expect(one({ state: 'working', currentAction: 'Bash: mkdir -p out' })).toBe('Bash: mkdir -p out');
  });
});

describe('keyed rows (Plan 2)', () => {
  it('a row and its .char element survive re-renders, and whatever the character added stays', () => {
    renderBoard(root, board(3), { meters: 'rings' });
    const before = chars();
    before[1].appendChild(document.createElement('canvas'));
    renderBoard(root, board(3), { meters: 'bars' });
    expect(chars()).toEqual(before);
    expect(before[1].querySelector('canvas')).not.toBeNull();
  });

  it('a state change updates the row in place: class, data-state and text change, .char stays', () => {
    const b = board(2);
    renderBoard(root, b, { meters: 'rings' });
    const row = root.querySelector<HTMLElement>('.row[data-key="h:a:s0"]')!;
    const char = row.querySelector('.char')!;
    b.sessions[0] = session(0, { state: 'asleep' });
    renderBoard(root, b, { meters: 'rings' });
    expect(root.querySelector('.row[data-key="h:a:s0"]')).toBe(row);
    expect(row.className).toContain('st-asleep');
    expect(row.querySelector('.char')).toBe(char);
    expect(char.getAttribute('data-state')).toBe('asleep');
    expect(row.querySelector('.word')!.textContent).toBe('ASLEEP');
  });

  it('reorders by moving rows, not recreating them, and removes rows whose session went', () => {
    const b = board(3);
    renderBoard(root, b, { meters: 'rings' });
    const [c0, c1] = chars();
    b.sessions = [session(1, { state: 'needs-you' }), session(0)];      // s1 now sorts first, s2 is gone
    renderBoard(root, b, { meters: 'rings' });
    expect(chars().map((c) => c.dataset.key)).toEqual(['h:a:s1', 'h:a:s0']);
    expect(chars()).toEqual([c1, c0]);
  });

  it('only replaces cells whose HTML changed', () => {
    renderBoard(root, board(1), { meters: 'rings' });
    const name = root.querySelector('.who')!;
    renderBoard(root, board(1), { meters: 'rings' });
    expect(root.querySelector('.who')).toBe(name);
  });

  it('shows the empty message with no sessions, and clears it when one appears', () => {
    renderBoard(root, board(0), { meters: 'rings' });
    expect(strips().textContent).toContain('No sessions running');
    renderBoard(root, board(1), { meters: 'rings' });
    expect(strips().querySelector('.empty')).toBeNull();
    expect(chars()).toHaveLength(1);
  });

  it('reconcileRows works on any container', () => {
    const box = document.createElement('div');
    reconcileRows(box, [{ key: 'a', html: '<div class="row" data-key="a"><div class="char" data-key="a"></div><b>1</b></div>' }]);
    const a = box.firstElementChild;
    reconcileRows(box, [{ key: 'b', html: '<div class="row" data-key="b"><b>2</b></div>' }, { key: 'a', html: '<div class="row" data-key="a"><div class="char" data-key="a"></div><b>3</b></div>' }]);
    expect([...box.children].map((e) => (e as HTMLElement).dataset.key)).toEqual(['b', 'a']);
    expect(box.lastElementChild).toBe(a);
    expect(a!.textContent).toBe('3');
  });
});

describe('before the first state arrives', () => {
  it('shows the clock, the date and the buttons, and says it is connecting rather than "No sessions running"', () => {
    renderBoard(root, null, { meters: 'rings' });
    const top = root.querySelector('header.top')!;
    expect(top.querySelector('.clock')!.textContent).toMatch(/\d\d:\d\d/);
    expect(top.querySelector('.date')!.textContent!.trim()).not.toBe('');
    expect(top.querySelector('[data-act="new"]')).not.toBeNull();
    expect(top.querySelector('.counts')!.textContent!.trim()).toBe('');
    expect(strips().textContent).toBe('Connecting…');
    renderBoard(root, board(0), { meters: 'rings' });
    expect(strips().textContent).toBe('No sessions running');
  });
  it('the banner says it is connecting until the first state, and disconnected after a drop', () => {
    const el = document.createElement('div');
    el.hidden = true;
    showLink(el, 'connecting');
    expect([el.hidden, el.textContent]).toEqual([false, 'Connecting to the daemon…']);
    showLink(el, 'live');
    expect(el.hidden).toBe(true);
    showLink(el, 'down');
    expect([el.hidden, el.textContent]).toEqual([false, 'Disconnected · retrying']);
  });
  it('index.html shows the banner from the first paint, before any script runs', () => {
    const html = readFileSync(join(import.meta.dirname, '..', 'web', 'index.html'), 'utf8');
    expect(html).toMatch(/<div id="banner">Connecting to the daemon…<\/div>/);
  });
});

describe('usage meters', () => {
  it('shows an unknown figure as a bare dash, not "–%"', () => {
    const b = board(0);
    b.usage = [{ account: 'a', label: 'A', colour: '#fff', fiveHour: null, weekly: 42, fiveHourResetsAt: null, weeklyResetsAt: null, stale: true, updatedAt: null } as any];
    renderBoard(root, b, { meters: 'bars' });
    expect([...root.querySelectorAll('.mnums .fig')].map((x) => x.textContent)).toEqual(['–', '42%']);
  });
});

describe('limit rows (spec §7.2 X3)', () => {
  const NOW = Date.parse('2026-10-12T12:00:00Z');
  const u = (fiveHour: number | null, weekly: number | null, fiveAt: string | null, weekAt: string | null) =>
    ({ account: 'a', label: 'A', colour: '#fff', fiveHour, weekly, fiveHourResetsAt: fiveAt, weeklyResetsAt: weekAt, stale: false, updatedAt: NOW }) as any;
  const iso = (min: number) => new Date(NOW + min * 60_000).toISOString();

  it('shows when the full window resets', () => {
    expect(limitText(u(100, 40, iso(150), iso(3000)), NOW)).toBe('Usage limit · resets in 2h 30m');
  });
  it('when both windows are full, the later reset counts', () => {
    expect(limitText(u(100, 100, iso(30), iso(26 * 60)), NOW)).toBe('Usage limit · resets in 1d 2h');
  });
  it('without usage data, or with the reset already past, says the limit was reached', () => {
    expect(limitText(undefined, NOW)).toBe('Usage limit reached');
    expect(limitText(u(64, 40, iso(30), iso(300)), NOW)).toBe('Usage limit reached');
    expect(limitText(u(100, 40, iso(-5), null), NOW)).toBe('Usage limit reached');
  });
  it('a limit row on the board carries the text', () => {
    const b = board(1);
    b.sessions[0] = session(0, { state: 'limit' });
    b.usage = [u(100, 10, new Date(Date.now() + 90 * 60_000 + 30_000).toISOString(), null)];
    renderBoard(root, b, { meters: 'rings' });
    // 1 h 30 min 30 s left reads 1h 31m: a countdown rounds up, never down
    expect(root.querySelector('.st-limit .action')!.textContent).toBe('Usage limit · resets in 1h 31m');
  });
});

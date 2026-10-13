// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { formatDate, renderBoard, type BoardState } from '../web/src/board.js';
import { initBoardTaps, createTapper, type BoardTapDeps } from '../web/src/taps.js';
import { toggleFullscreen } from '../web/src/fullscreen.js';

const session = (i: number, state: string) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state, stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0,
}) as any;
const usage = (account: string, fiveHour: number | null, weekly: number | null) =>
  ({ account, label: account.toUpperCase(), colour: '#e8b54a', fiveHour, weekly, fiveHourResetsAt: null, weeklyResetsAt: null, stale: false, updatedAt: null }) as any;
const board = (): BoardState => ({
  sessions: [session(0, 'needs-you'), session(1, 'working'), session(2, 'working'), session(3, 'asleep'), session(4, 'stopped'), session(5, 'stopped'), session(6, 'stopped')],
  usage: [usage('a', 41, 63), usage('b', null, 7)], accounts: [], cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0,
});

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; });
const keys = () => [...root.querySelectorAll<HTMLElement>('.row[data-key]')].map((r) => r.dataset.key);

describe('top bar', () => {
  it('the date is day, date, month in that order, without commas', () => {
    expect(formatDate(new Date(2026, 9, 12), 'en-GB')).toBe('Mon 12 Oct');
    expect(formatDate(new Date(2026, 9, 1), 'en-US')).toBe('Thu 1 Oct');
  });
  it('has no full-screen button', () => {
    renderBoard(root, board(), { meters: 'rings' });
    expect(root.querySelector('[data-act="fullscreen"]')).toBeNull();
    expect(root.querySelector('.fs')).toBeNull();
    expect(root.textContent).not.toContain('⛶');
  });
  it('counts needs you, working, asleep and stopped, each a button', () => {
    renderBoard(root, board(), { meters: 'rings' });
    const counts = [...root.querySelectorAll<HTMLElement>('.counts button.count')];
    expect(counts.map((c) => [c.dataset.filter, c.querySelector('b')!.textContent])).toEqual([
      ['needs-you', '1'], ['working', '2'], ['asleep', '1'], ['stopped', '3']]);
    expect(counts.every((c) => c.getAttribute('aria-pressed') === 'false')).toBe(true);
  });
  it('a filter shows only that state, marks its count, and still counts everything', () => {
    renderBoard(root, board(), { meters: 'rings', filter: 'stopped' });
    expect(keys()).toEqual(['h:a:s4', 'h:a:s5', 'h:a:s6']);
    const on = root.querySelector<HTMLElement>('.count[aria-pressed="true"]')!;
    expect(on.dataset.filter).toBe('stopped');
    expect(on.classList.contains('on')).toBe(true);
    expect(root.querySelector('.count[data-filter="working"] b')!.textContent).toBe('2');
    renderBoard(root, board(), { meters: 'rings', filter: 'needs-you' });
    expect(keys()).toEqual(['h:a:s0']);
    renderBoard(root, board(), { meters: 'rings' });
    expect(keys()).toHaveLength(7);
  });
  it('a filter applies to grid cards too, and a card is not blank space', () => {
    const m = () => ({ avail: 500, row: 80, gap: 8 });
    renderBoard(root, board(), { meters: 'rings', layout: 'grid', filter: 'working' }, { measure: m });
    expect([...root.querySelectorAll<HTMLElement>('.gcard[data-key]')].map((c) => c.dataset.key)).toEqual(['h:a:s1', 'h:a:s2']);
    expect(root.querySelector('.count.on')!.getAttribute('data-filter')).toBe('working');
  });
  it('a filter with nothing in it says so', () => {
    const b = board();
    b.sessions = b.sessions.filter((s) => s.state !== 'asleep');
    renderBoard(root, b, { meters: 'rings', filter: 'asleep' });
    expect(root.querySelector('.empty')!.textContent).toBe('No sessions asleep');
  });
  it('each account meter is a button; rings drop the 5-hour figure (it is in the ring), bars keep both on one line under the bar', () => {
    renderBoard(root, board(), { meters: 'rings' });
    const m = [...root.querySelectorAll<HTMLElement>('button.meter')];
    expect(m.map((x) => x.dataset.account)).toEqual(['a', 'b']);
    expect(m.map((x) => x.querySelector('.mnums')!.textContent)).toEqual(['wk 63%', 'wk 7%']);
    renderBoard(root, board(), { meters: 'bars' });
    expect(root.querySelector('.mbars')).toBeNull();
    // the round-3 bars meter, unchanged except that its figure line is fixed-width: bar, label, then "5h N% / wk N%"
    expect([...root.querySelectorAll('.meter')].map((m) => [...m.children].map((c) => c.getAttribute('class')))).toEqual([['bars', 'mlabel', 'mnums'], ['bars', 'mlabel', 'mnums']]);
    expect([...root.querySelectorAll('.mnums')].map((x) => x.textContent)).toEqual(['5h 41% / wk 63%', '5h – / wk 7%']);
    expect([...root.querySelectorAll('.mnums')].map((x) => [...x.children].map((c) => c.className))).toEqual(Array(2).fill(['k', 'fig', 'sep', 'k', 'fig']));
    expect(root.querySelector('.meter')!.getAttribute('aria-label')).toBe('A: 5-hour 41%, weekly 63%');
  });
});

describe('double tap', () => {
  it('two taps within 350 ms and 30 px are a double tap; a lone tap fires after the window', () => {
    let t = 0; const timers: Array<{ at: number; fn: () => void }> = [];
    const single = vi.fn(), dbl = vi.fn();
    const tap = createTapper({ now: () => t, setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length - 1; }, clearTimer: (id) => { timers[id as number]!.fn = () => {}; } });
    const run = () => { for (const x of timers.splice(0)) if (x.at <= t) x.fn(); else timers.push(x); };
    tap(10, 10, single, dbl); t = 200; tap(30, 25, single, dbl);
    expect(dbl).toHaveBeenCalledTimes(1); t = 1000; run(); expect(single).not.toHaveBeenCalled();
    tap(10, 10, single, dbl); t = 1400; run(); expect(single).toHaveBeenCalledTimes(1);   // a lone tap, after the window
    tap(10, 10, single, dbl); t = 1500; tap(60, 10, single, dbl);                           // too far apart: two singles
    t = 2000; run(); expect(single).toHaveBeenCalledTimes(3); expect(dbl).toHaveBeenCalledTimes(1);
    tap(10, 10, single, dbl); t = 2400; tap(10, 10, single, dbl);                            // too slow: two singles
    t = 3000; run(); expect(single).toHaveBeenCalledTimes(5); expect(dbl).toHaveBeenCalledTimes(1);
  });

  it('toggleFullscreen enters when not full screen and exits when it is', async () => {
    const calls: string[] = [];
    const doc = { fullscreenElement: null as unknown, documentElement: { requestFullscreen: async () => { calls.push('enter'); } }, exitFullscreen: async () => { calls.push('exit'); } };
    await toggleFullscreen(doc);
    doc.fullscreenElement = {};
    await toggleFullscreen(doc);
    expect(calls).toEqual(['enter', 'exit']);
  });
});

describe('board taps', () => {
  let filter: string | null; let deps: BoardTapDeps; let t: number; let timers: Array<{ at: number; fn: () => void } | null>;
  const run = (ms: number) => { t += ms; timers.forEach((x, i) => { if (x && x.at <= t) { timers[i] = null; x.fn(); } }); };
  const click = (el: Element, x = 100, y = 100) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
  const draw = () => renderBoard(root, board(), { meters: 'rings', ...(filter ? { filter: filter as any } : {}) });
  beforeEach(() => {
    filter = null; t = 0; timers = [];
    deps = {
      getFilter: () => filter as any, setFilter: vi.fn((f) => { filter = f; draw(); }),
      toggleFullscreen: vi.fn(), openAccount: vi.fn(),
      now: () => t, setTimer: (fn, ms) => { timers.push({ at: t + ms, fn }); return timers.length - 1; }, clearTimer: (id) => { timers[id as number] = null; },
    };
    draw();
    initBoardTaps(root, deps);
  });
  const q = (s: string) => root.querySelector(s)!;

  it('tapping a count filters; tapping it again clears', () => {
    click(q('.count[data-filter="asleep"]'));
    expect(filter).toBe('asleep');
    expect(keys()).toEqual(['h:a:s3']);
    click(q('.count[data-filter="working"] b'));            // a tap on the number counts too
    expect(filter).toBe('working');
    click(q('.count[data-filter="working"]'));
    expect(filter).toBeNull();
    expect(keys()).toHaveLength(7);
  });
  it('a tap on the clock or on blank space clears the filter (after the double-tap window)', () => {
    for (const target of ['.clock', 'main.strips', 'header.top', '#app']) {
      filter = 'stopped'; draw();
      click(target === '#app' ? root : q(target));
      expect(filter).toBe('stopped');
      run(400);
      expect(filter, target).toBeNull();
    }
    expect(deps.toggleFullscreen).not.toHaveBeenCalled();
  });
  it('a double tap on the clock or blank space toggles full screen and leaves the filter alone', () => {
    filter = 'stopped'; draw();
    click(q('.clock .time')); run(150); click(q('.clock'), 110, 105);
    expect(deps.toggleFullscreen).toHaveBeenCalledTimes(1);
    run(1000);
    expect(filter).toBe('stopped');
    click(q('main.strips')); run(100); click(q('main.strips'));
    expect(deps.toggleFullscreen).toHaveBeenCalledTimes(2);
  });
  it('the empty part of the meters line is blank space: a double tap there toggles full screen', () => {
    // The meters' box stretches across the top bar (flex: 1) and right-aligns its meters, so most of it is the
    // visible gap between the counts and the first meter (final tablet pass).
    click(q('.meters')); run(100); click(q('.meters'));
    expect(deps.toggleFullscreen).toHaveBeenCalledTimes(1);
  });
  it('a double tap on a row, a button, a count or a meter does not toggle full screen', () => {
    for (const s of ['.row[data-key]', '.row .name', 'button.new', 'button.cog', 'button.view', '.view svg', '.count[data-filter="working"]', 'button.meter', '.meter svg']) {
      click(q(s)); run(100); click(q(s)); run(1000);
    }
    expect(deps.toggleFullscreen).not.toHaveBeenCalled();
  });
  it('tapping a meter calls openAccount with its account', () => {
    click(q('button.meter[data-account="b"] .mlabel'));
    expect(deps.openAccount).toHaveBeenCalledWith('b');
  });
});

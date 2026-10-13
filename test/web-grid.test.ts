// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBoard, type BoardMetrics, type BoardState } from '../web/src/board.js';
import { chooseLayout, stripsNeed } from '../web/src/layout.js';
import { createClayController, type ClayDeps } from '../web/src/clay/controller.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';
import { MemoryStore } from '../web/src/clay/store.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';

const openFocus = vi.fn(() => () => {});
vi.mock('../web/src/focus.js', () => ({ openFocus: (...a: unknown[]) => (openFocus as any)(...a) }));
vi.mock('../web/src/net.js', () => ({ getJson: async () => null, postAction: async () => ({ ok: true, message: '' }) }));

const session = (i: number, over: object = {}) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, ...over,
}) as any;
const board = (n: number, over: (i: number) => object = () => ({})): BoardState => ({
  sessions: Array.from({ length: n }, (_, i) => session(i, over(i))), usage: [], accounts: [],
  cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0,
});

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; openFocus.mockClear(); });
const list = () => root.querySelector<HTMLElement>('main')!;
const chars = () => [...root.querySelectorAll<HTMLElement>('.char[data-key]')];

// A board 474 px tall with 90 px rows and 6 px gaps holds exactly five working rows (5 × 90 + 4 × 6).
const fits5: BoardMetrics = { avail: 474, row: 90, gap: 6 };
const measure = (m: BoardMetrics) => () => m;

describe('chooseLayout (spec §5.1 grid view, §5.3 layout setting)', () => {
  it('auto: strips while the rows fit, grid as soon as they would not', () => {
    expect(chooseLayout('auto', 'strips', 474, 474, 45)).toBe('strips');
    expect(chooseLayout('auto', 'strips', 475, 474, 45)).toBe('grid');
  });
  it('auto: going back to strips needs a margin, so the board does not flap at the boundary', () => {
    expect(chooseLayout('auto', 'grid', 474, 474, 45)).toBe('grid');
    expect(chooseLayout('auto', 'grid', 430, 474, 45)).toBe('grid');
    expect(chooseLayout('auto', 'grid', 429, 474, 45)).toBe('strips');
  });
  it('the setting overrides auto', () => {
    expect(chooseLayout('strips', 'grid', 9999, 100, 45)).toBe('strips');
    expect(chooseLayout('grid', 'strips', 10, 1000, 45)).toBe('grid');
  });
  it('keeps the current layout while the board has no size yet', () => {
    expect(chooseLayout('auto', 'strips', 9999, 0, 45)).toBe('strips');
    expect(chooseLayout('auto', 'grid', 10, 0, 45)).toBe('grid');
  });
});

describe('stripsNeed', () => {
  it('adds each row and the gaps between them; a needs-you row is 1.5 rows', () => {
    expect(stripsNeed([], 90, 6)).toBe(0);
    expect(stripsNeed([session(0), session(1)], 90, 6)).toBe(186);
    expect(stripsNeed([session(0, { state: 'needs-you' }), session(1)], 90, 6)).toBe(135 + 6 + 90);
  });
  it('uses a row\'s measured height when it has one (a long question makes a needs-you row taller)', () => {
    expect(stripsNeed([session(0, { state: 'needs-you' }), session(1)], 90, 6, new Map([['h:a:s0', 200]]))).toBe(200 + 6 + 90);
  });
});

describe('renderBoard layout', () => {
  it('auto shows strips for as many rows as fit, the grid beyond, with hysteresis on the way back', () => {
    renderBoard(root, board(5), { meters: 'rings', layout: 'auto' }, { measure: measure(fits5) });
    expect(list().className).toContain('strips');
    expect(root.querySelectorAll('.row')).toHaveLength(5);
    renderBoard(root, board(6), { meters: 'rings', layout: 'auto' }, { measure: measure(fits5) });
    expect(list().className).toContain('grid');
    expect(root.querySelectorAll('.row')).toHaveLength(0);
    expect(root.querySelectorAll('.gcard')).toHaveLength(6);
    renderBoard(root, board(5), { meters: 'rings', layout: 'auto' }, { measure: measure(fits5) });
    expect(list().className).toContain('grid');                           // five would fit exactly: not enough margin
    renderBoard(root, board(4), { meters: 'rings', layout: 'auto' }, { measure: measure(fits5) });
    expect(list().className).toContain('strips');
  });

  it('the layout setting overrides auto', () => {
    renderBoard(root, board(1), { meters: 'rings', layout: 'grid' }, { measure: measure(fits5) });
    expect(root.querySelectorAll('.gcard')).toHaveLength(1);
    renderBoard(root, board(30), { meters: 'rings', layout: 'strips' }, { measure: measure(fits5) });
    expect(root.querySelectorAll('.row')).toHaveLength(30);
    expect(root.querySelectorAll('.gcard')).toHaveLength(0);
  });

  it('defaults to auto and to strips when the board cannot be measured', () => {
    renderBoard(root, board(30), { meters: 'rings' });
    expect(list().className).toContain('strips');
  });

  it('a card has the character, name, state word and colour, action and context, in the strip order', () => {
    const b = board(3, (i) => (i === 2 ? { state: 'needs-you', question: 'Which DB?', tmux: 'h:@1.%1' } : { currentAction: `Bash: step ${i}` }));
    renderBoard(root, b, { meters: 'rings', layout: 'grid' });
    const cards = [...root.querySelectorAll<HTMLElement>('.gcard')];
    expect(cards.map((c) => c.dataset.key)).toEqual(['h:a:s2', 'h:a:s0', 'h:a:s1']);     // needs-you first
    const [n, w] = cards;
    expect(n.className).toContain('st-needs-you');
    expect(n.querySelector('.char[data-key="h:a:s2"]')).not.toBeNull();
    expect(n.querySelector('.name')!.textContent).toBe('sess2');
    expect(n.querySelector('.word')!.textContent).toBe('NEEDS YOU');
    expect(n.querySelector('.action')!.textContent).toBe('Which DB?');
    expect(n.querySelector('[data-act="answer"]')).not.toBeNull();
    expect(w.querySelector('.action')!.textContent).toBe('Bash: step 0');
    expect(w.querySelector('.gctx')!.textContent).toBe('40%');
    expect(w.querySelector('[data-act="answer"]')).toBeNull();
  });

  it('greys an offline card and tags it, and styles a stopped card', () => {
    renderBoard(root, board(2, (i) => (i ? { state: 'stopped' } : { hostOnline: false, lastSeen: Date.now() - 5 * 60_000 })), { meters: 'rings', layout: 'grid' });
    const off = root.querySelector<HTMLElement>('.gcard[data-key="h:a:s0"]')!;
    expect(off.classList.contains('offline')).toBe(true);
    expect(off.querySelector('.tag')!.textContent).toBe('offline · 5m ago');
    expect(root.querySelector('.gcard[data-key="h:a:s1"]')!.classList.contains('st-stopped')).toBe(true);
  });

  it('escapes names and questions', () => {
    renderBoard(root, board(1, () => ({ name: '<img src=x onerror=alert(1)>', state: 'needs-you', question: '"a" & <b>' })), { meters: 'rings', layout: 'grid' });
    const card = root.querySelector('.gcard')!;
    expect(card.querySelector('img')).toBeNull();
    expect(card.querySelector('b')).toBeNull();
    expect(card.querySelector('.name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(card.querySelector('.action')!.textContent).toBe('"a" & <b>');
  });

  it('keyed cards and their .char slots survive re-renders, state changes and reorders', () => {
    const b = board(3);
    renderBoard(root, b, { meters: 'rings', layout: 'grid' });
    const before = chars();
    before[2].appendChild(document.createElement('canvas'));
    const card0 = root.querySelector('.gcard[data-key="h:a:s0"]');
    b.sessions[2] = session(2, { state: 'needs-you' });
    b.sessions[0] = session(0, { state: 'asleep' });
    renderBoard(root, b, { meters: 'bars', layout: 'grid' });
    expect(chars().map((c) => c.dataset.key)).toEqual(['h:a:s2', 'h:a:s1', 'h:a:s0']);
    expect(new Set(chars())).toEqual(new Set(before));
    expect(before[2].querySelector('canvas')).not.toBeNull();
    expect(root.querySelector('.gcard[data-key="h:a:s0"]')).toBe(card0);
    expect(card0!.className).toContain('st-asleep');
  });
});

describe('switching layouts with characters mounted', () => {
  const deps: Partial<ClayDeps> = {
    openStore: async () => new MemoryStore(),
    backends: () => [],
    makeStage: async () => { throw new Error('no webgl here'); },
    decode: async () => ({ close() {}, width: 1, height: 1 }) as unknown as ImageBitmap,
    liveTrial: async () => ({ fps: 30, worstMs: 50, stutters: 0, frames: 60 }),
    idle: () => new Promise((r) => setTimeout(r, 1)),
    fetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
  };
  it('leaves exactly one character per session, each in a slot on the board', () => {
    const clay = createClayController({ prefs: DEFAULT_CLAY_PREFS, cacheTtlMinutes: 60, deps });
    const recs = () => [...((clay as any).recs as Map<HTMLElement, { bind: { key: string } }>).entries()];
    const b = board(4);
    for (const layout of ['strips', 'grid', 'strips', 'grid'] as const) {
      renderBoard(root, b, { meters: 'rings', layout });
      clay.sync(root, b.sessions, Date.now());
      expect(recs()).toHaveLength(4);
      expect(recs().every(([el]) => el.isConnected && root.contains(el))).toBe(true);
      expect(new Set(recs().map(([, r]) => r.bind.key)).size).toBe(4);
      expect(chars()).toHaveLength(4);
    }
    clay.dispose();
  });
});

describe('tapping a card', () => {
  it('opens the focus view for that session, as a row does', async () => {
    const { initApp } = await import('../web/src/app.js');
    let state: BoardState | null = board(3);
    const clay = { sync() {}, mountLarge: () => () => {}, mountState: () => () => {}, setPrefs() {}, status: () => ({ mode: 'bake', reason: '', baked: 0, total: 0 }), dispose() {} } as any;
    initApp({ root, getState: () => state, getPrefs: () => DEFAULT_PREFS, setPrefs() {}, getClayPrefs: () => DEFAULT_CLAY_PREFS, setClayPrefs() {}, clay });
    renderBoard(root, state!, { meters: 'rings', layout: 'grid' });
    root.querySelector<HTMLElement>('.gcard[data-key="h:a:s1"] .name')!.click();
    expect(openFocus).toHaveBeenCalledTimes(1);
    expect((openFocus.mock.calls[0] as any)[0].sessionKey).toBe('h:a:s1');
    renderBoard(root, state!, { meters: 'rings', layout: 'strips' });
    root.querySelector<HTMLElement>('.row[data-key="h:a:s2"] .name')!.click();
    expect((openFocus.mock.calls[1] as any)[0].sessionKey).toBe('h:a:s2');
    state = null;
  });
});

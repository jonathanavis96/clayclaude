// @vitest-environment happy-dom
// Task 38 (Jonathan, 2026-10-13): "Move the settings cog a bit up and then add a button that swaps views". The button
// sits under the cog, shows the view a tap switches TO, switches the board at once and saves the choice in the same
// `layout` preference the settings panel's Layout option uses, so the two stay in sync both ways.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBoard, type BoardMetrics, type BoardState } from '../web/src/board.js';
import { initBoardTaps, type BoardTapDeps } from '../web/src/taps.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';
import { KEY, loadPrefs, savePrefs, type AppPrefs, type StorageLike } from '../web/src/prefs.js';

vi.mock('../web/src/net.js', () => ({ getJson: async () => null, postAction: async () => ({ ok: true, message: '' }) }));

const session = (i: number) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40,
}) as any;
const board = (n: number): BoardState => ({ sessions: Array.from({ length: n }, (_, i) => session(i)), usage: [], accounts: [], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0 });
// 474 px holds five 90 px rows with 6 px gaps: three sessions fit as strips, thirty do not (auto picks the grid).
const fits5: BoardMetrics = { avail: 474, row: 90, gap: 6 };
const measure = () => fits5;

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; });
const view = () => root.querySelector<HTMLButtonElement>('header.top button.view')!;
const layout = () => root.querySelector<HTMLElement>('main.list')!.dataset.layout;

describe('the view switch under the cog', () => {
  it('sits in the top bar directly after the cog and shows the view a tap switches to', () => {
    renderBoard(root, board(3), { meters: 'rings', layout: 'strips' }, { measure });
    const v = view();
    expect(v).not.toBeNull();
    expect(v.previousElementSibling?.matches('button.cog')).toBe(true);
    expect(v.getAttribute('aria-label')).toBe('Grid view');
    expect(v.dataset.to).toBe('grid');
    expect(v.querySelector('svg.ico-grid')).not.toBeNull();
    renderBoard(root, board(3), { meters: 'rings', layout: 'grid' }, { measure });
    expect(view().getAttribute('aria-label')).toBe('Strip view');
    expect(view().dataset.to).toBe('strips');
    expect(view().querySelector('svg.ico-rows')).not.toBeNull();
  });

  it('follows the layout auto chose, not just the stored preference', () => {
    renderBoard(root, board(30), { meters: 'rings', layout: 'auto' }, { measure });
    expect(layout()).toBe('grid');
    expect(view().getAttribute('aria-label')).toBe('Strip view');
    renderBoard(root, board(3), { meters: 'rings', layout: 'auto' }, { measure });
    expect(layout()).toBe('strips');
    expect(view().getAttribute('aria-label')).toBe('Grid view');
  });

  it('is drawn before the first state arrives too', () => {
    renderBoard(root, null, { meters: 'rings' }, { measure });
    expect(view()?.getAttribute('aria-label')).toBe('Grid view');
  });
});

describe('tapping it (app wiring, as main.ts)', () => {
  /** The board as main.ts runs it: prefs in a store, setPrefs saves and redraws. */
  const mount = async (initial: Partial<AppPrefs>, n = 3) => {
    const { initApp } = await import('../web/src/app.js');
    const data = new Map<string, string>();
    const store: StorageLike = { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
    savePrefs(store, { ...loadPrefs(store), ...initial });
    let prefs = loadPrefs(store);
    const state = board(n);
    const draw = () => renderBoard(root, state, prefs, { measure });
    const clay = { sync() {}, mountLarge: () => () => {}, mountState: () => () => {}, setPrefs() {}, status: () => ({ mode: 'bake', reason: '', baked: 0, total: 0 }), dispose() {} } as any;
    initApp({ root, getState: () => state, getPrefs: () => prefs, setPrefs: (p) => { prefs = p; savePrefs(store, p); draw(); },
      getClayPrefs: () => DEFAULT_CLAY_PREFS, setClayPrefs() {}, clay, getFilter: () => null, setFilter() {} });
    draw();
    return { stored: () => JSON.parse(data.get(KEY) ?? '{}').layout, prefs: () => prefs };
  };

  it('switches the layout at once and stores the choice in the layout preference', async () => {
    const b = await mount({ layout: 'strips' });
    expect(layout()).toBe('strips');
    view().click();
    expect(layout()).toBe('grid');
    expect(b.stored()).toBe('grid');
    expect(view().getAttribute('aria-label')).toBe('Strip view');
    view().click();
    expect(layout()).toBe('strips');
    expect(b.stored()).toBe('strips');
    expect(view().getAttribute('aria-label')).toBe('Grid view');
  });

  it('from auto, a tap stores the other view of the one on screen', async () => {
    const b = await mount({ layout: 'auto' }, 30);
    expect(layout()).toBe('grid');
    view().click();
    expect(layout()).toBe('strips');
    expect(b.stored()).toBe('strips');
  });

  it('the settings Layout option shows what the button chose, and a change there flips the button', async () => {
    const b = await mount({ layout: 'strips' });
    view().click();
    root.querySelector<HTMLElement>('.cog')!.click();
    await vi.waitFor(() => expect(document.querySelector('.settings-panel')).not.toBeNull());
    const sel = document.querySelector<HTMLSelectElement>('select[data-pref="layout"]')!;
    // (happy-dom's select.value ignores a `selected` drawn by innerHTML: read the option the panel marked)
    expect(sel.querySelector<HTMLOptionElement>('option[selected]')?.value).toBe('grid');
    expect(b.prefs().layout).toBe('grid');
    sel.value = 'strips';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(layout()).toBe('strips');
    expect(view().getAttribute('aria-label')).toBe('Grid view');
    expect(b.stored()).toBe('strips');
    const again = document.querySelector<HTMLSelectElement>('select[data-pref="layout"]')!;   // the panel redrew itself
    again.value = 'grid';
    again.dispatchEvent(new Event('change', { bubbles: true }));
    expect(layout()).toBe('grid');
    expect(view().getAttribute('aria-label')).toBe('Strip view');
    document.querySelector<HTMLElement>('.settings [data-act="close"]')?.click();
  });
});

describe('double taps', () => {
  it('a double tap on the view switch is not a double tap on blank space', () => {
    renderBoard(root, board(3), { meters: 'rings', layout: 'strips' }, { measure });
    let t = 0; const timers: Array<{ at: number; fn: () => void }> = [];
    const deps: BoardTapDeps = { getFilter: () => null, setFilter() {}, toggleFullscreen: vi.fn(), openAccount() {},
      now: () => t, setTimer: (fn, ms) => { const x = { at: t + ms, fn }; timers.push(x); return x; }, clearTimer: (x) => { const i = timers.indexOf(x as any); if (i >= 0) timers.splice(i, 1); } };
    initBoardTaps(root, deps);
    const click = (el: Element) => el.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 900, clientY: 40 }));
    for (const el of [view(), view().querySelector('svg')!]) { click(el); t += 100; click(el); t += 1000; }
    expect(deps.toggleFullscreen).not.toHaveBeenCalled();
  });
});

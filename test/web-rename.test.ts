// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { shellHtml, minisHtml } from '../web/src/focus-view.js';
import { focusModel } from '../web/src/focus-model.js';
import { accountHtml } from '../web/src/account-view.js';
import { renderSheet } from '../web/src/answer-view.js';
import { renameSheetHtml, LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from '../web/src/rename.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';

/**
 * Task 41: long-press (touch) or right-click (mouse) on a session's name opens a small rename sheet. The nickname is the
 * board's own: the daemon serves it as the session's name, so every view shows it once the state arrives.
 */
const openFocus = vi.fn(() => () => {});
const openAnswerSheet = vi.fn();
const posted: object[] = [];
let reply: object = { ok: true, message: 'Renamed' };
vi.mock('../web/src/focus.js', () => ({ openFocus: (...a: unknown[]) => (openFocus as any)(...a) }));
vi.mock('../web/src/answer.js', () => ({ openAnswerSheet: (...a: unknown[]) => (openAnswerSheet as any)(...a) }));
vi.mock('../web/src/net.js', () => ({ getJson: async () => null, postAction: async (b: object) => { posted.push(b); return reply; } }));
const { initApp } = await import('../web/src/app.js');

const EVIL = `<img src=x onerror="alert(1)">'"`;
const session = (i: number, over: object = {}) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, ...over,
}) as any;
const board = (...sessions: object[]): BoardState => ({
  sessions: sessions.map((o, i) => session(i, o)), usage: [], accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'h' }], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0,
});

let root: HTMLElement;
let state: BoardState;
const pe = (type: string, el: Element, o: { x?: number; y?: number; pointerType?: string; id?: number; button?: number } = {}) => {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: o.pointerType ?? 'touch', pointerId: o.id ?? 1, clientX: o.x ?? 10, clientY: o.y ?? 10, button: o.button ?? 0 });
  el.dispatchEvent(e);
  return e;
};
const click = (el: Element) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }); el.dispatchEvent(e); return e; };
const ctxmenu = (el: Element) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); el.dispatchEvent(e); return e; };
const sheet = () => document.querySelector<HTMLElement>('#overlays .rename');
const name = (i = 0) => root.querySelector<HTMLElement>(`.row[data-key="h:a:s${i}"] .name, .gcard[data-key="h:a:s${i}"] .name`)!;
/** A tap: down, up after `ms`, then the click the browser sends. */
const tap = (el: Element, ms: number) => { pe('pointerdown', el); vi.advanceTimersByTime(ms); pe('pointerup', el); click(el); };
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  // #overlays stays: overlay.ts keeps its element for the page's life.
  document.getElementById('app')?.remove();
  root = document.createElement('div'); root.id = 'app'; document.body.prepend(root);
  openFocus.mockClear(); openAnswerSheet.mockClear(); posted.length = 0; reply = { ok: true, message: 'Renamed' };
});
afterEach(() => { document.getElementById('overlays')?.replaceChildren(); vi.useRealTimers(); });

function boot(layout: 'strips' | 'grid', b = board({}, { state: 'needs-you', question: 'Which DB?', tmux: 'h:@1.%1' }, { state: 'stopped', live: false })) {
  state = b;
  const prefs = { ...DEFAULT_PREFS, layout } as any;
  renderBoard(root, state, prefs);
  const clay = { sync() {}, setPrefs() {}, mountLarge: () => () => {}, mountState: () => () => {} } as any;
  initApp({ root, getState: () => state, getPrefs: () => prefs, setPrefs() {}, getClayPrefs: () => DEFAULT_CLAY_PREFS, setClayPrefs() {}, clay, getFilter: () => null, setFilter() {} });
}

describe.each(['strips', 'grid'] as const)('%s: opening the rename sheet', (layout) => {
  it(`a ${LONG_PRESS_MS} ms long-press on the name opens it, prefilled, and the click that follows does not open the focus view`, () => {
    boot(layout);
    const n = name();
    pe('pointerdown', n);
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(sheet()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(sheet()).not.toBeNull();
    expect(sheet()!.querySelector<HTMLTextAreaElement>('#rename-text')!.value).toBe('sess0');
    pe('pointerup', n);
    expect(document.activeElement?.id, 'the lift focuses the field (a user gesture), so the keyboard comes up').toBe('rename-text');
    expect(click(n).defaultPrevented).toBe(true);
    expect(openFocus).not.toHaveBeenCalled();
  });
  it('a short tap on the name opens the focus view as before, not the sheet', () => {
    boot(layout);
    tap(name(), 150);
    vi.advanceTimersByTime(1000);
    expect(sheet()).toBeNull();
    expect(openFocus).toHaveBeenCalledTimes(1);
  });
  it(`scrolling does not open it: a move past ${LONG_PRESS_SLOP_PX} px, a pointercancel, or a scroll of the list`, () => {
    boot(layout);
    const n = name();
    pe('pointerdown', n); pe('pointermove', n, { y: 10 + LONG_PRESS_SLOP_PX + 5 }); vi.advanceTimersByTime(1000);
    expect(sheet()).toBeNull();
    pe('pointerdown', n); pe('pointercancel', n); vi.advanceTimersByTime(1000);
    expect(sheet()).toBeNull();
    pe('pointerdown', n); root.querySelector('main.list')!.dispatchEvent(new Event('scroll')); vi.advanceTimersByTime(1000);
    expect(sheet()).toBeNull();
    pe('pointerdown', n); pe('pointermove', n, { x: 13, y: 13 }); vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(sheet(), 'a small wobble is not a scroll').not.toBeNull();
  });
  it('a long-press anywhere but the name (the question bubble, Clear, the row) does nothing new', () => {
    boot(layout);
    for (const sel of ['[data-act="answer"]', '[data-act="clear"]', layout === 'grid' ? '.gstate' : '.ctx']) {
      const el = root.querySelector(sel)!;
      pe('pointerdown', el); vi.advanceTimersByTime(1000); pe('pointerup', el);
      expect(sheet(), sel).toBeNull();
    }
  });
  it('a mouse held down on the name does nothing; right-click opens it and suppresses the browser menu only on names', () => {
    boot(layout);
    pe('pointerdown', name(), { pointerType: 'mouse' }); vi.advanceTimersByTime(1000); pe('pointerup', name(), { pointerType: 'mouse' });
    expect(sheet()).toBeNull();
    const other = root.querySelector(layout === 'grid' ? '.gstate' : '.meta')!;
    expect(ctxmenu(other).defaultPrevented).toBe(false);
    expect(ctxmenu(root.querySelector('header.top')!).defaultPrevented).toBe(false);
    expect(sheet()).toBeNull();
    expect(ctxmenu(name(1)).defaultPrevented).toBe(true);
    expect(sheet()!.querySelector<HTMLTextAreaElement>('#rename-text')!.value).toBe('sess1');
    expect(document.activeElement?.id).toBe('rename-text');
    expect(openFocus).not.toHaveBeenCalled();
  });
});

describe('the rename sheet', () => {
  const openOn = (i = 0) => { boot('strips'); ctxmenu(name(i)); return sheet()!; };
  const field = () => sheet()!.querySelector<HTMLTextAreaElement>('#rename-text')!;
  const btn = (act: string) => sheet()!.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;

  it('Enter saves: it posts the rename action with the field\'s text, then closes', async () => {
    openOn();
    field().value = 'api work';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(posted).toEqual([{ action: 'rename', sessionId: 'h:a:s0', name: 'api work' }]);
    expect(sheet()).toBeNull();
  });
  it('Save posts too; a refusal keeps the sheet open with the daemon\'s message', async () => {
    openOn();
    reply = { ok: false, error: 'bad_request', message: 'Names can be 1 to 40 characters' };
    field().value = '';
    btn('save').click();
    await flush();
    expect(posted).toEqual([{ action: 'rename', sessionId: 'h:a:s0', name: '' }]);
    expect(sheet()!.querySelector('.warn')!.textContent).toBe('Names can be 1 to 40 characters');
  });
  it('Reset posts a null name (back to the derived name); it is off when there is no nickname', async () => {
    boot('strips', board({ name: 'nick', derivedName: 'sess0' }, {}));
    ctxmenu(name(1));
    expect(btn('reset').disabled).toBe(true);
    btn('cancel').click();
    ctxmenu(name(0));
    expect(field().value).toBe('nick');
    expect(sheet()!.textContent).toContain('sess0');
    expect(btn('reset').disabled).toBe(false);
    btn('reset').click();
    await flush();
    expect(posted).toEqual([{ action: 'rename', sessionId: 'h:a:s0', name: null }]);
    expect(sheet()).toBeNull();
  });
  it('Cancel closes without posting anything, and never sends keys or a tmux rename', async () => {
    openOn();
    btn('cancel').click();
    await flush();
    expect(sheet()).toBeNull();
    expect(posted).toEqual([]);
  });
});

describe('escaping the name everywhere it reaches the DOM', () => {
  const s = session(0, { name: EVIL, derivedName: `\u202Eexe.txt <b>x</b>`, state: 'needs-you', question: 'q', tmux: 'h:@1.%1' });
  const b = { ...board(), sessions: [s, session(1)], usage: [{ account: 'a', label: 'Studio', colour: '#fff', fiveHour: 1, weekly: 1, fiveHourResetsAt: null, weeklyResetsAt: null, stale: false, updatedAt: 0 }] } as any;
  const noMarkup = (el: Element) => { expect(el.querySelector('img')).toBeNull(); expect(el.querySelector('b b, .name b')).toBeNull(); };

  it.each(['strips', 'grid'] as const)('%s: the name is text, and the derived name is its tooltip', (layout) => {
    renderBoard(root, b, { meters: 'rings', layout });
    noMarkup(root);
    expect(name().textContent).toBe(EVIL);
    expect(name().getAttribute('title')).toBe(s.derivedName);
    expect(name(1).hasAttribute('title')).toBe(false);
  });
  it('focus view, its mini cards, the account popup, the answer sheet and the rename sheet', () => {
    const host = document.createElement('div');
    host.innerHTML = shellHtml(focusModel(s, null, 0, 'Studio')) + minisHtml([s]) + accountHtml(b.usage[0], [s], 0)
      + renderSheet({ phase: 'loading' }, s, [], '') + renameSheetHtml(s);
    noMarkup(host);
    expect(host.querySelector('.who h2')!.textContent).toBe(EVIL);
    expect(host.querySelector(':scope > .mini span')!.textContent).toBe(EVIL);
    expect(host.querySelector('.acct-sessions .mini span')!.textContent).toBe(EVIL);
    expect(host.querySelector('.sheet-head b')!.textContent).toBe(EVIL);
    expect(host.querySelector<HTMLTextAreaElement>('#rename-text')!.value).toBe(EVIL);
    expect(host.querySelector('.rename-derived')!.textContent).toBe(s.derivedName);
  });
});

describe('Save updates every view; Reset restores', () => {
  it('the served name shows in rows, cards, the focus view and the account popup, and the derived name comes back', () => {
    const named = { ...board({ name: 'api work', derivedName: 'sess0' }), usage: [{ account: 'a', label: 'Studio', colour: '#fff', fiveHour: 1, weekly: 1, fiveHourResetsAt: null, weeklyResetsAt: null, stale: false, updatedAt: 0 }] } as any;
    const reset = { ...named, sessions: [session(0)] };
    for (const layout of ['strips', 'grid'] as const) {
      renderBoard(root, named, { meters: 'rings', layout });
      expect(name().textContent).toBe('api work');
      renderBoard(root, reset, { meters: 'rings', layout });
      expect(name().textContent).toBe('sess0');
      expect(name().hasAttribute('title')).toBe(false);
    }
    expect(shellHtml(focusModel(named.sessions[0], null, 0, 'Studio'))).toContain('api work');
    expect(accountHtml(named.usage[0], named.sessions, 0)).toContain('api work');
    expect(accountHtml(named.usage[0], reset.sessions, 0)).not.toContain('api work');
  });
});

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
const inside = (p: Box, o: Box) => p.x >= o.x - 0.5 && p.y >= o.y - 0.5 && p.x + p.w <= o.x + o.w + 0.5 && p.y + p.h <= o.y + o.h + 0.5;

describe.skipIf(!CHROMIUM)('rename sheet layout (real CSS in Chromium)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });
  beforeEach(() => { vi.useRealTimers(); });   // Playwright needs real timers
  const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

  // Landscape and portrait, at rest and with the keyboard up (the visual viewport the overlays follow: 160 px in a
  // landscape Chrome tab, 281 px in landscape full screen, about 560 px in portrait).
  it.each([[961, 601, 601], [961, 601, 160], [961, 602, 281], [601, 961, 961], [601, 961, 560]])('at %ix%i with %i px visible, the field and all three buttons show inside the sheet', async (w, h, vvh) => {
    const page = await browser.newPage({ viewport: { width: w, height: h } });
    try {
      const short = vvh < 360 ? ' short kb' : '';
      // Task 42a: a session in tmux also gets the "Also rename the tmux window" tick
      await page.setContent(`<style>${css}</style><div id="overlays" class="${short}" style="--vvh:${vvh}px"><div class="rename modal">${renameSheetHtml({ name: 'a much longer board nickname here!', derivedName: 'orchard-api-session-with-a-long-name', tmux: 'agents:@1.%1', live: true })}</div></div>`);
      const r = await page.evaluate(() => {
        const box = (e: Element | null) => { const b = e!.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
        return { ov: box(document.getElementById('overlays')), sheet: box(document.querySelector('.sheet')), input: box(document.querySelector('#rename-text')),
          btns: [...document.querySelectorAll('.row-btns button')].map(box), x: box(document.querySelector('.x')), tick: box(document.querySelector('.rename-tmux')),
          box: box(document.querySelector('#rename-tmux')), words: (document.querySelector('.rename-tmux') as HTMLElement).innerText };
      });
      expect(inside(r.sheet, r.ov), 'sheet inside the visible area').toBe(true);
      for (const b of [r.input, ...r.btns, r.x, r.tick]) expect(inside(b, r.sheet), JSON.stringify(b)).toBe(true);
      for (const b of r.btns) { expect(b.h).toBeGreaterThanOrEqual(44); expect(overlap(b, r.input)).toBe(false); expect(overlap(b, r.tick)).toBe(false); }
      expect(overlap(r.tick, r.input)).toBe(false);
      expect(r.tick.h, 'the tick is a comfortable tap target').toBeGreaterThanOrEqual(40);
      expect(r.box.w).toBeGreaterThanOrEqual(20);
      expect(r.words).toContain('Also rename the tmux window');
      expect(r.input.w).toBeGreaterThan(200);
    } finally { await page.close(); }
  });
});

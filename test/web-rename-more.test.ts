// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { LONG_PRESS_MS } from '../web/src/rename.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';

/**
 * Task 42a: the rename sheet also opens from a long-press or right-click on the session's name in its focus view (the
 * title) and in the account popup's session list, and it can also rename the session's tmux window (off by default).
 */
const posted: object[] = [];
let reply: object = { ok: true, message: 'Renamed' };
vi.mock('../web/src/net.js', () => ({ getJson: async () => null, postAction: async (b: object) => { posted.push(b); return reply; } }));
const { initApp } = await import('../web/src/app.js');

const session = (i: number, over: object = {}) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, ...over,
}) as any;
const usage = { account: 'a', label: 'Studio', colour: '#e8b54a', fiveHour: 10, weekly: 20, fiveHourResetsAt: null, weeklyResetsAt: null, stale: false, updatedAt: 0 };
const board = (...sessions: object[]): BoardState => ({
  sessions: sessions.map((o, i) => session(i, o)), usage: [usage] as any, accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'h' }], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0,
});

let root: HTMLElement;
let state: BoardState;
const pe = (type: string, el: Element, o: { x?: number; y?: number; pointerType?: string; id?: number } = {}) => {
  const e = new PointerEvent(type, { bubbles: true, cancelable: true, pointerType: o.pointerType ?? 'touch', pointerId: o.id ?? 1, clientX: o.x ?? 10, clientY: o.y ?? 10 });
  el.dispatchEvent(e);
  return e;
};
const click = (el: Element) => { const e = new MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(e); return e; };
const ctxmenu = (el: Element) => { const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }); el.dispatchEvent(e); return e; };
const sheet = () => document.querySelector<HTMLElement>('#overlays .rename');
const field = () => sheet()!.querySelector<HTMLTextAreaElement>('#rename-text')!;
const focusView = () => document.querySelector<HTMLElement>('#overlays .focus');
const accountPopup = () => document.querySelector<HTMLElement>('#overlays .account');
const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  vi.useFakeTimers();
  document.getElementById('app')?.remove();
  root = document.createElement('div'); root.id = 'app'; document.body.prepend(root);
  posted.length = 0; reply = { ok: true, message: 'Renamed' };
});
afterEach(() => {
  // close every overlay with its own button, top first, so the next test starts with none (and the popup can open again)
  for (let i = 0; i < 6; i++) {
    const top = [...document.querySelectorAll<HTMLElement>('#overlays > .modal')].pop();
    if (!top) break;
    top.querySelector<HTMLElement>('[data-act="cancel"], [data-act="close"]')!.click();
  }
  document.getElementById('overlays')?.replaceChildren();
  vi.useRealTimers();
});

function boot(b = board({ tmux: 'h:@1.%1' }, { state: 'stopped', live: false }, { name: 'nick', derivedName: 'own-name', tmux: 'h:@3.%3' })) {
  state = b;
  const prefs = { ...DEFAULT_PREFS, layout: 'strips' } as any;
  renderBoard(root, state, prefs);
  const clay = { sync() {}, setPrefs() {}, mountLarge: () => () => {}, mountState: () => () => {} } as any;
  initApp({ root, getState: () => state, getPrefs: () => prefs, setPrefs() {}, getClayPrefs: () => DEFAULT_CLAY_PREFS, setClayPrefs() {}, clay, getFilter: () => null, setFilter() {} });
}
const openFocusOn = (i: number) => { click(root.querySelector(`.row[data-key="h:a:s${i}"] .ctx`)!); expect(focusView()).not.toBeNull(); };
const title = () => focusView()!.querySelector<HTMLElement>('.who h2')!;

describe('the focus view\'s title', () => {
  it(`a ${LONG_PRESS_MS} ms long-press opens the rename sheet for that session; the lift focuses the field and its click does nothing else`, () => {
    boot();
    openFocusOn(2);
    pe('pointerdown', title());
    vi.advanceTimersByTime(LONG_PRESS_MS - 1);
    expect(sheet()).toBeNull();
    vi.advanceTimersByTime(1);
    expect(sheet()).not.toBeNull();
    expect(field().value).toBe('nick');
    expect(sheet()!.textContent).toContain('own-name');
    pe('pointerup', title());
    expect(document.activeElement?.id).toBe('rename-text');
    expect(click(title()).defaultPrevented).toBe(true);
    expect(focusView(), 'the focus view stays open under the sheet').not.toBeNull();
  });
  it('right-click opens it and suppresses the browser menu there only; a short tap or a press elsewhere does nothing new', () => {
    boot();
    openFocusOn(0);
    pe('pointerdown', title()); vi.advanceTimersByTime(150); pe('pointerup', title()); click(title());
    vi.advanceTimersByTime(1000);
    expect(sheet()).toBeNull();
    const meta = focusView()!.querySelector('.who .meta')!;
    pe('pointerdown', meta); vi.advanceTimersByTime(1000); pe('pointerup', meta);
    expect(sheet()).toBeNull();
    expect(ctxmenu(meta).defaultPrevented).toBe(false);
    expect(ctxmenu(title()).defaultPrevented).toBe(true);
    expect(field().value).toBe('sess0');
    expect(document.activeElement?.id).toBe('rename-text');
  });
  it('Save posts the rename for the focused session', async () => {
    boot();
    openFocusOn(0);
    ctxmenu(title());
    field().value = 'api work';
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    expect(posted).toEqual([{ action: 'rename', sessionId: 'h:a:s0', name: 'api work' }]);
    expect(sheet()).toBeNull();
  });
});

describe('the account popup\'s session list', () => {
  const openPopup = () => { click(root.querySelector('.meter[data-account="a"]')!); expect(accountPopup()).not.toBeNull(); };
  const listName = (i: number) => accountPopup()!.querySelector<HTMLElement>(`.acct-sessions .mini[data-key="h:a:s${i}"] span`)!;
  it('a long-press on a name opens the sheet for it, and the popup stays (no focus view)', () => {
    boot();
    openPopup();
    pe('pointerdown', listName(2));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    expect(sheet()).not.toBeNull();
    expect(field().value).toBe('nick');
    pe('pointerup', listName(2));
    expect(click(listName(2)).defaultPrevented).toBe(true);
    vi.advanceTimersByTime(500);
    expect(focusView()).toBeNull();
    expect(accountPopup()).not.toBeNull();
  });
  it('right-click opens it too; a short tap still opens the focus view', () => {
    boot();
    openPopup();
    expect(ctxmenu(listName(0)).defaultPrevented).toBe(true);
    expect(field().value).toBe('sess0');
    sheet()!.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click();
    pe('pointerdown', listName(0)); vi.advanceTimersByTime(100); pe('pointerup', listName(0)); click(listName(0));
    vi.advanceTimersByTime(500);
    expect(sheet()).toBeNull();
    expect(focusView()).not.toBeNull();
  });
});

describe('Also rename the tmux window', () => {
  const tick = () => sheet()!.querySelector<HTMLInputElement>('#rename-tmux');
  const name = (i: number) => root.querySelector<HTMLElement>(`.row[data-key="h:a:s${i}"] .name`)!;
  it('is offered only for a session in tmux, and is off by default', () => {
    boot();
    ctxmenu(name(0));
    expect(tick()).not.toBeNull();
    expect(tick()!.checked).toBe(false);
    expect(sheet()!.textContent).toContain('Also rename the tmux window');
    sheet()!.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click();
    ctxmenu(name(1));
    expect(tick()).toBeNull();
  });
  it('off: Save posts no tmux flag; on: Save and Reset post tmux: true', async () => {
    boot();
    ctxmenu(name(0));
    field().value = 'one';
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    ctxmenu(name(0));
    tick()!.click();
    expect(tick()!.checked).toBe(true);
    field().value = 'two';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    ctxmenu(name(2));
    tick()!.click();
    sheet()!.querySelector<HTMLButtonElement>('[data-act="reset"]')!.click();
    await flush();
    expect(posted).toEqual([
      { action: 'rename', sessionId: 'h:a:s0', name: 'one' },
      { action: 'rename', sessionId: 'h:a:s0', name: 'two', tmux: true },
      { action: 'rename', sessionId: 'h:a:s2', name: null, tmux: true },
    ]);
  });
  // Tablet check: in full screen with the keyboard up, a tap on the box closed the keyboard and did not tick it (3 of 3).
  // Pressing the tick keeps the focus (and the keyboard) in the field; the click still ticks it.
  it('pressing the tick does not take the focus from the field', () => {
    boot();
    ctxmenu(name(0));
    expect(document.activeElement?.id).toBe('rename-text');
    for (const el of [tick()!, sheet()!.querySelector('.rename-tmux')!]) {
      expect(pe('pointerdown', el).defaultPrevented, el.tagName).toBe(true);
      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.dispatchEvent(md);
      expect(md.defaultPrevented, el.tagName).toBe(true);
    }
    tick()!.click();
    expect(tick()!.checked).toBe(true);
    expect(document.activeElement?.id).toBe('rename-text');
  });
  it('a window the daemon could not rename is reported, and the sheet closes (the board name was saved)', async () => {
    boot();
    reply = { ok: true, message: 'Renamed to two. The tmux window was not renamed: that pane no longer belongs to this session', name: 'two', tmuxError: 'that pane no longer belongs to this session' };
    ctxmenu(name(0));
    tick()!.click();
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    expect(sheet()).toBeNull();
    const t = document.querySelector('#overlays .toast')!;
    expect(t.className).toContain('error');
    expect(t.textContent).toContain('tmux window was not renamed');
  });
});

describe('Also rename in Claude Code (Task 42)', () => {
  const ctick = () => sheet()!.querySelector<HTMLInputElement>('#rename-claude');
  const tick = () => sheet()!.querySelector<HTMLInputElement>('#rename-tmux');
  const name = (i: number) => root.querySelector<HTMLElement>(`.row[data-key="h:a:s${i}"] .name`)!;
  it('is offered beside the tmux tick only for a running session in tmux, and is off by default', () => {
    boot();
    ctxmenu(name(0));
    expect(ctick()).not.toBeNull();
    expect(ctick()!.checked).toBe(false);
    expect(sheet()!.textContent).toContain('Also rename in Claude Code');
    sheet()!.querySelector<HTMLButtonElement>('[data-act="cancel"]')!.click();
    ctxmenu(name(1));
    expect(ctick()).toBeNull();
  });
  it('off: no claude flag; on: Save posts claude: true, with the tmux flag when that is ticked too', async () => {
    boot();
    ctxmenu(name(0));
    field().value = 'one';
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    ctxmenu(name(0));
    ctick()!.click();
    field().value = 'two';
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    ctxmenu(name(0));
    ctick()!.click();
    tick()!.click();
    field().value = 'three';
    field().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    await flush();
    expect(posted).toEqual([
      { action: 'rename', sessionId: 'h:a:s0', name: 'one' },
      { action: 'rename', sessionId: 'h:a:s0', name: 'two', claude: true },
      { action: 'rename', sessionId: 'h:a:s0', name: 'three', tmux: true, claude: true },
    ]);
  });
  it('ticked, the note says Claude Code takes the name too, and only while the session is idle', () => {
    boot();
    ctxmenu(name(0));
    const note = () => sheet()!.querySelector<HTMLElement>('.rename-note')!.textContent!;
    expect(note()).toContain('Only the board shows this name');
    ctick()!.click();
    expect(note()).toContain('/rename');
    expect(note()).toMatch(/idle/);
    ctick()!.click();
    expect(note()).toContain('Only the board shows this name');
  });
  it('pressing it does not take the focus from the field', () => {
    boot();
    ctxmenu(name(0));
    for (const el of [ctick()!, sheet()!.querySelector('.rename-claude')!]) {
      expect(pe('pointerdown', el).defaultPrevented, el.tagName).toBe(true);
      const md = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.dispatchEvent(md);
      expect(md.defaultPrevented, el.tagName).toBe(true);
    }
    ctick()!.click();
    expect(ctick()!.checked).toBe(true);
    expect(document.activeElement?.id).toBe('rename-text');
  });
  it('a refusal (the session is not idle) is shown in the sheet, which stays open', async () => {
    boot();
    reply = { ok: false, error: 'no_prompt', message: 'Not renamed in Claude Code: Claude is working in this session. Nothing was sent.' };
    ctxmenu(name(0));
    ctick()!.click();
    sheet()!.querySelector<HTMLButtonElement>('[data-act="save"]')!.click();
    await flush();
    expect(sheet()).not.toBeNull();
    const w = sheet()!.querySelector<HTMLElement>('.warn')!;
    expect(w.hidden).toBe(false);
    expect(w.textContent).toContain('Claude is working');
  });
});

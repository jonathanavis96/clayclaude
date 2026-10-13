import type { Session } from '../../src/types.js';
import { esc } from './html.js';
import { postAction } from './net.js';
import { pushOverlay, toast } from './overlay.js';

/** Task 41: how long a finger rests on a name before the rename sheet opens, and how far it may wander (a scroll moves further). */
export const LONG_PRESS_MS = 500;
export const LONG_PRESS_SLOP_PX = 10;
/** The board's 40-character limit (src/nicknames.ts checks it again, by characters). */
const MAX = 40;
/** The names that take a long-press or a right-click: a strip row's and a grid card's. Nothing else on the board. */
const NAME = '.row[data-key] .name, .gcard[data-key] .name';

/** Task 42a: the rename sheet offers to rename the tmux window too only for a running session in tmux. */
const inTmux = (s: Partial<Pick<Session, 'tmux' | 'live'>>) => !!s.tmux && !!s.live;

const boardOnlyNote = (own: string) => `Only the board shows this name. The session keeps its own: <span class="rename-derived">${esc(own)}</span>`;
/** Task 42: what "Also rename in Claude Code" does, shown in place of the board-only note while it is ticked. */
const CLAUDE_NOTE = 'Claude Code takes this name too: <code>/rename</code> is typed into the session, only while it is idle and waiting for a prompt.';

export function renameSheetHtml(s: Pick<Session, 'name' | 'derivedName'> & Partial<Pick<Session, 'tmux' | 'live'>>): string {
  const own = s.derivedName ?? s.name;
  return `<section class="sheet rename-sheet"><header class="sheet-head"><b>${esc(s.name)}</b><span class="muted">Rename on this board</span>`
    + `<button class="x" data-act="cancel" aria-label="Close">×</button></header><div class="sheet-body">`
    + `<div class="reply"><textarea id="rename-text" rows="1" maxlength="${MAX}" aria-label="Name on the board" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="done">${esc(s.name)}</textarea></div>`
    + `<p class="muted rename-note">${boardOnlyNote(own)}</p>`
    + `<p class="warn" hidden></p>`
    + `<div class="row-btns"><button class="primary" data-act="save">Save</button><button data-act="reset"${s.derivedName === undefined ? ' disabled' : ''}>Reset</button><button data-act="cancel">Cancel</button>`
    + (inTmux(s) ? '<span class="rename-ticks"><label class="rename-tick rename-tmux"><input type="checkbox" id="rename-tmux"> Also rename the tmux window</label>'
      + '<label class="rename-tick rename-claude"><input type="checkbox" id="rename-claude"> Also rename in Claude Code</label></span>' : '')
    + `</div>`
    + `</div></section>`;
}

/**
 * The rename sheet: a field holding the board's name for the session, Save (or Enter), Reset (back to the session's own
 * name) and Cancel. It sits at the bottom of the overlays, which follow the visual viewport, so the on-screen keyboard
 * never covers it (as the answer sheet). It only ever posts the `rename` action, and never keys. Ticking "Also rename
 * the tmux window" (Task 42a, off by default) asks the daemon to rename the session's tmux window to the same name;
 * "Also rename in Claude Code" (Task 42, off by default) asks it to type `/rename <name>` into the session, which it
 * does only under the idle gate (src/actions/message.ts). A refusal stays in the sheet and renames nothing.
 * Returns a function that focuses the field (from a user gesture, so the keyboard comes up).
 */
export function openRenameSheet(s: Session): () => void {
  const el = document.createElement('div');
  el.className = 'rename modal';
  el.innerHTML = renameSheetHtml(s);
  // A textarea, as in the answer sheet: Chrome on Android puts its autofill strip over the page for an <input>, and
  // the visual viewport does not leave room for it, so it hid the buttons with the keyboard up (tablet check).
  const input = el.querySelector<HTMLTextAreaElement>('#rename-text')!;
  const warn = el.querySelector<HTMLElement>('.warn')!;
  const tmux = el.querySelector<HTMLInputElement>('#rename-tmux');
  const claude = el.querySelector<HTMLInputElement>('#rename-claude');
  // Pressing a tick leaves the focus (and so the keyboard) in the field; the click still ticks it. Tablet check: in
  // full screen with the keyboard up, a tap on the box closed the keyboard, the sheet moved, and the box stayed as it was.
  const keep = (e: Event) => e.preventDefault();
  for (const t of ['pointerdown', 'mousedown']) el.querySelectorAll('.rename-tick').forEach((l) => l.addEventListener(t, keep));
  const note = el.querySelector<HTMLElement>('.rename-note')!;
  claude?.addEventListener('change', () => { note.innerHTML = claude.checked ? CLAUDE_NOTE : boardOnlyNote(s.derivedName ?? s.name); });
  let busy = false;
  const close = pushOverlay(el, () => {});
  const send = async (name: string | null) => {
    if (busy) return;
    busy = true;
    const r = await postAction<{ message: string; tmuxError?: string }>({ action: 'rename', sessionId: s.key, name, ...(tmux?.checked ? { tmux: true } : {}), ...(claude?.checked ? { claude: true } : {}) });
    busy = false;
    // The board name is saved even when the window could not be renamed: close, and say so as an error.
    if (r.ok) { close(); toast(r.message, r.tmuxError ? 'error' : 'ok'); return; }
    warn.textContent = r.message; warn.hidden = false;
  };
  el.addEventListener('click', (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'cancel') close();
    else if (act === 'save') void send(input.value);
    else if (act === 'reset') void send(null);
  });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void send(input.value); } });
  input.addEventListener('focus', () => setTimeout(() => input.scrollIntoView({ block: 'nearest' }), 250));
  return () => { input.focus(); input.select(); };
}

export interface RenameGestureDeps {
  /** Opens the sheet for this session key; returns a function that focuses its field, if it opened. */
  open(key: string): (() => void) | void;
  /** The names that take the gesture (Task 42a: the focus view's title, the account popup's list). Default: the board's rows and cards. */
  names?: string;
  /** The session a name belongs to. Default: its nearest `data-key`. */
  keyOf?(name: Element): string | undefined;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(id: unknown): void;
}

/**
 * Long-press (touch or pen) or right-click (mouse) on a session's name opens the rename sheet (Task 41). The rest of
 * the board is left as it was: a short tap on the name still opens the focus view, a finger that moves (a scroll) or a
 * pointercancel never opens anything, and the browser's own menu shows everywhere but on names. After a long-press,
 * lifting the finger focuses the field (the lift is a user gesture, so the keyboard comes up) and the click it makes is
 * swallowed, so the row under it does not also open its focus view.
 */
export function initRenameGestures(root: HTMLElement, deps: RenameGestureDeps): () => void {
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>));
  let press: { id: number; x: number; y: number; timer: unknown } | null = null;
  /** A long-press opened the sheet: focus its field on the lift, and swallow the click that follows. */
  let fired: { focus?: () => void; lifted: boolean } | null = null;
  const sel = deps.names ?? NAME;
  const keyOfName = deps.keyOf ?? ((n: Element) => n.closest<HTMLElement>('[data-key]')?.dataset.key);
  const keyOf = (t: EventTarget | null) => {
    const name = t instanceof Element ? t.closest(sel) : null;
    return name && root.contains(name) ? keyOfName(name) : undefined;
  };
  const cancel = () => { if (press) clearTimer(press.timer); press = null; };

  const down = (e: PointerEvent) => {
    cancel();
    fired = null;   // a new touch: whatever came before is over
    if (e.pointerType === 'mouse') return;   // a mouse right-clicks instead
    const key = keyOf(e.target);
    if (!key) return;
    press = { id: e.pointerId, x: e.clientX, y: e.clientY, timer: setTimer(() => { press = null; fired = { focus: deps.open(key) || undefined, lifted: false }; }, LONG_PRESS_MS) };
  };
  const move = (e: PointerEvent) => {
    if (press && e.pointerId === press.id && Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_SLOP_PX) cancel();
  };
  const up = (e: PointerEvent) => {
    if (press && e.pointerId === press.id) { cancel(); return; }   // a short tap: the click goes on to the row
    if (fired && !fired.lifted) { fired.lifted = true; fired.focus?.(); }
  };
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = null;
    e.preventDefault(); e.stopImmediatePropagation();
  };
  const menu = (e: MouseEvent) => {
    const key = keyOf(e.target);
    if (!key) return;   // the browser's own menu, everywhere but on names
    e.preventDefault();
    if (fired) return;  // a touch long-press already opened it (Chrome on Android sends contextmenu for it too)
    const touching = !!press;
    cancel();
    const focus = deps.open(key) || undefined;
    // A touch still down: focus on the lift and swallow its click. A mouse: focus now (the right-click is the gesture).
    if (touching) fired = { focus, lifted: false }; else focus?.();
  };
  const opts = { capture: true };
  root.addEventListener('pointerdown', down, opts);
  window.addEventListener('pointermove', move, opts);
  window.addEventListener('pointerup', up, opts);
  window.addEventListener('pointercancel', cancel, opts);
  root.addEventListener('scroll', cancel, opts);   // scroll does not bubble; capture sees the list's
  root.addEventListener('click', click, opts);
  root.addEventListener('contextmenu', menu);
  return () => {
    cancel();
    root.removeEventListener('pointerdown', down, opts);
    window.removeEventListener('pointermove', move, opts);
    window.removeEventListener('pointerup', up, opts);
    window.removeEventListener('pointercancel', cancel, opts);
    root.removeEventListener('scroll', cancel, opts);
    root.removeEventListener('click', click, opts);
    root.removeEventListener('contextmenu', menu);
  };
}

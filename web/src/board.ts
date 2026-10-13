import type { AccountUsage, Session } from '../../src/types.js';
import { formatAge, formatCountdown, sortSessions } from './order.js';
import { barsSvg, ringsSvg } from './meters.js';
import { actionHtml, rowActionsHtml } from './row-actions.js';
import { applyFilter, COUNT_FILTERS, type CountFilter } from './filter.js';
import { chooseLayout, stripsNeed, type Layout, type LayoutPref } from './layout.js';

export interface BoardState { sessions: Session[]; usage: AccountUsage[]; accounts: { id: string; label: string; colour: string; host: string }[]; cacheTtlMinutes: number; serverTime: number; clockSkew: number }
/** `filter`: the count the person tapped (spec §5.1); only sessions in that state are drawn. Local, never saved. */
export interface Prefs { meters: 'rings' | 'bars'; layout?: LayoutPref; filter?: CountFilter | null }
/** The board's measured sizes in CSS px: the list's visible height, one strip row's height and the gap between rows. */
export interface BoardMetrics { avail: number; row: number; gap: number }
export interface RenderOpts {
  /** Called when a size change (rotation, window resize) switches the layout; it should redraw the board. */
  onRelayout?: () => void;
  /** Test seam: the real one reads the DOM. */
  measure?: (list: HTMLElement, probe: HTMLElement) => BoardMetrics;
}

/** The probe is `height: var(--row); width: var(--gap)`, so the CSS stays the one source of both sizes. */
const domMetrics = (list: HTMLElement, probe: HTMLElement): BoardMetrics => ({ avail: list.clientHeight, row: probe.offsetHeight, gap: probe.offsetWidth });

interface LayoutState {
  layout: Layout;
  /** Measured heights of needs-you rows (they grow with the question), kept while the grid shows so both layouts judge the same need. */
  heights: Map<string, { sig: string; h: number }>;
  /** Re-checks the layout after a resize; replaced on every render. */
  check: () => void;
}
const layouts = new WeakMap<HTMLElement, LayoutState>();
const observed = new WeakSet<HTMLElement>();

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
/** A usage figure: a whole percentage, or a bare dash when it is unknown (never "–%"). */
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)}%`);
const COUNT_LABEL: Record<CountFilter, string> = { 'needs-you': 'needs you', working: 'working', asleep: 'asleep', stopped: 'stopped' };
const EMPTY_FILTERED: Record<CountFilter, string> = { 'needs-you': 'No sessions need you', working: 'No sessions working', asleep: 'No sessions asleep', stopped: 'No sessions stopped' };
/** The stopped filter's "Clear all stopped" bar (spec §5.1, UI round 4) is the list's first item, under this key (no session key lacks a colon). */
const CLEAR_ALL_KEY = 'clear-stopped';
const CLEAR_ALL_HTML = `<div class="clearbar" data-key="${CLEAR_ALL_KEY}"><button class="clear-all" data-act="clear-stopped">Clear all stopped</button></div>`;
const WORD: Record<string, string> = { 'needs-you': 'NEEDS YOU', working: 'WORKING', asleep: 'ASLEEP', stopped: 'STOPPED', compacting: 'COMPACTING', limit: 'LIMIT' };
/** A launch Claude has not registered yet reads STARTING until its trust question (if any) makes it NEEDS YOU (Task 40). */
const word = (s: Session) => (s.starting && s.state === 'working' ? 'STARTING' : WORD[s.state]);

/**
 * Spec §7.2 X3: a limit row shows when the limit resets: the later reset of the account's windows
 * that are full. Without usage data (or with a reset already past) it says the limit was reached.
 */
export function limitText(u: AccountUsage | undefined, now: number): string {
  const full = [[u?.fiveHour, u?.fiveHourResetsAt], [u?.weekly, u?.weeklyResetsAt]] as const;
  const at = full.filter(([pct, r]) => (pct ?? 0) >= 100 && r).map(([, r]) => Date.parse(r!)).filter((t) => Number.isFinite(t) && t > now);
  return at.length ? `Usage limit · resets in ${formatCountdown(Math.max(...at) - now)}` : 'Usage limit reached';
}

/** "Mon 12 Oct": day, date, month in that order (spec §5.1), whatever order the locale prefers. */
export function formatDate(d: Date, locale?: string): string {
  const parts = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(d);
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? '';
  return [part('weekday'), part('day'), part('month')].filter(Boolean).join(' ').replace(/[.,]/g, '');
}

/**
 * One account meter, a button (a tap opens the account popup, Task 29). Rings show the 5-hour figure in their centre,
 * so the line under them carries only the weekly one. Bars keep their round-3 form (64 px bars, label, then
 * "5h N% / wk N%" on one line; when the top bar has no room for every full line, the line sheds its words, then its
 * % signs, style.css).
 * Figures are fixed-width, right-aligned tabular columns, so the line never wraps.
 */
function meterHtml(u: AccountUsage, mode: Prefs['meters']): string {
  const fig = (v: number | null) => `<span class="fig">${v === null ? '–' : `${Math.round(v)}<span class="pc">%</span>`}</span>`;
  const label = `${u.label}: 5-hour ${pct(u.fiveHour)}, weekly ${pct(u.weekly)}`;
  const body = mode === 'rings'
    ? `${ringsSvg(u)}<span class="mlabel">${esc(u.label)}</span><span class="mnums">wk ${fig(u.weekly)}</span>`
    : `${barsSvg(u)}<span class="mlabel">${esc(u.label)}</span><span class="mnums"><span class="k">5h </span>${fig(u.fiveHour)}<span class="sep"> / </span><span class="k">wk </span>${fig(u.weekly)}</span>`;
  return `<button class="meter" data-account="${esc(u.account)}" title="${esc(u.email ?? '')}" aria-label="${esc(label)}">${body}</button>`;
}

function actionText(s: Session, now: number, usage?: AccountUsage): string {
  if (s.state === 'limit') return limitText(usage, now);
  let cache = '';
  if ((s.state === 'asleep' || s.state === 'needs-you') && s.cacheExpiresAt) {
    const left = s.cacheExpiresAt - now;
    if (left <= 0) cache = 'Cache expired';
    else if (left <= 5 * 60_000) cache = `Cache expires in ${Math.ceil(left / 60_000)} min`;
  }
  // A needs-you row always shows its question (spec §5.1); the cache warning goes in front of it.
  if (s.state === 'needs-you') return [cache, s.question ?? 'Waiting for you'].filter(Boolean).join(' · ');
  if (cache) return cache;
  if (s.state === 'stopped') return 'Stopped';
  // The transcript's last tool call is only a *current* action while the session works; once it is
  // asleep that call is history, so the row says it is waiting instead.
  if (s.state === 'asleep') return 'Waiting for the next prompt';
  return s.currentAction ?? '';
}

/**
 * Spec §5.1 grid view: a card per session with the character, name, state (colour and word), current action and
 * context %. A needs-you card shows the question (clamped) as the bubble that opens the answer sheet; offline and stopped cards are
 * styled like their rows.
 */
function card(s: Session, b: BoardState, now: number): string {
  const offline = s.hostOnline ? '' : `<div class="tag">offline · ${formatAge(now - s.lastSeen)} ago</div>`;
  return `<div class="gcard st-${s.state}${s.hostOnline ? '' : ' offline'}" data-key="${esc(s.key)}">
    <div class="char" data-state="${s.state}" data-key="${esc(s.key)}"><div class="ph"><i></i><i></i></div></div>
    <div class="gbody">${nameHtml(s)}
      <div class="gstate"><span class="word">${word(s)}</span><span class="gctx">${s.contextPct === undefined ? '–' : `${s.contextPct}%`}</span></div>
      ${actionHtml(s, actionText(s, now, b.usage.find((u) => u.account === s.account)))}${offline}${rowActionsHtml(s)}</div>
  </div>`;
}

/** A row's or card's name. A board nickname (Task 41) carries the session's own name as its tooltip. Long-press or right-click opens the rename sheet (rename.ts). */
const nameHtml = (s: Session) => `<div class="name"${s.derivedName === undefined ? '' : ` title="${esc(s.derivedName)}"`}>${esc(s.name)}</div>`;

function row(s: Session, b: BoardState, now: number): string {
  const acct = b.accounts.find((a) => a.id === s.account);
  const win = s.tmux ? s.tmux.split(':')[0] : '';
  const meta = [acct?.label ?? s.account, s.host, win].filter(Boolean).join(' · ');
  // The tag sits on its own (wrapping) line: inside the one-line, ellipsised .meta it got clipped at tablet widths.
  const offline = s.hostOnline ? '' : `<div class="tag">host offline · last seen ${formatAge(now - s.lastSeen)} ago</div>`;
  // The row's Open button gets its own cell, under the status word, never inside it (spec §5.1). Answering is the
  // question bubble itself (Task 36).
  const acts = rowActionsHtml(s);
  return `<div class="row st-${s.state}${s.hostOnline ? '' : ' offline'}" data-key="${esc(s.key)}">
    <div class="char" data-state="${s.state}" data-key="${esc(s.key)}"><div class="ph"><i></i><i></i></div></div>
    <div class="who">${nameHtml(s)}<div class="meta">${esc(meta)}</div>${offline}</div>
    ${actionHtml(s, actionText(s, now, b.usage.find((u) => u.account === s.account)))}
    <div class="ctx">${s.contextPct === undefined ? '–' : `${s.contextPct}%`}<span class="ctxbar"><span style="width:${s.contextPct ?? 0}%"></span></span></div>
    <div class="age">${formatAge(now - s.stateSince)}</div>
    <div class="word">${word(s)}</div>${acts ? `<div class="acts">${acts}</div>` : ''}
  </div>`;
}

/**
 * The top bar (spec §5.1): the clock with the date under it, the counts (each a filter button), one meter per account,
 * "+ New" and the cog. Double-tapping the clock or blank space toggles full screen (taps.ts); there is no button for it.
 */
/** Task 38: the switch under the cog shows the view a tap switches TO (a grid while the strips show, rows while the grid does). */
const VIEW_ICON: Record<Layout, string> = {
  grid: '<svg class="ico-grid" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><rect x="3" y="3" width="8" height="8" rx="1.5"/><rect x="13" y="3" width="8" height="8" rx="1.5"/><rect x="3" y="13" width="8" height="8" rx="1.5"/><rect x="13" y="13" width="8" height="8" rx="1.5"/></svg>',
  strips: '<svg class="ico-rows" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><rect x="3" y="3.5" width="18" height="4.5" rx="1.5"/><rect x="3" y="9.75" width="18" height="4.5" rx="1.5"/><rect x="3" y="16" width="18" height="4.5" rx="1.5"/></svg>',
};
export function viewButtonHtml(showing: Layout): string {
  const to: Layout = showing === 'grid' ? 'strips' : 'grid';
  return `<button class="view" data-act="view" data-to="${to}" aria-label="${to === 'grid' ? 'Grid view' : 'Strip view'}">${VIEW_ICON[to]}</button>`;
}

/** `showing`: the layout on screen (auto may have chosen it); without one, the stored choice. */
export function topBarHtml(b: BoardState | null, prefs: Prefs, d: Date, showing: Layout = prefs.layout === 'grid' ? 'grid' : 'strips'): string {
  const filter = prefs.filter ?? null;
  const counts = b ? COUNT_FILTERS.map((f) => {
    const n = b.sessions.filter((s) => s.state === f).length;
    return `<button class="count c-${f}${filter === f ? ' on' : ''}" data-filter="${f}" aria-pressed="${filter === f}"><b>${n}</b><span>${COUNT_LABEL[f]}</span></button>`;
  }).join('') : '';
  return `<div class="clock"><span class="time">${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })}</span>`
    + `<div class="date">${esc(formatDate(d))}</div></div>`
    + `<div class="counts">${counts}</div>`
    + `<div class="meters">${(b?.usage ?? []).map((u) => meterHtml(u, prefs.meters)).join('')}</div>`
    + `<button class="new" data-act="new">+ New</button><div class="side"><button class="cog" aria-label="Settings">⚙</button>${viewButtonHtml(showing)}</div>`;
}

/**
 * Draw the board. `b` is null until the first state message arrives: the top bar (clock, date, buttons) is drawn
 * anyway, with no counts or meters, and the strip says it is connecting rather than that nothing is running.
 */
export function renderBoard(root: HTMLElement, b: BoardState | null, prefs: Prefs, opts: RenderOpts = {}) {
  const now = Date.now() + (b?.clockSkew ?? 0);
  const filter = prefs.filter ?? null;
  // Keep <header> and the scrolling <main class="list"> alive across renders: rebuilding
  // the scroll container every tick would reset scrollTop and cut off a touch scroll.
  // Rows and cards are keyed and patched in place (reconcileRows), so each `.char` and its canvas survive.
  let top = root.querySelector<HTMLElement>('header.top');
  let list = root.querySelector<HTMLElement>('main.list');
  let probe = root.querySelector<HTMLElement>('.rowprobe');
  if (!top || !list || !probe) {
    root.innerHTML = '';
    top = document.createElement('header'); top.className = 'top';
    list = document.createElement('main'); list.className = 'list strips'; list.dataset.layout = 'strips';
    probe = document.createElement('div'); probe.className = 'rowprobe'; probe.setAttribute('aria-hidden', 'true');
    root.append(top, list, probe);
  }
  const st = layouts.get(root) ?? { layout: 'strips' as Layout, heights: new Map(), check: () => {} };
  layouts.set(root, st);
  top.innerHTML = topBarHtml(b, prefs, new Date(), st.layout);
  const sorted = b ? sortSessions(applyFilter(b.sessions, filter)) : [];
  const measure = opts.measure ?? domMetrics;
  const sig = (s: Session, row: number) => `${s.state}|${s.question ?? ''}|${row}`;
  const decide = (current: Layout) => {
    const m = measure(list, probe);
    const measured = new Map<string, number>();
    for (const s of sorted) { const h = st.heights.get(s.key); if (h && h.sig === sig(s, m.row)) measured.set(s.key, h.h); }
    return chooseLayout(prefs.layout ?? 'auto', current, stripsNeed(sorted, m.row, m.gap, measured), m.row > 0 ? m.avail : 0, m.row / 2);
  };
  // Two passes at most: drawing the strips measures their needs-you rows, which can show they do not fit after all.
  for (let pass = 0; pass < 2; pass++) {
    const layout = decide(st.layout);
    st.layout = layout;
    if (list.dataset.layout !== layout) {
      // A clean re-mount: the old rows (and their `.char` slots) leave the document, so the clay controller's
      // next sync() unmounts their characters and mounts one in each new card.
      list.replaceChildren();
      list.className = `list ${layout}`; list.dataset.layout = layout;
      list.scrollTop = 0;
    }
    const scroll = list.scrollTop;
    const items = b ? sorted.map((s) => ({ key: s.key, html: layout === 'grid' ? card(s, b, now) : row(s, b, now) })) : [];
    if (filter === 'stopped' && items.length) items.unshift({ key: CLEAR_ALL_KEY, html: CLEAR_ALL_HTML });
    const empty = !b ? 'Connecting…' : filter ? EMPTY_FILTERED[filter] : 'No sessions running';
    if (items.length) reconcileRows(list, items);
    else if (list.querySelector('.empty')?.textContent !== empty || list.children.length !== 1) list.innerHTML = `<div class="empty">${empty}</div>`;
    // Only write back if the update moved it; a no-op write can still stop a momentum scroll.
    if (list.scrollTop !== scroll) list.scrollTop = scroll;
    if (layout === 'grid') break;
    const rowPx = measure(list, probe).row;
    const els = new Map((Array.from(list.children) as HTMLElement[]).map((el) => [el.dataset.key, el]));
    for (const s of sorted) {
      const h = s.state === 'needs-you' ? els.get(s.key)?.offsetHeight ?? 0 : 0;
      if (h > 0) st.heights.set(s.key, { sig: sig(s, rowPx), h }); else st.heights.delete(s.key);
    }
    for (const k of [...st.heights.keys()]) if (!sorted.some((s) => s.key === k)) st.heights.delete(k);
    if (decide(layout) === layout) break;
  }
  // The switch was drawn for the layout before this render; this render may have changed it.
  const view = top.querySelector<HTMLElement>('.view');
  if (view && view.dataset.to === st.layout) view.outerHTML = viewButtonHtml(st.layout);
  st.check = () => { if (decide(st.layout) !== st.layout) opts.onRelayout?.(); };
  if (!observed.has(list) && typeof ResizeObserver === 'function') {
    observed.add(list);
    new ResizeObserver(() => layouts.get(root)?.check()).observe(list);
  }
}

/** The session a tap on the board landed on, when it landed on a row or a grid card. */
export function sessionKeyAt(target: Element): string | undefined {
  return target.closest<HTMLElement>('.row[data-key], .gcard[data-key]')?.dataset.key;
}

/**
 * Show `items` (one row's HTML per session key) in `strips`, in order, updating rows in place:
 * a row is created once, moved when the order changes, and removed when its session goes.
 * Only cells whose HTML changed are replaced, and a row's `.char` element is never replaced
 * (only its attributes change), so the clay character's canvas survives every render.
 */
export function reconcileRows(strips: HTMLElement, items: Array<{ key: string; html: string }>): void {
  const tpl = strips.ownerDocument.createElement('template');
  const existing = new Map<string, HTMLElement>();
  for (const el of Array.from(strips.children) as HTMLElement[]) {
    if ((el.classList.contains('row') || el.classList.contains('gcard') || el.classList.contains('clearbar')) && el.dataset.key !== undefined) existing.set(el.dataset.key, el);
    else el.remove(); // the "No sessions" message, or anything stray
  }
  let prev: Element | null = null;
  for (const { key, html } of items) {
    tpl.innerHTML = html.trim();
    const fresh = tpl.content.firstElementChild as HTMLElement;
    let el = existing.get(key);
    if (el) { existing.delete(key); patchRow(el, fresh); } else el = fresh;
    const at: Element | null = prev ? prev.nextElementSibling : strips.firstElementChild;
    if (at !== el) strips.insertBefore(el, at);
    prev = el;
  }
  for (const el of existing.values()) el.remove();
}

function patchRow(el: HTMLElement, fresh: HTMLElement): void {
  syncAttributes(el, fresh);
  const old = Array.from(el.children);
  const next = Array.from(fresh.children);
  next.forEach((n, i) => {
    const o = old[i];
    if (!o) el.appendChild(n);
    else if (o.classList.contains('char') && n.classList.contains('char')) syncAttributes(o, n);
    else if (o.outerHTML !== n.outerHTML) o.replaceWith(n);
  });
  for (let i = next.length; i < old.length; i++) old[i].remove();
}

function syncAttributes(a: Element, b: Element): void {
  for (const { name } of Array.from(a.attributes)) if (!b.hasAttribute(name)) a.removeAttribute(name);
  for (const { name, value } of Array.from(b.attributes)) if (a.getAttribute(name) !== value) a.setAttribute(name, value);
}

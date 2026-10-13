import type { SessionSummary } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';
import type { BoardState } from './board.js';
import { clayStateFor, type ClayController } from './clay/index.js';
import { buttonsHtml, feedHtml, minisHtml, shellHtml, statsHtml, summaryHtml, updateHeader } from './focus-view.js';
import { focusModel } from './focus-model.js';
import { getJson } from './net.js';
import { pushOverlay } from './overlay.js';
import { initRenameGestures } from './rename.js';

export interface FocusCtx {
  sessionKey: string;
  getState(): BoardState | null;
  clay: ClayController;
  ttlMinutes(): number;
  /** Button actions, handled by the app (answer sheet, message sheet, open, attach). */
  onAction(action: 'answer' | 'message' | 'open' | 'attach', session: Session): void;
  onSwitch(key: string): void;
  /** Task 42a: a long-press or right-click on the title opens the rename sheet for this session (as on the board). */
  rename?(key: string): (() => void) | void;
}

/** Opens only when a row is tapped. Tap outside, the ×, or Android Back closes it. */
export function openFocus(ctx: FocusCtx): () => void {
  const el = document.createElement('section');
  el.className = 'focus modal';
  const find = (key: string) => ctx.getState()?.sessions.find((s) => s.key === key);
  const first = find(ctx.sessionKey);
  if (!first) return () => {};
  let summary: SessionSummary | null = null;
  let stopLarge: (() => void) | undefined;
  let stopMinis: (() => void)[] = [];
  let minisKey = '';
  let timer: number | undefined;
  let poll: number | undefined;
  let closed = false;
  let stopRename: (() => void) | undefined;
  const label = (s: Session) => ctx.getState()?.accounts.find((a) => a.id === s.account)?.label ?? s.account;
  const close = pushOverlay(el, () => { closed = true; clearInterval(timer); clearInterval(poll); stopLarge?.(); stopMinis.forEach((f) => f()); stopRename?.(); });
  el.innerHTML = shellHtml(focusModel(first, null, Date.now(), label(first)));
  stopLarge = ctx.clay.mountLarge(el.querySelector<HTMLElement>('#f-char')!, first);

  const refresh = () => {
    if (closed) return;                      // a late /api/summary reply after close
    const s = find(ctx.sessionKey);
    if (!s) { close(); return; }               // the session went away
    const st = ctx.getState()!;
    const now = Date.now() + st.clockSkew;
    const v = focusModel(s, summary, now, label(s));
    updateHeader(el, v);
    el.querySelector('#f-stats')!.innerHTML = statsHtml(v);
    el.querySelector('#f-feed')!.innerHTML = feedHtml(v);
    el.querySelector('#f-sum')!.innerHTML = summaryHtml(v);
    el.querySelector('#f-btns')!.innerHTML = buttonsHtml(v);
    // the small cards are rebuilt only when the set of other sessions or their animations change
    const others = st.sessions.filter((o) => o.key !== s.key).slice(0, 8);
    const sig = others.map((o) => `${o.key}:${clayStateFor(o, now, ctx.ttlMinutes()).id}`).join('|');
    if (sig !== minisKey) {
      minisKey = sig;
      stopMinis.forEach((f) => f());
      const box = el.querySelector<HTMLElement>('#f-minis')!;
      box.innerHTML = minisHtml(others);
      stopMinis = others.map((o) => {
        const slot = box.querySelector<HTMLElement>(`.mini-char[data-key="${CSS.escape(o.key)}"]`)!;
        const c = clayStateFor(o, now, ctx.ttlMinutes());
        return ctx.clay.mountState(slot, c.id, { puffed: c.puffed });
      });
    }
  };
  const load = async () => {
    const r = await getJson<{ ok: boolean; summary?: SessionSummary }>(`/api/summary?sessionId=${encodeURIComponent(ctx.sessionKey)}`);
    if (r?.ok && r.summary) { summary = r.summary; refresh(); }
  };
  // Before the click handler below: the click a long-press ends with is swallowed there.
  if (ctx.rename) stopRename = initRenameGestures(el, { names: '.who h2', keyOf: () => ctx.sessionKey, open: ctx.rename });
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    const s = find(ctx.sessionKey);
    if (b.dataset.act === 'close') close();
    else if (b.dataset.act === 'focus' && b.dataset.key) { close(); ctx.onSwitch(b.dataset.key); }
    else if (s && (b.dataset.act === 'answer' || b.dataset.act === 'message' || b.dataset.act === 'open' || b.dataset.act === 'attach')) ctx.onAction(b.dataset.act, s);
  });
  refresh(); void load();
  timer = window.setInterval(refresh, 1000);
  poll = window.setInterval(() => void load(), 5000);
  return close;
}

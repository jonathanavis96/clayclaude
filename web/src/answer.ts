import type { SessionSummary } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';
import { afterMessage, afterReread, afterSend, fromRead, messageSheet, pendingFor, waitOutcome, type ReadOk, type Sheet } from './answer-model.js';
import { MAX_CHARS, renderSheet } from './answer-view.js';
import { getJson, postAction } from './net.js';
import { pushOverlay, toast } from './overlay.js';

export interface AnswerCtx {
  session: Session;
  getSession(): Session | undefined;
  confirmBeforeSend(): boolean;
  quickReplies(): string[];
  /** For the "no response" fallback. */
  act(action: 'open' | 'attach', session: Session): void;
}

export function openAnswerSheet(ctx: AnswerCtx): void {
  const el = document.createElement('section');
  el.className = 'sheet answer';
  let sheet: Sheet = { phase: 'loading' };
  let draft = '';
  let timer: number | undefined;
  const close = pushOverlay(el, () => { clearInterval(timer); });
  const draw = () => {
    const keep = el.querySelector<HTMLTextAreaElement>('#reply-text');
    if (keep) draft = keep.value;
    el.innerHTML = renderSheet(sheet, ctx.session, ctx.quickReplies(), draft);
    // A permission sheet holds the whole screen; the prompt is at its bottom, as in the terminal, so start there.
    const screen = el.querySelector<HTMLElement>('pre.verbatim');
    if (screen) screen.scrollTop = screen.scrollHeight;
  };
  const read = async () => {
    sheet = { phase: 'loading' }; draw();
    sheet = fromRead(await postAction({ action: 'prompt', sessionId: ctx.session.key }));
    draw();
  };
  const send = async (v: { choice?: string; text?: string }) => {
    if (sheet.phase !== 'ready' && sheet.phase !== 'confirm') return;
    const prev = sheet;
    const prompt = prev.prompt;
    sheet = { phase: 'sending' }; draw();
    const body = v.choice !== undefined
      ? { action: 'answer', sessionId: ctx.session.key, promptHash: prompt.hash, choice: v.choice }
      : { action: 'answer', sessionId: ctx.session.key, promptHash: prompt.hash, text: v.text };
    sheet = afterSend(await postAction(body), prev, Date.now(), ctx.getSession());
    draw();
    if (sheet.phase === 'waiting') {
      let reading = false;
      timer = window.setInterval(() => {
        if (sheet.phase !== 'waiting' || reading) return;
        const o = waitOutcome(sheet, ctx.getSession(), Date.now());
        if (o === 'done') { clearInterval(timer); toast('Answered'); close(); return; }
        if (o !== 'reread') return;
        // The session changed (or the wait ran out): read the screen. A different prompt is its next question.
        reading = true;
        const w = sheet;
        void postAction<ReadOk>({ action: 'prompt', sessionId: ctx.session.key }).then((r) => {
          reading = false;
          if (sheet !== w) return;
          sheet = afterReread(r, w, ctx.getSession(), Date.now());
          if (sheet.phase !== 'waiting') { clearInterval(timer); draw(); }
        });
      }, 500);
    }
  };
  const want = (v: { choice?: string; text?: string }) => {
    if (sheet.phase !== 'ready') return;
    if (v.text !== undefined && v.text.trim() === '') return;
    if (v.text !== undefined && v.text.length > MAX_CHARS) { toast(`Replies are limited to ${MAX_CHARS} characters`, 'error'); return; }
    if (ctx.confirmBeforeSend()) { sheet = { phase: 'confirm', prompt: sheet.prompt, context: sheet.context, pending: pendingFor(sheet.prompt, v) }; draw(); } else void send(v);
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': close(); break;
      case 'choose': want({ choice: b.dataset.key }); break;
      case 'quick': want({ text: b.dataset.text }); break;
      case 'send-text': want({ text: el.querySelector<HTMLTextAreaElement>('#reply-text')?.value ?? '' }); break;
      case 'confirm-yes': if (sheet.phase === 'confirm') void send(sheet.pending.choice !== undefined ? { choice: sheet.pending.choice } : { text: sheet.pending.text }); break;
      case 'confirm-no': if (sheet.phase === 'confirm') { sheet = { phase: 'ready', prompt: sheet.prompt, context: sheet.context }; draw(); } break;
      case 'retry': void read(); break;
      case 'open-pc': ctx.act('open', ctx.session); break;
      case 'attach-pc': ctx.act('attach', ctx.session); break;
    }
  });
  el.addEventListener('focusin', (e) => { if ((e.target as HTMLElement).id === 'reply-text') setTimeout(() => (e.target as HTMLElement).scrollIntoView({ block: 'nearest' }), 250); });
  void read();
}

export interface MessageCtx { session: Session; confirmBeforeSend(): boolean; quickReplies(): string[] }

/**
 * Task 43: Message on an idle session. The answer sheet's reply box, quick replies and confirm step; the daemon types the
 * text and Enter only through the idle gate (src/actions/message.ts), and a refusal shows its reason here, the draft kept.
 */
export function openMessageSheet(ctx: MessageCtx): void {
  const el = document.createElement('section');
  el.className = 'sheet answer';
  let sheet: Sheet = messageSheet();
  let draft = '';
  const close = pushOverlay(el, () => {});
  const draw = () => {
    const keep = el.querySelector<HTMLTextAreaElement>('#reply-text');
    if (keep) draft = keep.value;
    el.innerHTML = renderSheet(sheet, ctx.session, ctx.quickReplies(), draft, 'message');
  };
  // The session's last reply, for context, once it arrives (the sheet is usable before).
  void getJson<{ ok: boolean; summary?: SessionSummary }>(`/api/summary?sessionId=${encodeURIComponent(ctx.session.key)}`).then((r) => {
    const last = r?.ok ? r.summary?.lastAssistantText : undefined;
    if (!last || (sheet.phase !== 'ready' && sheet.phase !== 'confirm')) return;
    sheet = { ...sheet, context: { ...sheet.context, lastAssistantText: last } };
    draw();
  });
  const send = async (text: string) => {
    if (sheet.phase !== 'ready' && sheet.phase !== 'confirm') return;
    const prev = sheet;
    sheet = { phase: 'sending' }; draw();
    const r = afterMessage(await postAction<{ sent: string }>({ action: 'message', sessionId: ctx.session.key, text }), prev);
    if (r === 'sent') { toast('Message sent'); close(); return; }
    sheet = r; draw();
  };
  const want = (text: string) => {
    if (sheet.phase !== 'ready' || text.trim() === '') return;
    if (text.length > MAX_CHARS) { toast(`Messages are limited to ${MAX_CHARS} characters`, 'error'); return; }
    if (ctx.confirmBeforeSend()) { sheet = { phase: 'confirm', prompt: sheet.prompt, context: sheet.context, pending: pendingFor(sheet.prompt, { text }) }; draw(); } else void send(text);
  };
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
    if (!b) return;
    switch (b.dataset.act) {
      case 'close': close(); break;
      case 'quick': want(b.dataset.text ?? ''); break;
      case 'send-text': want(el.querySelector<HTMLTextAreaElement>('#reply-text')?.value ?? ''); break;
      case 'confirm-yes': if (sheet.phase === 'confirm') void send(sheet.pending.text ?? ''); break;
      case 'confirm-no': if (sheet.phase === 'confirm') { sheet = { phase: 'ready', prompt: sheet.prompt, context: sheet.context }; draw(); } break;
    }
  });
  el.addEventListener('focusin', (e) => { if ((e.target as HTMLElement).id === 'reply-text') setTimeout(() => (e.target as HTMLElement).scrollIntoView({ block: 'nearest' }), 250); });
  draw();
}

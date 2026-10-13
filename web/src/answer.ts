import type { Session } from '../../src/types.js';
import { afterSend, fromRead, pendingFor, waitOutcome, type Sheet } from './answer-model.js';
import { MAX_CHARS, renderSheet } from './answer-view.js';
import { postAction } from './net.js';
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
    sheet = afterSend(await postAction(body), prev, Date.now());
    draw();
    if (sheet.phase === 'waiting') {
      timer = window.setInterval(() => {
        if (sheet.phase !== 'waiting') return;
        const o = waitOutcome(sheet, ctx.getSession(), Date.now());
        if (o === 'done') { clearInterval(timer); toast('Answered'); close(); } else if (o.phase === 'noresponse') { sheet = o; clearInterval(timer); draw(); }
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

import type { PromptView } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';
import { showQuickReplies, type Sheet } from './answer-model.js';
import { esc } from './html.js';

export const MAX_CHARS = 4000;

export function renderSheet(s: Sheet, session: Session, quick: string[], draft: string): string {
  const head = `<header class="sheet-head"><b>${esc(session.name)}</b><span class="muted">${esc(session.account)} · ${esc(session.host)}</span><button class="x" data-act="close" aria-label="Close">×</button></header>`;
  const body = (() => {
    switch (s.phase) {
      case 'loading': return '<p class="muted">Reading the screen…</p>';
      case 'sending': return '<p class="muted">Sending…</p>';
      case 'waiting': return '<p>Sent. Waiting for the session to respond…</p>';
      case 'noresponse': return `<p class="warn">No response from the session.</p><div class="row-btns"><button data-act="open-pc">Open</button><button data-act="attach-pc">Attach tmux</button></div>`;
      case 'error': return `<p class="warn">${esc(s.message)}</p><div class="row-btns"><button data-act="retry">Try again</button><button data-act="open-pc">Open</button><button data-act="attach-pc">Attach tmux</button></div>`;
      case 'confirm': return `<p>Send <b>${esc(s.pending.label.slice(0, 200))}</b>?</p><div class="row-btns"><button class="primary" data-act="confirm-yes">Send</button><button data-act="confirm-no">Cancel</button></div>`;
      case 'ready': return readyHtml(s.prompt, s.context, s.notice, quick, draft);
    }
  })();
  return `${head}<div class="sheet-body">${body}</div>`;
}

function readyHtml(p: PromptView, c: { question?: string; lastAssistantText?: string }, notice: string | undefined, quick: string[], draft: string): string {
  const ctx = [c.lastAssistantText ? `<blockquote class="last">${esc(c.lastAssistantText.slice(-600))}</blockquote>` : '',
    p.detail ? `<pre class="detail">${esc(p.detail)}</pre>` : ''].join('');
  const ask = p.kind === 'menu' ? `<p class="ask">${esc(p.title || c.question || 'Choose an option')}</p>` : `<p class="ask">${esc(c.question || 'Reply to the session')}</p>`;
  const note = notice ? `<p class="warn">${esc(notice)}</p>` : '';
  if (p.kind === 'menu') {
    return `${note}${ctx}${ask}<div class="choices">${p.options.map((o) =>
      `<button class="choice${o.selected ? ' sel' : ''}" data-act="choose" data-key="${esc(o.key)}"><span class="n">${esc(o.key)}</span><span>${esc(o.label)}${o.description ? `<small>${esc(o.description)}</small>` : ''}</span></button>`).join('')}</div>`;
  }
  return `${note}${ctx}${ask}
    ${showQuickReplies(p) ? `<div class="chips">${quick.map((q) => `<button class="chip" data-act="quick" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="reply"><textarea id="reply-text" rows="2" maxlength="${MAX_CHARS}" placeholder="Type a reply">${esc(draft)}</textarea><button class="primary" data-act="send-text">Send</button></div>`;
}

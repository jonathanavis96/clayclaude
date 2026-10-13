import type { PromptView } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';
import { permissionHeading, showQuickReplies, type Sheet } from './answer-model.js';
import { esc, screenText } from './html.js';

export const MAX_CHARS = 4000;

/** `mode` message: the sheet for a new message to an idle session (Task 43); only the reply box's placeholder differs. */
export function renderSheet(s: Sheet, session: Session, quick: string[], draft: string, mode: 'answer' | 'message' = 'answer'): string {
  const head = `<header class="sheet-head"><b>${esc(session.name)}</b><span class="muted">${esc(session.account)} · ${esc(session.host)}</span><button class="x" data-act="close" aria-label="Close">×</button></header>`;
  const body = (() => {
    switch (s.phase) {
      case 'loading': return '<p class="muted">Reading the screen…</p>';
      case 'sending': return '<p class="muted">Sending…</p>';
      case 'waiting': return '<p>Sent. Waiting for the session to respond…</p>';
      case 'noresponse': return `<p class="warn">No response from the session.</p><div class="row-btns"><button data-act="open-pc">Open</button><button data-act="attach-pc">Attach tmux</button></div>`;
      case 'error': return `<p class="warn">${esc(s.message)}</p><div class="row-btns"><button data-act="retry">Try again</button><button data-act="open-pc">Open</button><button data-act="attach-pc">Attach tmux</button></div>`;
      case 'confirm': return `<p>Send <b>${screenText(s.pending.label.slice(0, 200))}</b>?</p><div class="row-btns"><button class="primary" data-act="confirm-yes">Send</button><button data-act="confirm-no">Cancel</button></div>`;
      case 'ready': return readyHtml(s.prompt, s.context, s.notice, quick, draft, mode === 'message' ? 'Type a message' : 'Type a reply');
    }
  })();
  return `${head}<div class="sheet-body">${body}</div>`;
}

const note = (notice: string | undefined) => (notice ? `<p class="warn">${esc(notice)}</p>` : '');

function readyHtml(p: PromptView, c: { question?: string; lastAssistantText?: string }, notice: string | undefined, quick: string[], draft: string, placeholder: string): string {
  const ctx = [c.lastAssistantText ? `<blockquote class="last">${screenText(c.lastAssistantText.slice(-600))}</blockquote>` : '',
    p.detail ? `<pre class="detail">${screenText(p.detail)}</pre>` : ''].join('');
  if (p.kind === 'permission') {
    // At most two answers, whatever the screen shows: Yes sends 1, No sends Escape. Yes is offered only when Claude's
    // option 1 on screen is a plain "Yes" (pane.ts). The prompt is shown as the terminal draws it, so what is being
    // approved is read there, not in any parsed option. The heading is Claude's, never the model's (permissionHeading).
    const yes = p.options.some((o) => o.key === 'yes');
    return `${note(notice)}${c.lastAssistantText ? `<blockquote class="last">${screenText(c.lastAssistantText.slice(-600))}</blockquote>` : ''}
      <p class="ask">${esc(permissionHeading(c.question))}</p>
      <pre class="detail verbatim">${screenText(p.detail)}</pre>
      <div class="choices perm${yes ? '' : ' one'}">${p.options.map((o) => `<button class="choice" data-act="choose" data-key="${esc(o.key)}"><span>${esc(o.label)}</span></button>`).join('')}</div>
      <p class="muted pc-note">${yes ? 'Other choices, such as "don\'t ask again", are on the PC.'
        : 'Yes is not offered here: Claude\'s first option is not a plain "Yes" (approving a plan this way also changes the session\'s permission mode). Approve it on the PC.'}</p>
      <div class="row-btns"><button data-act="open-pc">Open</button><button data-act="attach-pc">Attach tmux</button></div>`;
  }
  const ask = p.kind === 'menu' ? `<p class="ask">${screenText(p.title || c.question || 'Choose an option')}</p>` : `<p class="ask">${screenText(c.question || 'Reply to the session')}</p>`;
  if (p.kind === 'menu') {
    return `${note(notice)}${ctx}${ask}<div class="choices">${p.options.map((o) =>
      `<button class="choice${o.selected ? ' sel' : ''}" data-act="choose" data-key="${esc(o.key)}"><span class="n">${esc(o.key)}</span><span>${screenText(o.label)}${o.description ? `<small>${screenText(o.description)}</small>` : ''}</span></button>`).join('')}</div>`;
  }
  return `${note(notice)}${ctx}${ask}
    ${showQuickReplies(p) ? `<div class="chips">${quick.map((q) => `<button class="chip" data-act="quick" data-text="${esc(q)}">${esc(q)}</button>`).join('')}</div>` : ''}
    <div class="reply"><textarea id="reply-text" rows="2" maxlength="${MAX_CHARS}" placeholder="${placeholder}">${esc(draft)}</textarea><button class="primary" data-act="send-text">Send</button></div>`;
}

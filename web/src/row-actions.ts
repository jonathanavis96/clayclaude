import type { Session } from '../../src/types.js';
import { esc } from './html.js';

type ActionSession = Pick<Session, 'key' | 'state' | 'tmux' | 'bridgeSessionId' | 'hostOnline' | 'starting'>;
const canAnswer = (s: ActionSession) => s.state === 'needs-you' && s.hostOnline && !!s.tmux;
/** Task 43: an idle session in tmux, on a host that is online, that is not still starting. */
export const canMessage = (s: ActionSession) => s.state === 'asleep' && s.hostOnline && !!s.tmux && !s.starting;

/**
 * The button under a row's status word. A stopped session gets Clear (spec §5.1, UI round 4): it hides the row and
 * lets the daemon remove the dead registry file where safe; offline too, since the daemon hides it either way.
 * A needs-you session in tmux has none: its question bubble is the one answer control (Task 36, device rule 4).
 * A session with no tmux pane (for example one running only in the desktop app) shows Open instead (spec §8.1),
 * when it has a remote-control link. An idle (asleep) session in tmux gets Message (Task 43): the reply sheet, for a new
 * prompt; the daemon types it only through the idle gate (src/actions/message.ts).
 */
export function rowActionsHtml(s: ActionSession): string {
  if (s.state === 'stopped') return `<button class="clear-btn" data-act="clear" data-key="${esc(s.key)}">Clear</button>`;
  if (canMessage(s)) return `<button class="answer-btn" data-act="message" data-key="${esc(s.key)}">Message</button>`;
  if (s.state !== 'needs-you' || !s.hostOnline || s.tmux) return '';
  if (s.bridgeSessionId) return `<button class="answer-btn" data-act="open" data-key="${esc(s.key)}">Open</button>`;
  return '';
}

/**
 * A row's or card's action line. For a session that can be answered it is the question bubble: a real button that
 * opens the answer sheet, labelled with the question (Task 36). Otherwise it is plain text.
 */
export function actionHtml(s: ActionSession, text: string): string {
  if (!canAnswer(s)) return `<div class="action">${esc(text)}</div>`;
  return `<button class="action qbubble" data-act="answer" data-key="${esc(s.key)}" aria-label="${esc(`Answer: ${text}`)}"><span>${esc(text)}</span></button>`;
}

import type { PromptView, Result } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';

export const RESPONSE_TIMEOUT_MS = 10_000;

export interface Context { question?: string; lastAssistantText?: string }
export type Sheet =
  | { phase: 'loading' }
  | { phase: 'ready'; prompt: PromptView; context: Context; notice?: string }
  | { phase: 'confirm'; prompt: PromptView; context: Context; pending: Pending }
  | { phase: 'sending' }
  | { phase: 'waiting'; since: number; hash: string; question?: string; stateSince?: number }
  | { phase: 'noresponse' }
  | { phase: 'error'; message: string };

export interface Pending { choice?: string; text?: string; label: string }

export type ReadOk = { prompt: PromptView; question?: string; lastAssistantText?: string };

export function fromRead(r: Result<ReadOk>): Sheet {
  if (!r.ok) return { phase: 'error', message: r.message };
  return { phase: 'ready', prompt: r.prompt, context: { question: r.question, lastAssistantText: r.lastAssistantText } };
}

export function pendingFor(prompt: PromptView, v: { choice?: string; text?: string }): Pending {
  if (v.choice !== undefined) return { choice: v.choice, label: prompt.options.find((o) => o.key === v.choice)?.label ?? `option ${v.choice}` };
  return { text: v.text, label: v.text ?? '' };
}

type Waiting = Extract<Sheet, { phase: 'waiting' }>;

/**
 * Result of tapping send. A changed prompt goes back to `ready` with the fresh prompt and nothing was sent. A sent answer
 * waits, remembering the prompt it answered and the session's question as it was, to tell a new question from no response.
 */
export function afterSend(r: Result<{ sent: string }>, prev: Extract<Sheet, { phase: 'ready' | 'confirm' }>, now: number, session?: Session): Sheet {
  if (r.ok) return { phase: 'waiting', since: now, hash: prev.prompt.hash, question: session?.question, stateSince: session?.stateSince };
  // A fresh prompt comes back with prompt_changed, duplicate and bad_request. A `none` prompt (the session moved
  // on and nothing is waiting) is not something to answer: show the message instead of an empty reply box.
  if (r.prompt && r.prompt.kind !== 'none') return { phase: 'ready', prompt: r.prompt, context: prev.context, notice: r.error === 'prompt_changed' ? 'The prompt changed, so nothing was sent. Check it and answer again.' : r.message };
  return { phase: 'error', message: r.message };
}

/**
 * While waiting after a send: 'done' once the session leaves needs-you; 'reread' (read the screen again, then
 * afterReread) when its question or the time it started waiting changes, or after RESPONSE_TIMEOUT_MS.
 */
export function waitOutcome(s: Waiting, session: Session | undefined, now: number): Sheet | 'done' | 'reread' {
  if (!session || session.state !== 'needs-you') return 'done';
  if (session.question !== s.question || session.stateSince !== s.stateSince) return 'reread';
  return now - s.since >= RESPONSE_TIMEOUT_MS ? 'reread' : s;
}

/**
 * After reading the screen again while waiting. A different prompt is the session's response: one answer can lead
 * straight to the next question (the next tool's permission), and the sheet shows it. The same prompt (or none) keeps
 * waiting, the session's change taken in, until RESPONSE_TIMEOUT_MS: then "No response from the session".
 */
export function afterReread(r: Result<ReadOk>, w: Waiting, session: Session | undefined, now: number): Sheet {
  if (r.ok && r.prompt.kind !== 'none' && r.prompt.hash !== w.hash)
    return { phase: 'ready', prompt: r.prompt, context: { question: r.question, lastAssistantText: r.lastAssistantText }, notice: 'Answered. The session has a new question.' };
  if (now - w.since >= RESPONSE_TIMEOUT_MS) return { phase: 'noresponse' };
  return { ...w, question: session?.question, stateSince: session?.stateSince };
}

/**
 * Claude Code's own permission Notification ("Claude needs your permission to use Bash"). Only the tool's name is taken
 * from it, and only when it is a plain identifier.
 */
const TOOL_NOTE = /^Claude needs your permission to use ([A-Za-z][A-Za-z0-9_.:-]{0,79})$/;
/**
 * The permission sheet's bold heading. Neutral: never text the model wrote (a command, a tool's description or argument,
 * the pending tool's summary), at most the tool's name from Claude Code's own Notification.
 */
export function permissionHeading(question?: string): string {
  const m = question ? TOOL_NOTE.exec(question) : null;
  return m ? `Claude asks for permission to use ${m[1]}` : 'Claude asks for permission';
}

/**
 * Task 43: the message sheet for an idle session: the answer sheet's reply box, quick replies and confirm step, ready at
 * once (no question is on screen to read; the daemon reads the screen itself, just before it types, through the idle gate).
 */
export const MESSAGE_PROMPT: PromptView = Object.freeze({ kind: 'text', hash: '', title: '', detail: '', options: [], quickReplies: [] }) as PromptView;
export function messageSheet(lastAssistantText?: string): Extract<Sheet, { phase: 'ready' }> {
  return { phase: 'ready', prompt: MESSAGE_PROMPT, context: { question: 'New message to this session', lastAssistantText } };
}
/** After sending a message: 'sent' closes the sheet; a refusal shows its reason over the same reply box (nothing was sent). */
export function afterMessage(r: Result<{ sent: string }>, prev: Extract<Sheet, { phase: 'ready' | 'confirm' }>): Sheet | 'sent' {
  return r.ok ? 'sent' : { phase: 'ready', prompt: prev.prompt, context: prev.context, notice: r.message };
}

/** Quick replies are chips only for free-text prompts. */
export const showQuickReplies = (p: PromptView) => p.kind === 'text';

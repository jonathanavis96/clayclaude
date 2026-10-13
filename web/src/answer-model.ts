import type { PromptView, Result } from '../../src/actions/types.js';
import type { Session } from '../../src/types.js';

export const RESPONSE_TIMEOUT_MS = 10_000;

export interface Context { question?: string; lastAssistantText?: string }
export type Sheet =
  | { phase: 'loading' }
  | { phase: 'ready'; prompt: PromptView; context: Context; notice?: string }
  | { phase: 'confirm'; prompt: PromptView; context: Context; pending: Pending }
  | { phase: 'sending' }
  | { phase: 'waiting'; since: number }
  | { phase: 'noresponse' }
  | { phase: 'error'; message: string };

export interface Pending { choice?: string; text?: string; label: string }

type ReadOk = { prompt: PromptView; question?: string; lastAssistantText?: string };

export function fromRead(r: Result<ReadOk>): Sheet {
  if (!r.ok) return { phase: 'error', message: r.message };
  return { phase: 'ready', prompt: r.prompt, context: { question: r.question, lastAssistantText: r.lastAssistantText } };
}

export function pendingFor(prompt: PromptView, v: { choice?: string; text?: string }): Pending {
  if (v.choice !== undefined) return { choice: v.choice, label: prompt.options.find((o) => o.key === v.choice)?.label ?? `option ${v.choice}` };
  return { text: v.text, label: v.text ?? '' };
}

/** Result of tapping send. A changed prompt goes back to `ready` with the fresh prompt and nothing was sent. */
export function afterSend(r: Result<{ sent: string }>, prev: Extract<Sheet, { phase: 'ready' | 'confirm' }>, now: number): Sheet {
  if (r.ok) return { phase: 'waiting', since: now };
  // A fresh prompt comes back with prompt_changed, duplicate and bad_request. A `none` prompt (the session moved
  // on and nothing is waiting) is not something to answer: show the message instead of an empty reply box.
  if (r.prompt && r.prompt.kind !== 'none') return { phase: 'ready', prompt: r.prompt, context: prev.context, notice: r.error === 'prompt_changed' ? 'The prompt changed, so nothing was sent. Check it and answer again.' : r.message };
  return { phase: 'error', message: r.message };
}

/** After a successful send: 'done' once the session leaves needs-you, the "no response" sheet after 10 s. */
export function waitOutcome(s: Extract<Sheet, { phase: 'waiting' }>, session: Session | undefined, now: number): Sheet | 'done' {
  if (!session || session.state !== 'needs-you') return 'done';
  return now - s.since >= RESPONSE_TIMEOUT_MS ? { phase: 'noresponse' } : s;
}

/** Quick replies are chips only for free-text prompts. */
export const showQuickReplies = (p: PromptView) => p.kind === 'text';

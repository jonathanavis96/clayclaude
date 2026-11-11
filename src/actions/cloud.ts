// Board actions on a Claude Code cloud session (key `cloud:<id>`): its prompt is read from the CloudPoller's cache,
// and answers go through the probe's `cloud-answer` mode on an account's own host, which re-checks the request there
// before it posts anything.
import type { AccountConfig, Config } from '../config.js';
import type { Session } from '../types.js';
import type { CloudPoller } from '../cloud/poller.js';
import { pendingRequest, type CloudEntry } from '../cloud/reduce.js';
import type { CloudAnswerReply, CloudRequest } from '../cloud/types.js';
import { extractTranscript } from '../core/transcript.js';
import { cleanText, type SendGuard } from './answer.js';
import { promptHash } from './hash.js';
import { chromeCmd, claudeUrl, openerPrefix, type Cmd } from './open.js';
import { PERMISSION_NO_ONLY, PERMISSION_OPTIONS } from './pane.js';
import type { PlatformEnv } from './platform.js';
import type { ProbeFn } from './launch.js';
import { fail, type AnswerRequest, type Fail, type MessageRequest, type PromptView, type Result } from './types.js';
import { ActionError, RE } from './validate.js';

export interface CloudDeps { cfg: Config; cloud: Pick<CloudPoller, 'entry' | 'accountsFor' | 'poke'>; probe: ProbeFn; guard: SendGuard }

/** What cloud-answer is asked to send. */
type CloudAnswer =
  | { kind: 'allow'; requestId: string; fromId: string | null; inputHash: string }
  | { kind: 'deny'; requestId: string; fromId: string | null }
  | { kind: 'choice'; requestId: string; fromId: string | null; label: string }
  | { kind: 'text'; text: string };

const ANSWER_BUDGET_MS = 12_000;
const UNSUPPORTED_ASK = 'This question has several parts or lets you pick more than one. Answer it on claude.ai.';
/** The longest permission detail shown; the probe sends inputs up to the same size (CLOUD_INPUT_MAX), plus labels. */
export const CLOUD_DETAIL_MAX = 10_000;

/**
 * A tool input as the person reads it: the tool's name, then every field, each value whole. A one-line string
 * is `key: value`; a multi-line one is `key:` then its lines; anything else is indented JSON. Pure.
 */
export function inputDetail(name: string, input: unknown): string {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return `${name}\n${JSON.stringify(input ?? null, null, 2)}`;
  const rows = Object.entries(input as Record<string, unknown>).map(([k, v]) => {
    const text = typeof v === 'string' ? v : JSON.stringify(v, null, 2) ?? String(v);
    return text.includes('\n') ? `${k}:\n${text}` : `${k}: ${text}`;
  });
  return [name, ...rows].join('\n');
}

/** The request's input cannot be shown whole, so it cannot be approved here. */
const isCut = (p: CloudRequest, detail: string) => p.truncated === true || typeof p.inputHash !== 'string' || detail.length > CLOUD_DETAIL_MAX;

/** The prompt the answer sheet shows for a cloud session. Pure. */
export function cloudPrompt(s: Session, e: CloudEntry, quickReplies: string[]): PromptView | Fail {
  const p = pendingRequest(e);
  if (p && p.toolName === 'AskUserQuestion') {
    const qs = (p.input as { questions?: unknown } | null)?.questions;
    const q = Array.isArray(qs) && qs.length === 1 ? (qs[0] as Record<string, unknown> | null) : undefined;
    const opts = Array.isArray(q?.options) ? (q!.options as unknown[]) : [];
    const labels = opts.map((o) => (o && typeof (o as { label?: unknown }).label === 'string' ? (o as { label: string }).label : ''));
    const question = typeof q?.question === 'string' ? q.question : '';
    if (!q || q.multiSelect === true || !question || !labels.length || labels.some((l) => !l)) return fail('unsupported', UNSUPPORTED_ASK);
    return { kind: 'menu', title: question, detail: '', quickReplies: [], hash: promptHash(['cloud', p.requestId, question, ...labels]),
      options: opts.map((o, i) => {
        const d = (o as { description?: unknown }).description;
        return { key: String(i + 1), label: labels[i], ...(typeof d === 'string' && d ? { description: d } : {}), selected: false };
      }) };
  }
  if (p) {
    // Everything Yes approves is shown (the host sends back the input it re-reads, checked against inputHash); what
    // cannot be shown whole is approved on claude.ai, never here.
    const full = inputDetail(p.displayName ?? p.toolName, p.input);
    const cut = isCut(p, full);
    const detail = cut ? full.slice(0, CLOUD_DETAIL_MAX) : full;
    return { kind: 'permission', title: '', detail, options: (cut ? PERMISSION_NO_ONLY : PERMISSION_OPTIONS).map((o) => ({ ...o })), quickReplies: [],
      hash: promptHash(['cloud', p.requestId, p.toolName, p.inputHash ?? '', cut ? 'cut' : 'whole', detail]), ...(cut ? { cut: true as const } : {}) };
  }
  if (e.raw.status === 'idle')
    return { kind: 'text', title: '', detail: '', options: [], quickReplies, hash: promptHash(['cloud-text', s.sessionId, String(s.stateSince)]) };
  if (e.raw.status === 'requires_action') return fail('no_prompt', 'The question has not been read yet. Try again in a few seconds.');
  return fail('no_prompt', 'The session is working. Nothing is waiting for you.');
}

function prompt(d: CloudDeps, s: Session): { e: CloudEntry; v: PromptView | Fail } | Fail {
  const e = d.cloud.entry(s.sessionId);
  if (!e) return fail('unknown_session', 'that session is no longer listed');
  const v = cloudPrompt(s, e, d.cfg.ui.quickReplies);
  // Waiting on a question the poller has not read yet: read it on the next tick.
  if ('ok' in v && e.raw.status === 'requires_action' && !pendingRequest(e)) d.cloud.poke(s.sessionId);
  return { e, v };
}

export function cloudReadPrompt(d: CloudDeps, s: Session): Result<{ prompt: PromptView; lastAssistantText?: string; question?: string }> {
  const r = prompt(d, s);
  if ('ok' in r) return r;
  if ('ok' in r.v) return r.v;
  const text = extractTranscript(r.e.lines).lastAssistantText;
  return { ok: true, prompt: r.v, ...(text ? { lastAssistantText: text } : {}), ...(s.question ? { question: s.question } : {}) };
}

export async function cloudAnswer(d: CloudDeps, s: Session, req: AnswerRequest): Promise<Result<{ sent: string }>> {
  const lock = `cloud\0${s.sessionId}`;
  if (!d.guard.begin(lock)) return fail('duplicate', 'An answer to this session is already being sent.');
  try {
    const r = prompt(d, s);
    if ('ok' in r) return r;
    const v = r.v;
    if ('ok' in v) return v;
    if (v.hash !== req.promptHash) return fail('prompt_changed', 'The prompt changed. Nothing was sent.', v);
    if (d.guard.isRepeat(lock, v.hash)) return fail('duplicate', 'That answer was just sent. Wait for the session to respond.', v);
    let answer: CloudAnswer;
    let sent: string;
    const p = pendingRequest(r.e);
    if (v.kind === 'text') {
      if (typeof req.text !== 'string') return fail('bad_request', 'this prompt takes a typed reply');
      const t = cleanText(req.text);
      if (typeof t !== 'string') return t;
      answer = { kind: 'text', text: t };
      sent = `reply (${t.length} characters)`;
    } else if (!p) {
      return fail('prompt_changed', 'The prompt changed. Nothing was sent.');
    } else if (v.kind === 'permission') {
      if (req.choice !== 'yes' && req.choice !== 'no') return fail('bad_request', 'answer Yes or No');
      const inputHash = p.inputHash;
      if (req.choice === 'yes') {
        // Refused here as well as left off the sheet: a cut input is approved only on claude.ai.
        if (v.cut || !v.options.some((o) => o.key === 'yes') || typeof inputHash !== 'string')
          return fail('bad_request', 'This request is too long to show here in full. Approve it on claude.ai.');
        answer = { kind: 'allow', requestId: p.requestId, fromId: p.prevId, inputHash };
      } else answer = { kind: 'deny', requestId: p.requestId, fromId: p.prevId };
      sent = req.choice === 'yes' ? 'Yes' : 'No';
    } else {
      const o = v.options.find((x) => x.key === req.choice);
      if (!o) return fail('bad_request', 'that is not one of the options');
      answer = { kind: 'choice', requestId: p.requestId, fromId: p.prevId, label: o.label };
      sent = o.label;
    }
    const out = await send(d, s, answer);
    if (!out.ok) return out;
    d.guard.sent(lock, v.hash);
    return { ok: true, sent };
  } finally {
    d.guard.end(lock);
  }
}

/** A new message to a cloud session that is not working and not waiting on a question. */
export async function cloudMessage(d: CloudDeps, s: Session, req: MessageRequest): Promise<Result<{ sent: string }>> {
  const e = d.cloud.entry(s.sessionId);
  if (!e) return fail('unknown_session', 'that session is no longer listed');
  if (!(s.state === 'asleep' || (s.state === 'needs-you' && !pendingRequest(e))))
    return fail('no_prompt', 'The session is working or waiting on a question. Nothing was sent.');
  const text = cleanText(req.text);
  if (typeof text !== 'string') return text;
  const lock = `cloud\0${s.sessionId}`;
  if (!d.guard.begin(lock)) return fail('duplicate', 'Something is already being sent to this session.');
  try {
    const repeat = `message\0${text}`;
    if (d.guard.isRepeat(lock, repeat)) return fail('duplicate', 'A message was just sent to this session. Wait for it to respond.');
    const out = await send(d, s, { kind: 'text', text });
    if (!out.ok) return out;
    d.guard.sent(lock, repeat);
    return { ok: true, sent: `message (${text.length} characters)` };
  } finally {
    d.guard.end(lock);
  }
}

/**
 * Ask each account whose login lists the session, owner first, until a host answers. A host that cannot be reached,
 * or an account whose token has expired, passes to the next; any other answer is final, since the host has re-checked
 * the session and either posted or refused.
 */
async function send(d: CloudDeps, s: Session, answer: CloudAnswer): Promise<Result> {
  const accounts = d.cloud.accountsFor(s.sessionId);
  const text = answer.kind === 'text';
  let authError: string | undefined;
  const unreachable: string[] = [];
  for (const a of accounts) {
    const host = d.cfg.hosts.find((h) => h.id === a.host);
    if (!host) continue;
    let r: CloudAnswerReply;
    try {
      r = (await d.probe(host, { mode: 'cloud-answer', configDir: a.configDir, sessionId: s.sessionId, answer, budgetMs: ANSWER_BUDGET_MS })) as CloudAnswerReply;
    } catch {
      unreachable.push(host.id);
      continue;
    }
    if (r && r.ok === true) { d.cloud.poke(s.sessionId); return { ok: true }; }
    const code = r && r.ok === false ? r.code : undefined;
    const why = r && r.ok === false && typeof r.error === 'string' ? r.error.split('\n')[0].slice(0, 200) : 'no answer from the host';
    if (code === 'auth') { authError ??= why; continue; }
    d.cloud.poke(s.sessionId);
    if (code === 'gone') return fail('prompt_changed', text ? 'That session was archived. Nothing was sent.' : 'That question was already answered or cancelled. Nothing was sent.');
    if (code === 'changed') return fail('prompt_changed', 'The request changed since it was shown. Nothing was sent.');
    if (code === 'not_pending') return fail('prompt_changed', text ? 'The session is now waiting on a question. Nothing was sent.' : 'That question was already answered or cancelled. Nothing was sent.');
    if (code === 'busy') return fail('no_prompt', 'The session is working. Nothing was sent.');
    if (code === 'bad_choice') return fail('bad_request', why);
    if (code === 'http' && r.ok === false && r.status === 429) return fail('rate_limited', 'claude.ai is rate limiting this account. Try again in a minute.');
    return fail('failed', why);
  }
  if (authError) return fail('failed', authError);
  return fail('host_offline', unreachable.length ? `Could not reach ${unreachable.join(', ')}. Nothing was sent.` : 'No account can reach this session.');
}

/** Opens the session's page on claude.ai: in the account's Chrome profile, else with the OS opener (never the app link). */
export function cloudOpenCmd(cfg: Config, env: PlatformEnv, account: AccountConfig, sessionId: string): Cmd {
  if (!RE.bridgeId.test(sessionId)) throw new ActionError('bad_request', 'malformed cloud session id');
  if (account.open.type === 'chrome') return chromeCmd(cfg, account, sessionId);
  const [bin, ...pre] = openerPrefix(cfg, env);
  return { bin, args: [...pre, claudeUrl(sessionId)] };
}

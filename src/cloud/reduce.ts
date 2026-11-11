// Pure: merge what the probe read about one cloud session into the daemon's cache, and map the cache to a Session.
import type { Session, SessionState } from '../types.js';
import { extractTranscript } from '../core/transcript.js';
import { lastPromptsOf, mergePrompts, saidText } from '../core/prompts.js';
import type { CloudRaw, CloudRequest } from './types.js';

export const MAX_LINES = 60;

export interface CloudEntry {
  raw: CloudRaw;                       // latest list fields (events stripped)
  lines: string[];                     // newest MAX_LINES trimmed lines, oldest first
  requests: CloudRequest[];            // unresolved, oldest first
  afterId?: string;                    // events.lastId
  /** raw.updatedAt once its events are read; '' forces a re-read (events.more, or none read yet). */
  updatedAt: string;
  lastResultAt?: number;               // ms
}

const ms = (s: string | undefined): number | undefined => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : undefined;
};

export function mergeEntry(prev: CloudEntry | undefined, raw: CloudRaw): CloudEntry {
  const { events, ...list } = raw;
  if (!events) {
    // Unchanged since the last read, or not read this poll: keep what was read, and its updatedAt, so a session
    // whose events were skipped is read next time.
    return { raw: list, lines: prev?.lines ?? [], requests: prev?.requests ?? [], afterId: prev?.afterId,
      updatedAt: prev?.updatedAt ?? '', lastResultAt: prev?.lastResultAt };
  }
  const resolved = new Set(events.resolved);
  const seen = new Set<string>();
  const requests = [...(prev?.requests ?? []), ...events.requests].filter((r) => {
    if (resolved.has(r.requestId) || seen.has(r.requestId)) return false;
    seen.add(r.requestId);
    return true;
  });
  return {
    raw: list,
    lines: [...(prev?.lines ?? []), ...events.lines].slice(-MAX_LINES),
    requests,
    afterId: events.lastId ?? prev?.afterId,
    updatedAt: events.more ? '' : raw.updatedAt,
    lastResultAt: ms(events.lastResultAt) ?? prev?.lastResultAt,
  };
}

/** The request to answer: the oldest, and only while the list says the session is waiting on one. */
export function pendingRequest(e: CloudEntry): CloudRequest | undefined {
  if (e.raw.status !== 'requires_action' || !e.requests.length) return undefined;
  return [...e.requests].sort((a, b) => (ms(a.createdAt) ?? 0) - (ms(b.createdAt) ?? 0))[0];
}

/** The question text of an AskUserQuestion request's first question. */
export function askQuestionOf(r: CloudRequest): string | undefined {
  const q = (r.input as any)?.questions?.[0]?.question;
  return typeof q === 'string' && q ? q : undefined;
}

export function cloudSession(e: CloudEntry, o: { account: string; host: string; hostOnline: boolean; lastSeen: number;
  origin?: string; originTask?: string; prompts?: string[] }): Session {
  const r = e.raw;
  const info = extractTranscript(e.lines);
  const p = pendingRequest(e);
  const updated = ms(r.updatedAt) ?? o.lastSeen;
  let state: SessionState;
  let stateSince: number;
  let question: string | undefined;
  const flags: Pick<Session, 'permission' | 'busy' | 'idle'> = {};
  if (r.status === 'requires_action') {
    state = 'needs-you';
    stateSince = (p && ms(p.createdAt)) ?? updated;
    if (p && p.toolName === 'AskUserQuestion') question = askQuestionOf(p);
    else if (p) { question = `Claude needs your permission to use ${p.toolName}`; flags.permission = true; }
  } else if (r.status === 'running') {
    state = 'working';
    stateSince = info.lastPromptAt ?? ms(r.createdAt) ?? updated;
    flags.busy = true;
  } else if (r.status === 'idle') {
    // Needs you only on a pending request; a finished turn is asleep, read or not (Jonathan, 2026-11-11).
    state = 'asleep';
    stateSince = e.lastResultAt ?? updated;
    flags.idle = true;
  } else {
    state = 'asleep';
    stateSince = updated;
  }
  const s: Session = {
    key: 'cloud:' + r.id, host: o.host, account: o.account, sessionId: r.id, pid: 0,
    name: r.title || 'Cloud session', cwd: '', state, stateSince, live: true,
    overContext: false, hostOnline: o.hostOnline, lastSeen: o.lastSeen, cloud: true, ...flags,
  };
  if (r.model) s.model = r.model;
  if (r.effort) s.effort = r.effort;
  if (r.repo) s.repo = r.repo;
  if (o.origin) s.origin = o.origin;
  if (o.originTask) s.originTask = o.originTask;
  if (question) s.question = question;
  if (info.currentAction) s.currentAction = info.currentAction;
  if (info.lastAssistantAt !== null) s.lastAssistantAt = info.lastAssistantAt;
  if (info.lastPromptAt !== null) s.lastPromptAt = info.lastPromptAt;
  const prompts = mergePrompts(o.prompts, lastPromptsOf(e.lines));
  if (prompts.length) s.lastPrompts = prompts;
  const said = saidText(info.lastAssistantText);
  if (said) s.lastSaid = said;
  if (typeof r.contextUsed === 'number' && typeof r.contextMax === 'number' && r.contextMax > 0) {
    s.contextPct = Math.round((r.contextUsed / r.contextMax) * 100);
    s.contextTokens = r.contextUsed;
    s.contextWindow = r.contextMax;
    s.overContext = s.contextPct >= 85;
  }
  return s;
}

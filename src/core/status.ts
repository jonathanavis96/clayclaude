import { basename } from 'node:path';
import type { ContextRecord, RawRegistry, Session, SessionState } from '../types.js';
import { extractTranscript } from './transcript.js';

export interface HookEvent { event: string; sessionId: string; ts: number; message?: string }

/** Epoch milliseconds from a time in ms or in seconds; undefined unless it lands between 2001 and 5138. */
export function epochMs(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
  const t = v < 1e11 ? v * 1000 : v;
  return t >= 1e12 && t < 1e14 ? t : undefined;
}

export function parseEvents(lines: string[]): HookEvent[] {
  const out: HookEvent[] = [];
  for (const l of lines) {
    try {
      const e = JSON.parse(l);
      if (typeof e?.event !== 'string' || typeof e.sessionId !== 'string') continue;
      const ts = epochMs(e.ts);
      if (ts === undefined) continue; // a garbage stamp would pin needs-you or compacting until that date
      out.push({ event: e.event, sessionId: e.sessionId, ts,
        ...(typeof e.message === 'string' ? { message: e.message } : {}) });
    } catch { /* skip */ }
  }
  return out;
}

const IDLE_NOTE = /waiting for your input/i;
/** Claude Code's permission Notification: "Claude needs your permission to use <tool>". */
const PERMISSION_NOTE = /needs your permission/i;

export function contextWindowFor(model: string | undefined, windows: Record<string, number> & { default: number }): number {
  if (!model) return windows.default;
  if (model.endsWith('[1m]')) return 1_000_000;
  const key = Object.keys(windows).filter((k) => k !== 'default' && model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return key ? windows[key] : windows.default;
}

export interface DeriveInput {
  host: string; account: string; reg: RawRegistry; events: HookEvent[];
  usageExhausted: boolean; cacheTtlMinutes: number;
  contextWindows: Record<string, number> & { default: number };
  hostOnline: boolean; lastSeen: number;
  /**
   * Keys of sessions seen past their configured window before (the collector's, kept while they are on the board). One
   * seen now is added; one in it stays on the 1M window after the turn that showed it has left the transcript tail.
   */
  wide?: Set<string>;
  /** The status line bridge's record for this session, if the probe found one. */
  context?: ContextRecord;
  /** The account's auto-compact window: Claude Code compacts there, so a smaller one is the window the session really has. */
  compactWindow?: number;
}

const baseModel = (m: string) => m.replace(/\[1m\]$/, '');

/**
 * The bridge record's window, when it can be trusted: the record is for this session, its window is a sane number, and it
 * is not from before a switch to another model (a record names the model it was taken on; one older than the latest
 * response, on a different model, is stale until the status line redraws).
 */
function recordedWindow(rec: ContextRecord | undefined, sessionId: string, model: string | undefined, lastResponseAt: number | null): number | undefined {
  if (!rec || rec.sessionId !== sessionId) return undefined;
  const w = rec.contextWindowSize;
  if (typeof w !== 'number' || !Number.isInteger(w) || w <= 0 || w > 100_000_000) return undefined;
  const stale = model !== undefined && typeof rec.model === 'string' && baseModel(rec.model) !== baseModel(model)
    && (lastResponseAt === null || !(rec.ts >= lastResponseAt));
  return stale ? undefined : w;
}

const str = (v: unknown) => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
/** Registry times are epoch ms; one written in seconds is read as seconds, not as a date in January 1970. */
const msOf = (v: unknown) => { const n = num(v); return n === undefined ? undefined : n < 1e11 ? n * 1000 : n; };
const allow = (p: { name: string; summary: string }) => (p.summary ? `Allow ${p.name}: ${p.summary}?` : `Allow ${p.name}?`);

export function deriveSession(i: DeriveInput, now: number): Session | null {
  const d = i.reg.data;
  const pid = num(d?.pid), sessionId = str(d?.sessionId);
  if (!d || pid === undefined || !sessionId) return null;
  const t = extractTranscript(i.reg.transcript);
  // A resumed session keeps its id under a new process: hook events and unresolved tool calls from before this
  // process started belong to the dead one and cannot be waiting on the user now.
  const startedAt = msOf(d.startedAt);
  const mine = i.events.filter((e) => e.sessionId === sessionId && (startedAt === undefined || e.ts >= startedAt));
  const promptLive = t.lastAssistantAt === null || startedAt === undefined || t.lastAssistantAt >= startedAt;
  const pendingTool = promptLive ? t.pendingTool : undefined;
  const latest = (name: string) => mine.filter((e) => e.event === name).at(-1);
  const after = (ts: number, ref: number | null) => ref === null || ts > ref;

  let state: SessionState;
  let stateSince: number;
  let question: string | undefined;
  const steady = msOf(d.statusUpdatedAt) ?? t.lastEntryAt ?? startedAt ?? now;

  const pre = latest('PreCompact');
  // Claude Code's idle "waiting for your input" Notification fires for every finished turn: that is asleep, not needs-you.
  const note = mine.filter((e) => e.event === 'Notification' && !IDLE_NOTE.test(e.message ?? '')).at(-1);
  // A user entry (prompt, or a tool_result from a denial) or a busy status written after it means it was answered.
  const busyAt = d.status === 'busy' ? msOf(d.statusUpdatedAt) ?? null : null;
  const answered = (ts: number) => !after(ts, t.lastUserAt) || !after(ts, busyAt);
  if (!i.reg.live) {
    state = 'stopped'; stateSince = msOf(d.updatedAt) ?? i.reg.mtimeMs;
  } else if (i.usageExhausted || t.limitHit) {
    state = 'limit'; stateSince = t.lastAssistantAt ?? steady;
  } else if (pre && after(pre.ts, t.lastAssistantAt) && after(pre.ts, t.lastCompactAt) && after(pre.ts, t.lastUserAt)) {
    // Nothing is written to the transcript while compaction runs; a later user entry means it failed or was cancelled.
    state = 'compacting'; stateSince = pre.ts;
  } else if (note && after(note.ts, t.lastAssistantAt) && !answered(note.ts)) {
    state = 'needs-you'; stateSince = note.ts; question = note.message;
  } else if (t.askQuestion && promptLive) {
    state = 'needs-you'; stateSince = t.lastAssistantAt ?? steady; question = t.askQuestion;
  } else if (d.status === 'waiting' && d.waitingFor !== 'dialog open') {
    // Claude Code (2.1.x) writes status "waiting" with waitingFor "permission prompt" or "input needed" while a
    // tool waits on the user; "dialog open" is a dialog the user opened, so they are already at the keyboard.
    state = 'needs-you'; stateSince = msOf(d.statusUpdatedAt) ?? t.lastAssistantAt ?? steady;
    if (pendingTool) question = allow(pendingTool);
  } else if (pendingTool && d.status === 'idle') {
    state = 'needs-you'; stateSince = t.lastAssistantAt ?? steady;
    question = allow(pendingTool);
  } else if (d.status === 'busy' || (t.lastEntryAt !== null && Math.abs(now - t.lastEntryAt) < 20_000)) {
    // abs: an entry stamped far ahead of now (the host clock stepped back) is not recent activity.
    state = 'working'; stateSince = steady;
  } else {
    state = 'asleep'; stateSince = steady;
  }

  // A pending permission, from what Claude Code itself writes (never the screen, which the model can shape): its registry
  // waits on a tool's approval (waitingFor is "input needed" for AskUserQuestion and MCP input, "dialog open" for a dialog
  // the user opened; anything else, or nothing, counts), its permission Notification has not been followed by any later
  // event or an answer, or (older versions) a tool call is unresolved while it reports idle. The answer sheet then
  // offers only Yes / No.
  // Claude Code 2.1.296 also sends "Claude needs your permission" 6 s into an AskUserQuestion menu: that note is not a
  // permission while the registry says it waits for input, or the tool waiting on the user is AskUserQuestion.
  const askPending = d.waitingFor === 'input needed' || pendingTool?.name === 'AskUserQuestion';
  const permNote = askPending ? undefined : mine.filter((e) => e.event === 'Notification' && PERMISSION_NOTE.test(e.message ?? '')).at(-1);
  const permission = i.reg.live && (
    (d.status === 'waiting' && d.waitingFor !== 'input needed' && d.waitingFor !== 'dialog open')
    || (permNote !== undefined && !answered(permNote.ts) && !mine.some((e) => e.ts > permNote.ts))
    || (pendingTool !== undefined && d.status === 'idle' && !t.askQuestion));

  // Claude working, from what Claude Code itself writes (pane.ts, PaneSignals.busy): its registry status, or for an
  // older Claude Code that writes none, the state derived above.
  const busy = i.reg.live && (d.status === 'busy' || state === 'compacting' || (d.status === undefined && state === 'working'));

  // Idle and waiting for a new prompt (Session.idle), from what Claude Code itself writes: its hook events when it sent
  // any for this process (the last one Stop, or SessionStart with nothing after it; the idle "waiting for your input"
  // note follows every finished turn and is not counted), with no prompt in the transcript since and no other registry
  // status; without hook events, its registry status. A permission or question Notification, PreCompact, SessionEnd or a
  // UserPromptSubmit last is not idle.
  const relevant = mine.filter((e) => !(e.event === 'Notification' && IDLE_NOTE.test(e.message ?? '')));
  const lastEvent = [...relevant].sort((a, b) => a.ts - b.ts).at(-1);
  const idleSignal = lastEvent
    ? (lastEvent.event === 'Stop' || lastEvent.event === 'SessionStart') && after(lastEvent.ts, t.lastUserAt) && (d.status === undefined || d.status === 'idle')
    : d.status === 'idle';
  const idle = i.reg.live && state === 'asleep' && !permission && !busy && idleSignal;

  // The window: the status line bridge's record when there is one (Claude Code's own figure). Otherwise a guess:
  // transcripts never carry the "[1m]" suffix, so a session seen past its configured window (now, or before a
  // compaction still in the tail) must be on the 1M one.
  // A session seen past it once stays on 1M (i.wide), since a compaction ends up scrolling out of the tail.
  const key = `${i.host}:${i.account}:${sessionId}`;
  const configured = contextWindowFor(t.model, i.contextWindows);
  if (t.peakTokens !== null && t.peakTokens > configured) i.wide?.add(key);
  const recorded = recordedWindow(i.context, sessionId, t.model, t.lastResponseAt);
  const modelWindow = recorded ?? ((t.peakTokens !== null && t.peakTokens > configured) || i.wide?.has(key) ? Math.max(configured, 1_000_000) : configured);
  // An auto-compact window below the model's is where the session really ends (Claude Code's own percentage ignores it).
  const cap = i.compactWindow;
  const window = typeof cap === 'number' && Number.isInteger(cap) && cap > 0 && cap < modelWindow ? cap : modelWindow;
  // Tokens: the transcript's latest turn, which is what Claude Code's own used_percentage is computed from (input +
  // cache writes + cache reads of the last response), but re-read every poll and including compaction boundaries; the
  // record's copy only moves when the status line redraws. The record's count fills in when the tail has no turn.
  const recTokens = recorded !== undefined && typeof i.context?.totalInputTokens === 'number' && Number.isFinite(i.context.totalInputTokens) && i.context.totalInputTokens >= 0
    ? i.context.totalInputTokens : null;
  const tokens = t.contextTokens ?? recTokens;
  const contextPct = tokens === null ? undefined : Math.min(100, Math.round((100 * tokens) / window));
  const cwd = str(d.cwd) ?? '';
  return {
    key,
    host: i.host, account: i.account, sessionId, pid,
    name: str(d.name) ?? t.aiTitle ?? (basename(cwd) || sessionId.slice(0, 8)),
    cwd, state, stateSince, live: i.reg.live,
    tmux: str(d.tmux), bridgeSessionId: str(d.bridgeSessionId),
    model: t.model, effort: t.effort, contextPct,
    ...(tokens !== null ? { contextTokens: tokens } : {}), contextWindow: window,
    currentAction: t.currentAction, question,
    lastAssistantAt: t.lastAssistantAt ?? undefined,
    ...(t.lastPromptAt !== null ? { lastPromptAt: t.lastPromptAt } : {}),
    cacheExpiresAt: t.lastResponseAt === null ? undefined : t.lastResponseAt + i.cacheTtlMinutes * 60_000,
    overContext: (contextPct ?? 0) >= 85,
    hostOnline: i.hostOnline, lastSeen: i.lastSeen,
    ...(isBackground(d.entrypoint, i.reg.headless) && { background: true as const }),
    ...(permission ? { permission: true as const } : {}),
    ...(busy ? { busy: true as const } : {}),
    ...(idle ? { idle: true as const } : {}),
  };
}

/**
 * Task 45: a headless helper (print mode `claude -p`, the Agent SDK), not a session anyone works in. Claude Code
 * records how it was started in the registry's `entrypoint`; without one, the probe's argv check decides.
 */
const SDK_ENTRYPOINTS = new Set(['sdk-cli', 'sdk-ts', 'sdk-py']);
function isBackground(entrypoint: unknown, headless: boolean | undefined): boolean {
  return typeof entrypoint === 'string' ? SDK_ENTRYPOINTS.has(entrypoint) : headless === true;
}

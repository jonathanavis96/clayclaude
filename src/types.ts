export type SessionState = 'stopped' | 'limit' | 'compacting' | 'needs-you' | 'working' | 'asleep';

/** One registry file as returned by the probe. `data` is null when the file failed to parse. */
export interface RawRegistry {
  file: string;
  mtimeMs: number;
  data: Record<string, unknown> | null;
  live: boolean;
  transcript: string[]; // trimmed JSONL lines, oldest first; [] when not live or not found, or when `same`
  /** Transcript file signature (size:mtime_ns), when one was found. */
  tsig?: string;
  /** The caller's `known` signature matched, so `transcript` was not re-sent. */
  same?: boolean;
  /** Over the snapshot's byte or time budget: not read this time (no `tsig`); keep the last tail and ask again. */
  deferred?: boolean;
  /** Live, no `entrypoint` in the registry, and its argv is print mode or stream-json (Task 45). */
  headless?: boolean;
}

export interface ProbeDir {
  configDir: string;
  registries: RawRegistry[];
  events: string[]; // lines of <configDir>/clayclaude/events.jsonl (tail)
  /** Status line bridge records of the sessions in `registries`, by session id; absent when there are none. */
  contexts?: Record<string, ContextRecord>;
  /** The account's auto-compact window from settings.json (autoCompactWindow, or CLAUDE_CODE_AUTO_COMPACT_WINDOW in its env), when set. */
  compactWindow?: number;
}

/** What the status line bridge keeps per session (<configDir>/clayclaude/context/<sessionId>.json), from Claude Code itself. */
export interface ContextRecord {
  sessionId: string;
  /** When these values were first seen (epoch ms); the record is rewritten only when they change. */
  ts: number;
  /** The session's context window, as Claude Code reports it to its status line. */
  contextWindowSize: number;
  usedPercentage?: number | null;
  totalInputTokens?: number | null;
  /** Claude Code's model id, with "[1m]" when the session is on the 1M window. */
  model?: string;
}

export interface ProbeSnapshot { ok: true; nowMs: number; dirs: ProbeDir[] }

export interface UsageWindow { utilization: number | null; resets_at: string | null }
export interface UsageEntry {
  configDir: string;
  key?: string;           // the account id, echoed from the request
  ts?: string;            // meter-log: when the meter took the reading
  held?: string;          // token: the host held the call ("lapsed": no five-hour window is running)
  idle?: boolean;         // meter-log: no claude run on the account since the reading's five-hour reset
  ok: boolean;
  error?: string;
  status?: number;        // HTTP status of a failed call (429: rate limited)
  retryAfterS?: number;   // its Retry-After, in seconds
  email?: string | null;
  name?: string;          // `.claude.json` oauthAccount.displayName, when present
  plan?: string;          // its organizationType ("claude_max"), when present
  planTier?: string;      // its rate-limit tier ("default_claude_max_20x"), when present
  five_hour?: UsageWindow | null;
  seven_day?: UsageWindow | null;
}
export interface ProbeUsage { ok: true; accounts: UsageEntry[] }

export interface Session {
  key: string;            // `${host}:${account}:${sessionId}`
  host: string;
  account: string;
  sessionId: string;
  pid: number;
  name: string;
  /** Set only when the board shows a nickname in `name` (Task 41): the session's own name, for Reset and tooltips. */
  derivedName?: string;
  cwd: string;
  state: SessionState;
  stateSince: number;     // ms epoch
  live: boolean;
  tmux?: string;
  bridgeSessionId?: string;
  model?: string;
  effort?: string;
  contextPct?: number;    // 0..100
  /** Tokens in the context now (the latest turn's input, cache reads and cache writes), when known. */
  contextTokens?: number;
  /** The context window contextPct is measured against: the status line bridge's, else the configured or inferred one. */
  contextWindow?: number;
  currentAction?: string;
  question?: string;
  lastAssistantAt?: number;
  /** When the person last typed a prompt into the session (ms epoch); the tablet sleeps after a long gap (tablet-sleep.ts). */
  lastPromptAt?: number;
  cacheExpiresAt?: number;
  overContext: boolean;   // contextPct >= 85 (X2 modifier)
  hostOnline: boolean;
  lastSeen: number;
  /**
   * Started from the board, and Claude has not registered a session for it yet (Task 40). The row stands for the
   * launched tmux pane: `sessionId` is a placeholder, `pid` is the pane's process.
   */
  starting?: true;
  /** A headless helper (`claude -p`, the Agent SDK), hidden from the board unless the person asks (Task 45). */
  background?: true;
  /**
   * Claude Code itself reports a pending permission prompt: its registry says it waits on one (status "waiting", for
   * anything but "input needed" or "dialog open"), or its "needs your permission" Notification hook has not been
   * followed by a later event or an answer. The answer sheet then offers only Yes / No, whatever the screen shows.
   */
  permission?: true;
  /**
   * Claude Code itself reports the session working: its registry status is "busy", it is compacting, or (an older Claude
   * Code that writes no status) its state is working. A typed reply is still sent then (Claude Code queues it); the
   * answer sheet treats the input box as busy (pane.ts, textView).
   */
  busy?: true;
  /**
   * Claude Code itself reports the session idle and waiting for a new prompt (Tasks 43 and 42, the idle gate's first
   * condition; never the screen). With hook events for the session: its last one is Stop, or SessionStart with nothing
   * after it (the idle "waiting for your input" note aside), no prompt is in the transcript since, and the registry, if it
   * writes a status, says idle. Without hook events: the registry status is idle. Only for a live, asleep session with no
   * permission pending and not busy.
   */
  idle?: true;
}

export interface AccountUsage {
  account: string;
  label: string;
  colour: string;
  email?: string | null;
  /** The account holder's name, when the account's `.claude.json` has it. */
  name?: string | null;
  /** The plan ("Max 20x"), when the account's `.claude.json` says; null rather than a guess. */
  plan?: string | null;
  fiveHour: number | null;   // 0..100
  weekly: number | null;
  fiveHourResetsAt: string | null;
  weeklyResetsAt: string | null;
  stale: boolean;
  updatedAt: number | null;
}

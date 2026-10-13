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
  currentAction?: string;
  question?: string;
  lastAssistantAt?: number;
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

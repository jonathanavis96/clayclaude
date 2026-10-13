/** Shared contract between the action backend, the routes, the demo and the web client. */

export type ErrorCode =
  | 'bad_request' | 'unknown_session' | 'unknown_account' | 'forbidden' | 'host_offline'
  | 'no_tmux' | 'no_bridge' | 'no_prompt' | 'pane_gone' | 'prompt_changed' | 'too_long'
  | 'duplicate' | 'rate_limited' | 'unsupported' | 'failed' | 'live';

export interface PromptOption { key: string; label: string; selected: boolean; description?: string }

export interface PromptView {
  kind: 'menu' | 'text' | 'none';
  /** Changes whenever the prompt on screen changes. Echoed back with the answer. */
  hash: string;
  title: string;
  /** What is being asked about, e.g. the command text of a permission prompt. */
  detail: string;
  options: PromptOption[];
  quickReplies: string[];
  /**
   * Claude's folder-trust question (Task 40). Its options carry no numbers, so an option is picked by moving the
   * cursor from the selected one with arrow keys and pressing Enter, never by typing its key.
   */
  trust?: true;
}

export type Fail = { ok: false; error: ErrorCode; message: string; prompt?: PromptView };
export type Result<T extends object = object> = ({ ok: true } & T) | Fail;

export type AnswerRequest =
  | { sessionId: string; promptHash: string; choice: string; text?: undefined }
  | { sessionId: string; promptHash: string; text: string; choice?: undefined };

export interface LaunchRequest {
  account: string;
  repo: string;
  /** `name` (Task 42a): passed to claude as `--name`, cleaned and checked like a board nickname, and the session's board name. */
  options: {
    model?: string; effort?: string; remoteControl?: boolean; openOnPc?: boolean; name?: string;
    /** Task 46: `--permission-mode`. bypassPermissions also needs `confirmBypass` (the tablet's confirm step) and the config's allowBypassPermissions. */
    permissionMode?: string; confirmBypass?: boolean;
  };
}

export interface LaunchAccountOptions {
  id: string; label: string; colour: string; host: string;
  canLaunch: boolean;
  reason?: string;
  /**
   * Task 46: `models` is the newest model of each family (Opus, Sonnet, Haiku, Fable), `moreModels` every other one, for
   * the More ▾ list; `modelNames` their display names (an id without one shows as itself).
   */
  models: string[]; moreModels?: string[]; modelNames?: Record<string, string>;
  efforts: string[]; remoteControl: boolean;
  /** Task 46: the permission modes offered besides Manual, in order. */
  modes?: string[];
  /** Task 47: the mode preselected (launch.defaultMode when offered here, else '' for Manual). */
  defaultMode?: string;
}
export interface LaunchOptions { accounts: LaunchAccountOptions[] }

export interface RepoEntry { path: string; name: string; lastUsedMs: number }

export interface ToolEvent { at: number | null; name: string; target: string }
export interface SessionSummary {
  lastPrompt?: string;
  lastAssistantText?: string;
  files: string[];
  tools: ToolEvent[];
  toolCount: number;
  /** Summed over the transcript tail only (the last ~256 KB), not the whole session. */
  tokensIn: number;
  tokensOut: number;
  startedAt?: number;
}

export interface ActionApi {
  open(sessionId: string): Promise<Result<{ message: string }>>;
  attach(sessionId: string): Promise<Result<{ message: string }>>;
  readPrompt(sessionId: string): Promise<Result<{ prompt: PromptView; lastAssistantText?: string; question?: string }>>;
  answer(req: AnswerRequest): Promise<Result<{ sent: string }>>;
  launch(req: LaunchRequest): Promise<Result<{ message: string; target?: string }>>;
  launchOptions(): Promise<LaunchOptions>;
  repos(accountId: string): Promise<Result<{ repos: RepoEntry[] }>>;
  summary(sessionId: string): Promise<Result<{ summary: SessionSummary }>>;
  /** Hide a stopped session for good and remove its dead registry files where safe (spec §5.1). `removed`: files removed. */
  clear(sessionId: string): Promise<Result<{ message: string; removed: number }>>;
  /** `clear` for every stopped session. */
  clearStopped(): Promise<Result<{ message: string; cleared: number; removed: number }>>;
  /**
   * Sets the session's board nickname (Task 41), or clears it with null (back to the derived name). It never sends keys
   * to the session and never renames Claude's session name. With `tmux` (Task 42a, off unless asked) it also renames
   * the session's tmux window to the resulting name with `tmux rename-window`; `tmuxError` says why that failed, if it did
   * (the board name is saved either way).
   */
  rename(sessionId: string, name: string | null, o?: { tmux?: boolean }): Promise<Result<{ message: string; name: string; tmuxError?: string }>>;
}

export const fail = (error: ErrorCode, message: string, prompt?: PromptView): Fail =>
  ({ ok: false, error, message, ...(prompt ? { prompt } : {}) });

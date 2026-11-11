// The probe's cloud wire shapes (src/probe/probe.py, modes "cloud" and "cloud-answer"). Only derived, clipped fields:
// the OAuth token never leaves the account's host.

/** A pending `can_use_tool` control request (a permission prompt or an AskUserQuestion). */
export interface CloudRequest {
  requestId: string;
  /** The uuid of the control_request event. */
  eventId: string | null;
  /** The uuid of the event before it (null when it is the first): cloud-answer reads from here. */
  prevId: string | null;
  toolName: string;
  displayName?: string;
  toolUseId?: string;
  /** The tool input, every string clipped to 400 characters. */
  input: unknown;
  createdAt: string;
}

/** What the probe read from the events newer than `known.afterId`. */
export interface CloudEvents {
  /** user and assistant events, through trim_line, newest 60, oldest first. */
  lines: string[];
  /** Requests in this batch not resolved in it, oldest first. */
  requests: CloudRequest[];
  /** request ids a control_response or control_cancel_request in this batch named. */
  resolved: string[];
  lastId: string | null;
  lastResultAt?: string;
  /** The page cap was hit: there are newer events still to read. */
  more: boolean;
}

/** One live cloud session as the probe's `cloud` mode returns it. */
export interface CloudRaw {
  id: string;
  title: string;
  /** session_status: running, idle, requires_action (archived ones are never returned). */
  status: string;
  unread: boolean;
  createdAt: string;
  updatedAt: string;
  model?: string;
  effort?: string;
  contextUsed?: number;
  contextMax?: number;
  /** owner/name of the session's GitHub repository. */
  repo?: string;
  /** Absent when its updatedAt matched `known`, or the poll ran out of time. */
  events?: CloudEvents;
}

export type CloudAccount =
  | { key: string; configDir: string; ok: true; login: string; sessions: CloudRaw[] }
  | { key: string; configDir: string; ok: false; error: string; status?: number; retryAfterS?: number; noAuth?: true; expired?: true };

export interface CloudLaunch { sessionId: string; task?: string }

export interface ProbeCloud {
  ok: true;
  nowMs: number;
  launches?: CloudLaunch[];
  launchError?: string;
  accounts: CloudAccount[];
}

export type CloudAnswerCode = 'gone' | 'not_pending' | 'busy' | 'bad_choice' | 'http' | 'auth';

export type CloudAnswerReply =
  | { ok: true; sent: string }
  | { ok: false; code: CloudAnswerCode; error: string; status?: number; retryAfterS?: number };

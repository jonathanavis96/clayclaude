export const RE = {
  /** `/rc` bridge ids: session_… or cse_… */
  bridgeId: /^(?:session|cse)_[A-Za-z0-9_-]{4,128}$/,
  tmuxSession: /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}$/,
  paneId: /^%\d{1,9}$/,
  windowId: /^@\d{1,9}$/,
};

export interface TmuxRef { session: string; window: string; pane: string }

/** Parse a registry `tmux` value such as `main:@1.%1`. Returns null for anything else. */
export function parseTmuxRef(s: string | undefined): TmuxRef | null {
  if (!s) return null;
  const m = /^(.+):(@\d+)\.(%\d+)$/.exec(s);
  if (!m || !RE.tmuxSession.test(m[1]) || !RE.windowId.test(m[2]) || !RE.paneId.test(m[3])) return null;
  return { session: m[1], window: m[2], pane: m[3] };
}

export const refString = (r: TmuxRef) => `${r.session}:${r.window}.${r.pane}`;

/** A tmux window / session name derived from a folder name. */
export function safeName(s: string): string {
  const t = s.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return t || 'claude';
}

export class ActionError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

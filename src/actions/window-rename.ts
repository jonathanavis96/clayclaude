import type { HostConfig } from '../config.js';
import type { Session } from '../types.js';
import { errorLine, type HostExec } from './exec.js';
import { fail, type Fail } from './types.js';
import { parseTmuxRef, refString, type TmuxRef } from './validate.js';

/**
 * Run as `sh -c SCRIPT _ PANE EXPECTED_REF WINDOW SESSION_PID NAME` (Task 42a: the rename sheet's "Also rename the tmux
 * window"). Checks that the pane still has the session, window and id the registry recorded and that the Claude
 * process is inside it (a restarted tmux server can reuse ids for someone else's window), then renames that window.
 * It only reads the pane and renames the window: it never sends keys and never touches the pane's input.
 * Positional arguments only; the name is one argument after `--`.
 */
export const RENAME_WINDOW_SCRIPT = [
  'pane="$1"; want="$2"; pid="$4"',
  'info=$(tmux display-message -p -t "$pane" "#{session_name}:#{window_id}.#{pane_id} #{pane_pid}" 2>/dev/null) || { echo "that pane no longer exists" >&2; exit 3; }',
  'tgt=${info% *}; pp=${info##* }',
  '[ "$tgt" = "$want" ] || { echo "that pane no longer belongs to this session" >&2; exit 3; }',
  'p="$pid"; n=0; own=no',
  'while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$n" -lt 40 ]; do',
  '  if [ "$p" = "$pp" ]; then own=yes; break; fi',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  '  n=$((n+1))',
  'done',
  '[ "$own" = yes ] || { echo "that pane no longer belongs to this session" >&2; exit 3; }',
  'tmux rename-window -t "$3" -- "$5"',
].join('\n');

/**
 * Why tmux cannot take this name as a window name, or undefined. tmux format-expands a new window name (`#(cmd)` would
 * run cmd, `#{..}` would be replaced) and no escaping covers every case (it keeps a run of `#` before `[` as a style),
 * its own argument parser reads a trailing `;` as a command separator, even after `--`, and rename-window stores a
 * backslash escaped (`a\b` shows as `a\\b`).
 */
export function tmuxNameProblem(name: string): string | undefined {
  if (name.includes('#')) return 'A tmux window name cannot contain #. Untick "Also rename the tmux window" to use this name on the board only.';
  if (name.includes('\\')) return 'A tmux window name cannot contain \\. Untick "Also rename the tmux window" to use this name on the board only.';
  if (name.endsWith(';')) return 'A tmux window name cannot end with ;. Untick "Also rename the tmux window" to use this name on the board only.';
  return undefined;
}

/** Whether the tmux window of this session can be renamed now; the pane reference when it can. Runs nothing. */
export function windowTarget(s: Session, host: HostConfig | undefined): { ref: TmuxRef } | Fail {
  const ref = parseTmuxRef(s.tmux);
  if (!ref || !s.live) return fail('no_tmux', 'this session is not running in tmux');
  if (!host) return fail('unknown_session', 'unknown host');
  if (!s.hostOnline) return fail('host_offline', `${s.host} is offline`);
  return { ref };
}

/** Renames the session's tmux window (one command on its host, over ssh when remote). Returns why not, or undefined. */
export async function renameWindow(exec: HostExec, host: HostConfig, ref: TmuxRef, pid: number, name: string): Promise<string | undefined> {
  try {
    const r = await exec(host, ['sh', '-c', RENAME_WINDOW_SCRIPT, '_', ref.pane, refString(ref), ref.window, String(pid), name], { timeoutMs: 8000 });
    return r.code === 0 ? undefined : errorLine(r.stderr) || `tmux exited with ${r.code}`;
  } catch (e) { return e instanceof Error ? e.message.split('\n')[0] : 'tmux failed'; }
}

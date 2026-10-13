import type { Config, HostConfig } from '../config.js';
import type { Session } from '../types.js';
import { errorLine, type HostExec } from './exec.js';
import { parsePane, type ParsedPane } from './pane.js';
import { fail, type AnswerRequest, type Fail, type PromptView, type Result } from './types.js';
import { parseTmuxRef, refString, type TmuxRef } from './validate.js';

/**
 * A word that is `-` when keys sent to the pane reach only the program in it, as typed. M: copy mode (the keys run
 * copy-mode commands; capture-pane still shows the prompt underneath). S: synchronize-panes (tmux copies every key,
 * -l included, to the window's other panes). I: input disabled with `select-pane -d` (the keys are dropped).
 */
const PANE_FLAGS = '-#{?pane_in_mode,M,}#{?synchronize-panes,S,}#{?pane_input_off,I,}';

/**
 * Run as `sh -c SCRIPT _ PANE EXPECTED_REF SESSION_PID`. Checks that the pane still has the id and
 * window the registry recorded and that the Claude process is inside it (a restarted tmux server can
 * reuse `%1` for something else), then prints OK and the visible text. Positional arguments only.
 * Claude must also own the terminal: `ps` marks the foreground process group with `+` and a stopped process
 * with T. After Ctrl-Z, Claude's input box is still on screen but the shell that started it reads the keys.
 * The pane must also take keys as typed: see PANE_FLAGS.
 */
export const CAPTURE_SCRIPT = [
  'pane="$1"; want="$2"; pid="$3"',
  `info=$(tmux display-message -p -t "$pane" '#{session_name}:#{window_id}.#{pane_id} #{pane_pid} ${PANE_FLAGS}' 2>/dev/null) || { echo "ERR gone"; exit 0; }`,
  'fl=${info##* }; info=${info% *}; tgt=${info% *}; pp=${info##* }',
  '[ "$tgt" = "$want" ] || { echo "ERR moved"; exit 0; }',
  'p="$pid"; n=0; own=no',
  'while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$n" -lt 40 ]; do',
  '  if [ "$p" = "$pp" ]; then own=yes; break; fi',
  '  p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d " ")',
  '  n=$((n+1))',
  'done',
  '[ "$own" = yes ] || { echo "ERR notowner"; exit 0; }',
  'st=$(ps -o stat= -p "$pid" 2>/dev/null | tr -d " ")',
  'case "$st" in [Tt]*|"") echo "ERR stopped"; exit 0;; *+*) ;; *) echo "ERR stopped"; exit 0;; esac',
  '[ "$fl" = - ] || { echo "ERR mode $fl"; exit 0; }',
  'echo OK',
  'tmux capture-pane -p -J -t "$pane"',
].join('\n');

/**
 * The send scripts run as `sh -c SCRIPT _ PANE KEYS EXPECTED_REF`, and re-check the pane first, so nothing is typed
 * if it changed hands (exit 3) or stopped taking keys as typed (exit 4, PANE_FLAGS on stderr).
 */
const OWNER_CHECK = [
  `pst=$(tmux display-message -p -t "$1" '#{session_name}:#{window_id}.#{pane_id} ${PANE_FLAGS}' 2>/dev/null)`,
  '[ -n "$pst" ] && [ "${pst% *}" = "$3" ] || { echo "that pane no longer belongs to this session" >&2; exit 3; }',
  '[ "${pst##* }" = - ] || { echo "${pst##* }" >&2; exit 4; }',
].join('\n');
export const SEND_CHOICE_SCRIPT = `${OWNER_CHECK}\ntmux send-keys -t "$1" -l -- "$2"`;
/**
 * tmux's own argument parser reads a trailing `;` on any argument as a command separator (and `\;` as
 * an escaped `;`), even after `-l --`. So trailing semicolons are cut off the text and sent as hex 3b.
 * The pause keeps Enter out of the same input burst, so Claude Code submits instead of reading it as pasted text.
 */
export const SEND_TEXT_SCRIPT = [
  OWNER_CHECK,
  't="$2"; n=0',
  'while [ "${t%;}" != "$t" ]; do t="${t%;}"; n=$((n+1)); done',
  '{ [ -z "$t" ] || tmux send-keys -t "$1" -l -- "$t"; } || exit 1',
  '{ [ "$n" -eq 0 ] || tmux send-keys -t "$1" -N "$n" -H 3b; } || exit 1',
  'sleep 0.3 && tmux send-keys -t "$1" Enter',
].join('\n');

/**
 * Claude's folder-trust question has no option numbers (Task 40): `$2` is the cursor move from the selected option
 * to the chosen one (`0`, `+N` down, `-N` up, N at most 8), then Enter after a pause, as for a text reply. Run as
 * `sh -c SCRIPT _ PANE MOVE EXPECTED_REF`, with the same owner check first.
 */
export const SEND_MOVE_SCRIPT = [
  OWNER_CHECK,
  'case "$2" in',
  '  0) ;;',
  '  +[1-8]) tmux send-keys -t "$1" -N "${2#+}" Down || exit 1;;',
  '  -[1-8]) tmux send-keys -t "$1" -N "${2#-}" Up || exit 1;;',
  '  *) echo "bad move" >&2; exit 1;;',
  'esac',
  'sleep 0.3 && tmux send-keys -t "$1" Enter',
].join('\n');

/** Before Claude registers, a pane launched from the board takes an answer only to its folder-trust question. */
const NOT_TRUST = 'Only Claude\'s folder-trust question can be answered before the session has started. Nothing was sent.';

export const MAX_ANSWER_CHARS = 4000;

/** Why a pane with these PANE_FLAGS cannot be answered. */
function paneFlagsFail(flags: string): Fail {
  if (flags.includes('S')) return fail('no_prompt', 'synchronize-panes is on in that tmux window, so the reply would also be typed into its other panes. Turn it off on the PC first. Nothing was sent.');
  if (flags.includes('M')) return fail('no_prompt', 'That pane is scrolled back (in copy mode) on the PC. Leave copy mode there first. Nothing was sent.');
  return fail('no_prompt', 'Input to that tmux pane is turned off (select-pane -d). Turn it back on first. Nothing was sent.');
}

/**
 * One answer at a time per pane, and never the same prompt twice within `repeatMs` of a successful send.
 * Without it, a double tap (or two tablets) both pass the hash check before either key lands on screen.
 */
export class SendGuard {
  private busy = new Set<string>();
  private last = new Map<string, { hash: string; at: number }>();
  constructor(private now: () => number = Date.now, private repeatMs = 3000) {}
  begin(k: string): boolean { if (this.busy.has(k)) return false; this.busy.add(k); return true; }
  end(k: string): void { this.busy.delete(k); }
  isRepeat(k: string, hash: string): boolean { const l = this.last.get(k); return !!l && l.hash === hash && this.now() - l.at < this.repeatMs; }
  sent(k: string, hash: string): void { this.last.set(k, { hash, at: this.now() }); }
}
const DEFAULT_GUARD = new SendGuard();

export interface AnswerDeps {
  cfg: Config;
  sessions: () => Session[];
  exec: HostExec;
  quickReplies: () => string[];
  lastAssistantText?: (s: Session) => Promise<string | undefined>;
  /** Shared across calls; the service passes one. Defaults to a process-wide guard. */
  guard?: SendGuard;
}

interface Target { session: Session; host: HostConfig; ref: TmuxRef }

function resolve(d: AnswerDeps, sessionId: string): Target | Fail {
  const session = d.sessions().find((s) => s.key === sessionId);
  if (!session) return fail('unknown_session', 'that session is no longer listed');
  const host = d.cfg.hosts.find((h) => h.id === session.host);
  if (!host) return fail('unknown_session', 'unknown host');
  if (!session.hostOnline) return fail('host_offline', `${host.id} is offline`);
  const ref = parseTmuxRef(session.tmux);
  if (!ref) return fail('no_tmux', 'this session has no tmux pane, so it cannot be answered from here');
  return { session, host, ref };
}

async function capture(d: AnswerDeps, t: Target): Promise<{ ok: true; view: PromptView } | Fail> {
  const r = await readPane(d.exec, t.host, t.ref, t.session.pid);
  return r.ok ? { ok: true, view: { ...r.parsed, quickReplies: d.quickReplies() } } : r;
}

/**
 * Read a pane with CAPTURE_SCRIPT: only when it still has that id and window, `pid` runs inside it in the
 * foreground, and it takes keys as typed. `pane_gone` when it closed or belongs to something else now.
 */
export async function readPane(exec: HostExec, host: HostConfig, ref: TmuxRef, pid: number): Promise<{ ok: true; parsed: ParsedPane } | Fail> {
  const r = await exec(host, ['sh', '-c', CAPTURE_SCRIPT, '_', ref.pane, refString(ref), String(pid)], { timeoutMs: 8000 });
  if (r.code !== 0) return fail('failed', errorLine(r.stderr) || `capture failed (${r.code})`);
  // The script's status line, skipping anything a remote shell startup file (.bashrc echo, conda) printed before it.
  const m = /^(OK|ERR mode \S+|ERR \w+)[ \t\r]*$/m.exec(r.stdout);
  const head = m?.[1] ?? '';
  const nl = m ? r.stdout.indexOf('\n', m.index) : -1;
  if (head === 'ERR gone') return fail('pane_gone', 'the tmux pane no longer exists');
  if (head === 'ERR moved' || head === 'ERR notowner') return fail('pane_gone', 'that pane no longer belongs to this session');
  if (head.startsWith('ERR mode ')) return paneFlagsFail(head.slice(9));
  if (head === 'ERR stopped') return fail('no_prompt', 'Claude is suspended or not in the foreground of its pane (resume it there first). Nothing was sent.');
  if (head !== 'OK') return fail('failed', 'unexpected reply from tmux');
  return { ok: true, parsed: parsePane(nl === -1 ? '' : r.stdout.slice(nl + 1)) };
}

export async function readPrompt(d: AnswerDeps, sessionId: string): Promise<Result<{ prompt: PromptView; lastAssistantText?: string; question?: string }>> {
  const t = resolve(d, sessionId);
  if ('ok' in t) return t;
  const c = await capture(d, t);
  if (!c.ok) return c;
  if (c.view.kind === 'none') return fail('no_prompt', 'nothing is waiting for input in that pane');
  if (t.session.starting && !c.view.trust) return fail('no_prompt', NOT_TRUST);
  return { ok: true, prompt: c.view, question: t.session.question, lastAssistantText: await d.lastAssistantText?.(t.session) };
}

/** One line, no control characters (C0, DEL or C1). Returns the cleaned text or a failure. */
export function cleanText(raw: string): string | Fail {
  const t = raw.replace(/\r?\n/g, ' ').replace(/\t/g, ' ').trim();
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(t)) return fail('bad_request', 'the reply contains control characters');
  if (t === '') return fail('bad_request', 'the reply is empty');
  if (t.length > MAX_ANSWER_CHARS) return fail('too_long', `replies are limited to ${MAX_ANSWER_CHARS} characters`);
  return t;
}

export async function answer(d: AnswerDeps, req: AnswerRequest): Promise<Result<{ sent: string }>> {
  const t = resolve(d, req.sessionId);
  if ('ok' in t) return t;
  let text: string | undefined;
  if (req.text !== undefined) {
    const c = cleanText(req.text);
    if (typeof c !== 'string') return c;
    text = c;
  }
  const guard = d.guard ?? DEFAULT_GUARD;
  const lock = `${t.host.id}\0${t.ref.pane}`;
  if (!guard.begin(lock)) return fail('duplicate', 'An answer to this session is already being sent.');
  try {
    // Look again immediately before typing: keys must never land in a session that has moved on.
    const now = await capture(d, t);
    if (!now.ok) return now;
    if (now.view.kind === 'none') return fail('no_prompt', 'nothing is waiting for input in that pane', now.view);
    if (t.session.starting && !now.view.trust) return fail('no_prompt', NOT_TRUST);
    if (now.view.hash !== req.promptHash) return fail('prompt_changed', 'The prompt changed. Nothing was sent.', now.view);
    if (guard.isRepeat(lock, now.view.hash)) return fail('duplicate', 'That answer was just sent. Wait for the session to respond.', now.view);

    let script: string, arg: string, sent: string;
    if (req.choice !== undefined) {
      if (now.view.kind !== 'menu') return fail('bad_request', 'there is no menu to choose from', now.view);
      if (!/^[1-9]$/.test(req.choice) || !now.view.options.some((o) => o.key === req.choice))
        return fail('bad_request', 'that is not one of the options on screen', now.view);
      sent = `option ${req.choice}`;
      if (now.view.trust) {
        const from = now.view.options.findIndex((o) => o.selected), to = now.view.options.findIndex((o) => o.key === req.choice);
        if (from < 0) return fail('no_prompt', 'cannot tell which option is selected on screen. Nothing was sent.', now.view);
        script = SEND_MOVE_SCRIPT; arg = to === from ? '0' : to > from ? `+${to - from}` : `-${from - to}`;
      } else { script = SEND_CHOICE_SCRIPT; arg = req.choice; }
    } else {
      if (now.view.kind !== 'text') return fail('bad_request', 'a menu is showing; choose one of its options', now.view);
      script = SEND_TEXT_SCRIPT; arg = text!; sent = `reply (${text!.length} characters)`;
    }
    const r = await d.exec(t.host, ['sh', '-c', script, '_', t.ref.pane, arg, refString(t.ref)], { timeoutMs: 8000 });
    if (r.code === 3) return fail('pane_gone', errorLine(r.stderr) || 'that pane no longer belongs to this session');
    if (r.code === 4) return paneFlagsFail(errorLine(r.stderr));
    if (r.code !== 0) return fail('failed', errorLine(r.stderr) || `tmux send-keys exited with ${r.code}`);
    guard.sent(lock, now.view.hash);
    return { ok: true, sent };
  } finally {
    guard.end(lock);
  }
}

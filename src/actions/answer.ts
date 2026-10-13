import type { Config, HostConfig } from '../config.js';
import type { Session } from '../types.js';
import { createHash, randomBytes } from 'node:crypto';
import { errorLine, type HostExec } from './exec.js';
import { inputBoxTail, parsePane, steady, type PaneSignals, type ParsedPane } from './pane.js';
import { fail, type AnswerRequest, type Fail, type PromptView, type Result } from './types.js';
import { parseTmuxRef, refString, type TmuxRef } from './validate.js';

/**
 * A word that is `-` when keys sent to the pane reach only the program in it, as typed. M: copy mode (the keys run
 * copy-mode commands; capture-pane still shows the prompt underneath). S: synchronize-panes (tmux copies every key,
 * -l included, to the window's other panes). I: input disabled with `select-pane -d` (the keys are dropped).
 */
const PANE_FLAGS = '-#{?pane_in_mode,M,}#{?synchronize-panes,S,}#{?pane_input_off,I,}';

/**
 * The checks every host-side script starts with, run as `sh -c SCRIPT _ PANE EXPECTED_REF SESSION_PID …`, positional
 * arguments only (a send script's sixth, ROWS, is read here: see SAME). The pane must still have the id and window the registry recorded, and the Claude process must be
 * inside it (a restarted tmux server can reuse `%1` for something else). Claude must also own the terminal: `ps` marks
 * the foreground process group with `+` and a stopped process with T. After Ctrl-Z, Claude's input box is still on
 * screen but the shell that started it reads the keys. The pane must also take keys as typed: see PANE_FLAGS. Any
 * failure prints one `ERR …` line and exits. It also picks a SHA-256 tool (no tool, no answer: ERR nohash) and defines
 * `scr` (the visible text, as captured), `norm` (a text with Claude's blinking tool bullet, "●" or "⏺" at column 0, read
 * as a space: pane.ts, BLINK and steady; written as octal bytes so the script stays ASCII, matched byte for byte under
 * LC_ALL=C), `view` (the part of the screen the last check compares, steadied: the whole text when ROWS is 0, else its
 * last ROWS lines), `sum` (the SHA-256 of a text) and `nsum` (the SHA-256 of a captured text, steadied).
 */
const CHECK = [
  'pane="$1"; want="$2"; pid="$3"; rows="${6:-0}"',
  'case "$rows" in 0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]) ;; *) echo "bad rows" >&2; exit 1;; esac',
  'if command -v sha256sum >/dev/null 2>&1; then H=sha256sum',
  'elif command -v shasum >/dev/null 2>&1; then H="shasum -a 256"',
  'elif command -v openssl >/dev/null 2>&1; then H="openssl dgst -sha256 -r"',
  'else echo "ERR nohash"; exit 0; fi',
  'scr() { tmux capture-pane -p -J -t "$pane"; }',
  "B1=$(printf '\\342\\227\\217'); B2=$(printf '\\342\\217\\272')",
  'norm() { LC_ALL=C sed -e "s/^$B1/ /" -e "s/^$B2/ /"; }',
  'view() { c=$(scr) || return 1; if [ "$rows" = 0 ]; then printf \'%s\\n\' "$c"; else printf \'%s\\n\' "$c" | tail -n "$rows"; fi | norm; }',
  'sum() { printf %s "$1" | $H | cut -d " " -f 1; }',
  'nsum() { sum "$(printf \'%s\\n\' "$1" | norm)"; }',
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
].join('\n');

/**
 * Run as `sh -c SCRIPT _ PANE EXPECTED_REF SESSION_PID`: the checks, then `OK <sha256>` and the visible text. The
 * SHA-256 is of exactly the text printed, steadied (`nsum`: the blinking bullet read as a space), so a send script can
 * tell, in the same shell invocation as its keys, that the screen is still the one that was read and parsed.
 */
export const CAPTURE_SCRIPT = [
  CHECK,
  's=$(scr) || { echo "ERR gone"; exit 0; }',
  'echo "OK $(nsum "$s")"',
  'printf \'%s\\n\' "$s"',
].join('\n');

/**
 * The last check before any key, in the same script as the key and with nothing in between but the hash (layer 2 of
 * the answer race, see answer()): the screen must still be, byte for byte, the one answer() read and parsed (`$4`, a
 * SHA-256), apart from Claude's blinking tool bullet (CHECK, `norm`). Otherwise ERR changed, and nothing is sent. A prompt that appears after the parse (the model's next tool
 * call reaching Claude) therefore never receives keys chosen for the screen before it. ROWS 0 compares the whole screen
 * (a permission prompt, a menu: nothing on screen moves while one waits). For a typed reply ROWS is the height of
 * Claude's input box and the rows under it (pane.ts, inputBoxTail): while Claude works its spinner redraws the screen
 * every frame, and a prompt Claude draws replaces the input box, so those rows are the ones that tell.
 */
const SAME = '[ "$(sum "$(view)")" = "$4" ] || { echo "ERR changed"; exit 0; }';

/**
 * Every send script runs as `sh -c SCRIPT _ PANE EXPECTED_REF SESSION_PID SCREEN_SHA ARG ROWS`: CHECK, then SAME, then
 * its keys, then `SENT`. A digit for a menu that approves nothing (an AskUserQuestion menu): ARG is its own number on screen.
 */
export const SEND_CHOICE_SCRIPT = [
  CHECK,
  'case "$5" in [1-9]) ;; *) echo "bad choice" >&2; exit 1;; esac',
  SAME,
  'tmux send-keys -t "$pane" -l -- "$5" || exit 1',
  'echo SENT',
].join('\n');
/**
 * A permission prompt's only answers (pane.ts, PERMISSION_OPTIONS). ARG is yes or no: yes types the digit 1 (Claude's
 * own option 1, sent only when the screen shows it as a plain "Yes", once) and no presses Escape. Both keys are written
 * here, never taken from the screen or the request; any other word sends nothing.
 */
export const SEND_PERMISSION_SCRIPT = [
  CHECK,
  'case "$5" in yes|no) ;; *) echo "bad answer" >&2; exit 1;; esac',
  SAME,
  'case "$5" in',
  '  yes) tmux send-keys -t "$pane" -l -- 1 || exit 1;;',
  '  no) tmux send-keys -t "$pane" Escape || exit 1;;',
  'esac',
  'echo SENT',
].join('\n');

/**
 * A typed reply, without Enter, as one bracketed paste: the text comes on stdin into a paste buffer of its own (ARG, a
 * name unique to this call), never as an argument, and is pasted with `paste-buffer -p -d`, so an application that
 * asked for bracketed paste (Claude Code does) receives it between ESC[200~ and ESC[201~: a Select menu that appears
 * anyway reads a paste, not a "2" keystroke (a real 2.1.296 Bash prompt ignored pasted "2 please", "2", "1", "3" and "y";
 * fixtures/panes/real-2.1.296/menu-captures.md). The buffer is loaded before the final check, so only the hash stands
 * between the check and the paste. Then, after a pause for Claude to draw the draft, the screen is printed with its
 * hash (`PASTED <sha256>`), and answer() presses Enter (SEND_ENTER_SCRIPT) only if it is still Claude's input box and
 * its rows have not changed since.
 */
export const SEND_PASTE_SCRIPT = [
  CHECK,
  'case "$5" in clayclaude-[0-9a-f]*) ;; *) echo "bad buffer" >&2; exit 1;; esac',
  'tmux load-buffer -b "$5" - || exit 1',
  `[ "$(sum "$(view)")" = "$4" ] || { tmux delete-buffer -b "$5" 2>/dev/null; echo "ERR changed"; exit 0; }`,
  'tmux paste-buffer -p -d -b "$5" -t "$pane" || { tmux delete-buffer -b "$5" 2>/dev/null; exit 1; }',
  'sleep 0.3',
  'a=$(scr) || { echo "ERR gone"; exit 0; }',
  'echo "PASTED $(nsum "$a")"',
  'printf \'%s\\n\' "$a"',
].join('\n');
/**
 * Enter for a pasted reply (SCREEN_SHA and ROWS: the input box after the paste, which answer() parsed as one), or for a
 * startup dialog's moved cursor (ROWS 0: the whole screen after the move, parsed as that dialog).
 */
export const SEND_ENTER_SCRIPT = [CHECK, SAME, 'tmux send-keys -t "$pane" Enter || exit 1', 'echo SENT'].join('\n');

/**
 * Claude's startup confirm dialogs (folder trust, external imports) have no option numbers (Task 40), and are answered
 * only for a launch that is still starting (answer.ts, planFor). ARG is the cursor move from the selected option to the
 * chosen one (`0`, `+N` down, `-N` up, N at most 8). No Enter here: after a pause for Claude to redraw, the screen is
 * printed with its hash (`MOVED <sha256>`), and answer() presses Enter (SEND_ENTER_SCRIPT, ROWS 0) only when that screen
 * is the same dialog with the chosen option selected, and only while it is still that screen (confirmMove).
 */
export const SEND_MOVE_SCRIPT = [
  CHECK,
  'case "$5" in 0|+[1-8]|-[1-8]) ;; *) echo "bad move" >&2; exit 1;; esac',
  SAME,
  'case "$5" in',
  '  +*) tmux send-keys -t "$pane" -N "${5#+}" Down || exit 1;;',
  '  -*) tmux send-keys -t "$pane" -N "${5#-}" Up || exit 1;;',
  'esac',
  'sleep 0.3',
  'a=$(scr) || { echo "ERR gone"; exit 0; }',
  'echo "MOVED $(nsum "$a")"',
  'printf \'%s\\n\' "$a"',
].join('\n');

/** Why Yes is refused on a permission prompt whose option 1 is not a plain "Yes" (pane.ts, PERMISSION_NO_ONLY). */
export const NO_PLAIN_YES = 'Claude\'s first option here is not a plain "Yes" (on a plan approval it also changes the session\'s permission mode), so Yes is answered on the PC. Nothing was sent.';

/** Before Claude registers, a pane launched from the board takes an answer only to its folder-trust question. */
const NOT_TRUST = 'Only Claude\'s folder-trust question can be answered before the session has started. Nothing was sent.';
/** Claude's startup dialogs are answered from the board only for a launch that is still starting (SEND_MOVE_SCRIPT). */
const NOT_STARTING = 'This looks like one of Claude\'s startup questions, which are answered from here only while a launch from the board is starting. Answer it on the PC. Nothing was sent.';

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
export const DEFAULT_GUARD = new SendGuard();

export interface AnswerDeps {
  cfg: Config;
  sessions: () => Session[];
  exec: HostExec;
  quickReplies: () => string[];
  lastAssistantText?: (s: Session) => Promise<string | undefined>;
  /** Shared across calls; the service passes one. Defaults to a process-wide guard. */
  guard?: SendGuard;
}

export interface Target { session: Session; host: HostConfig; ref: TmuxRef }

export function resolve(d: AnswerDeps, sessionId: string): Target | Fail {
  const session = d.sessions().find((s) => s.key === sessionId);
  if (!session) return fail('unknown_session', 'that session is no longer listed');
  const host = d.cfg.hosts.find((h) => h.id === session.host);
  if (!host) return fail('unknown_session', 'unknown host');
  if (!session.hostOnline) return fail('host_offline', `${host.id} is offline`);
  const ref = parseTmuxRef(session.tmux);
  if (!ref) return fail('no_tmux', 'this session has no tmux pane, so it cannot be answered from here');
  return { session, host, ref };
}

/** What Claude Code reports about the session (not the screen): a pending permission, Claude working. */
const signalsOf = (s: Session): PaneSignals => ({ permission: s.permission === true, busy: s.busy === true });
/** The session as listed now, so a permission reported since it was resolved still counts. */
export const current = (d: AnswerDeps, t: Target): Session => d.sessions().find((x) => x.key === t.session.key) ?? t.session;

/** A screen as read: parsed, its text as captured, and the SHA-256 of that text. */
export interface Read { view: PromptView; sha: string; screen: string; signals: PaneSignals }

export async function capture(d: AnswerDeps, t: Target): Promise<({ ok: true } & Read) | Fail> {
  const signals = signalsOf(current(d, t));
  const r = await readPane(d.exec, t.host, t.ref, t.session.pid, signals);
  return r.ok ? { ok: true, view: { ...r.parsed, quickReplies: d.quickReplies() }, sha: r.sha, screen: r.screen, signals } : r;
}

/**
 * What a send script's last check compares (SAME): for Claude's input box, its rows and those under it (ROWS of them,
 * pane.ts inputBoxTail); for anything else the whole screen (ROWS 0). null when the input box cannot be found again.
 */
function checkOf(r: Read): { sha: string; rows: string } | null {
  if (r.view.kind !== 'text') return { sha: r.sha, rows: '0' };
  const tail = inputBoxTail(r.screen, r.signals);
  if (tail === null) return null;
  const rows = tail.split('\n');
  // Steadied line by line, exactly as the script's `view` (CHECK, `norm`) reads them.
  return rows.length > 999 ? null : { sha: createHash('sha256').update(rows.map(steady).join('\n')).digest('hex'), rows: String(rows.length) };
}

/**
 * The status line a host-side script printed (skipping anything a remote shell startup file, a .bashrc echo or a conda
 * banner, printed before it) and what follows it.
 */
const STATUS = /^(OK [0-9a-f]{64}|PASTED [0-9a-f]{64}|MOVED [0-9a-f]{64}|SENT|ERR mode \S+|ERR \w+)[ \t\r]*$/m;
function status(out: string): { head: string; rest: string } {
  const m = STATUS.exec(out);
  if (!m) return { head: '', rest: '' };
  const nl = out.indexOf('\n', m.index);
  return { head: m[1], rest: nl === -1 ? '' : out.slice(nl + 1) };
}
function errFail(head: string): Fail | null {
  if (head === 'ERR gone') return fail('pane_gone', 'the tmux pane no longer exists');
  if (head === 'ERR moved' || head === 'ERR notowner') return fail('pane_gone', 'that pane no longer belongs to this session');
  if (head.startsWith('ERR mode ')) return paneFlagsFail(head.slice(9));
  if (head === 'ERR stopped') return fail('no_prompt', 'Claude is suspended or not in the foreground of its pane (resume it there first). Nothing was sent.');
  if (head === 'ERR nohash') return fail('failed', 'That host has no SHA-256 tool (sha256sum, shasum or openssl), so the screen cannot be checked before sending. Nothing was sent.');
  return null;
}

/**
 * Read a pane with CAPTURE_SCRIPT: only when it still has that id and window, `pid` runs inside it in the
 * foreground, and it takes keys as typed. `pane_gone` when it closed or belongs to something else now. `sha` is the
 * SHA-256 of the text parsed, for the send scripts' last check.
 */
export async function readPane(exec: HostExec, host: HostConfig, ref: TmuxRef, pid: number, signals: PaneSignals = {}): Promise<{ ok: true; parsed: ParsedPane; sha: string; screen: string } | Fail> {
  const r = await exec(host, ['sh', '-c', CAPTURE_SCRIPT, '_', ref.pane, refString(ref), String(pid)], { timeoutMs: 8000 });
  if (r.code !== 0) return fail('failed', errorLine(r.stderr) || `capture failed (${r.code})`);
  const { head, rest } = status(r.stdout);
  const e = errFail(head);
  if (e) return e;
  if (!head.startsWith('OK ')) return fail('failed', 'unexpected reply from tmux');
  return { ok: true, parsed: parsePane(rest, signals), sha: head.slice(3), screen: rest };
}

export async function readPrompt(d: AnswerDeps, sessionId: string): Promise<Result<{ prompt: PromptView; lastAssistantText?: string; question?: string }>> {
  const t = resolve(d, sessionId);
  if ('ok' in t) return t;
  const c = await capture(d, t);
  if (!c.ok) return c;
  if (c.view.kind === 'none') return fail('no_prompt', 'nothing is waiting for input in that pane');
  if (t.session.starting && !c.view.trust) return fail('no_prompt', NOT_TRUST);
  if (!t.session.starting && c.view.trust) return fail('no_prompt', NOT_STARTING);
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

/** How many times a send is retried when the screen changed only in ways that leave the prompt the same. */
const RETRIES = 2;

interface Plan { script: string; arg: string; sent: string; input?: string }

/** The script and argument for this request on this screen, or why nothing may be sent. */
function planFor(v: PromptView, req: AnswerRequest, text: string | undefined, starting: boolean): Plan | Fail {
  if (req.choice !== undefined) {
    if (v.kind === 'permission') {
      // P1-P3: a permission prompt takes yes (the digit 1) or no (Escape), and nothing else; yes only when the view
      // offers it, that is when Claude's option 1 on this screen is a plain "Yes" (pane.ts, plainYesFirst).
      if (req.choice !== 'yes' && req.choice !== 'no') return fail('bad_request', 'This is a permission prompt: answer Yes or No. Other choices are on the PC.', v);
      if (!v.options.some((o) => o.key === req.choice)) return fail('bad_request', NO_PLAIN_YES, v);
      return { script: SEND_PERMISSION_SCRIPT, arg: req.choice, sent: req.choice === 'yes' ? 'Yes' : 'No' };
    }
    if (v.kind === 'menu') {
      if (!/^[1-9]$/.test(req.choice) || !v.options.some((o) => o.key === req.choice))
        return fail('bad_request', 'that is not one of the options on screen', v);
      const sent = `option ${req.choice}`;
      if (!v.trust) return { script: SEND_CHOICE_SCRIPT, arg: req.choice, sent };
      // Arrow keys and Enter: only for a launch from the board that Claude has not registered yet.
      if (!starting) return fail('no_prompt', NOT_STARTING, v);
      const from = v.options.findIndex((o) => o.selected), to = v.options.findIndex((o) => o.key === req.choice);
      if (from < 0) return fail('no_prompt', 'cannot tell which option is selected on screen. Nothing was sent.', v);
      return { script: SEND_MOVE_SCRIPT, arg: to === from ? '0' : to > from ? `+${to - from}` : `-${from - to}`, sent };
    }
    return fail('bad_request', 'there is no menu to choose from', v);
  }
  // P5: a typed reply only into Claude's input box, positively recognised, with no permission pending. While Claude
  // works too: Claude Code queues it for the model's next pause (the answer race below covers a prompt appearing then).
  if (v.kind !== 'text') return fail('bad_request', v.kind === 'permission' ? 'This is a permission prompt: answer Yes or No.' : 'a menu is showing; choose one of its options', v);
  return { script: SEND_PASTE_SCRIPT, arg: `clayclaude-${randomBytes(8).toString('hex')}`, input: text!, sent: `reply (${text!.length} characters)` };
}

export type Sent = { ok: true; pasted?: { sha: string; screen: string }; moved?: { sha: string; screen: string } } | Fail | 'changed';

/**
 * Run a send script: its own checks, the screen (or input box) hash compared with `check` and the keys, all in one
 * shell invocation on the host (layer 2 of the answer race). 'changed' when the screen was not that one any more;
 * nothing was sent then.
 */
export async function run(d: AnswerDeps, t: Target, script: string, check: { sha: string; rows: string }, arg: string, input?: string): Promise<Sent> {
  const r = await d.exec(t.host, ['sh', '-c', script, '_', t.ref.pane, refString(t.ref), String(t.session.pid), check.sha, arg, check.rows], { timeoutMs: 8000, input });
  const { head, rest } = status(r.stdout);
  if (head === 'ERR changed') return 'changed';
  const e = errFail(head);
  if (e) return e;
  if (r.code !== 0) return fail('failed', errorLine(r.stderr) || `tmux send-keys exited with ${r.code}`);
  if (head === 'SENT') return { ok: true };
  if (head.startsWith('PASTED ')) return { ok: true, pasted: { sha: head.slice(7), screen: rest } };
  if (head.startsWith('MOVED ')) return { ok: true, moved: { sha: head.slice(6), screen: rest } };
  return fail('failed', 'unexpected reply from tmux');
}

/**
 * The answer race (TOCTOU): Claude can draw a new prompt (the model's next tool call) between the moment the screen is
 * checked and the moment keys reach it, and keys meant for the old screen would answer the new one: a typed "2" is
 * "Yes, and don't ask again". It is likeliest while Claude works, and a reply typed then is still sent (Claude Code
 * queues it and the model reads it at its next pause). Closed in three layers:
 *   1. Each answer is checked against the screen read just before it: its kind (planFor: a reply only into Claude's
 *      input box, positively recognised, never with a permission reported pending) and the prompt the sheet showed.
 *   2. The last check and the keys are one host-side script: capture, hash, compare with the hash of what was parsed
 *      here, send (SAME in every send script), for a choice, Yes / No, a reply and its Enter alike.
 *   3. A reply is a bracketed paste (SEND_PASTE_SCRIPT), never keystrokes, so a prompt drawn in the instant between the
 *      script's own check and its paste reads a paste, which picks nothing; its Enter goes only to the input box read
 *      after the paste, parsed here as one, by the same hash check (pressEnter).
 * One gap remains and is accepted (decided 2026-10-13; docs/plans/KNOWN-ISSUES.md #32): a reply's Enter
 * sent while Claude works can reach a permission prompt Claude mounts in the same few tens of milliseconds (Ink focuses
 * the new menu before drawing it, so no check sees it), and Enter picks its highlighted option. Busy replies keep Claude
 * Code's own mid-turn queue rather than being refused. A permission prompt is only ever answered by a tap: 1 or Escape.
 */
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
    for (let attempt = 0; ; attempt++) {
      // Look again immediately before sending: keys must never land in a session that has moved on.
      const now = await capture(d, t);
      if (!now.ok) return now;
      const v = now.view;
      if (v.kind === 'none') return fail('no_prompt', 'nothing is waiting for input in that pane', v);
      if (t.session.starting && !v.trust) return fail('no_prompt', NOT_TRUST);
      if (!t.session.starting && v.trust) return fail('no_prompt', NOT_STARTING, v);
      if (v.hash !== req.promptHash) return fail('prompt_changed', 'The prompt changed. Nothing was sent.', v);
      if (guard.isRepeat(lock, v.hash)) return fail('duplicate', 'That answer was just sent. Wait for the session to respond.', v);
      const plan = planFor(v, req, text, t.session.starting === true);
      if ('ok' in plan) return plan;
      const check = checkOf(now);
      const r = check ? await run(d, t, plan.script, check, plan.arg, plan.input) : 'changed';
      if (r === 'changed') {
        if (attempt < RETRIES) continue;
        return fail('prompt_changed', 'The screen kept changing, so nothing was sent. Check the session on the PC.', v);
      }
      if (!r.ok) return r;
      if (r.pasted) {
        const e = await pressEnter(d, t, r.pasted);
        if (e) return e;
      }
      if (r.moved) {
        const e = await confirmMove(d, t, r.moved, v, req.choice!);
        if (e) return e;
      }
      guard.sent(lock, v.hash);
      return { ok: true, sent: plan.sent };
    }
  } finally {
    guard.end(lock);
  }
}

/**
 * Enter after a pasted reply, only into Claude's input box as the screen after the paste shows it, and only while its
 * rows are unchanged (SAME): a prompt drawn since, which replaces the input box, gets no Enter (Enter would pick its
 * highlighted option, "Yes"). With `idle` (a message to an idle session, message.ts) also only while Claude is not
 * working on that screen.
 */
export async function pressEnter(d: AnswerDeps, t: Target, pasted: { sha: string; screen: string }, idle = false): Promise<Fail | null> {
  const signals = signalsOf(current(d, t));
  let read: Read = { view: { ...parsePane(pasted.screen, signals), quickReplies: d.quickReplies() }, sha: pasted.sha, screen: pasted.screen, signals };
  for (let attempt = 0; ; attempt++) {
    const check = read.view.kind === 'text' && !(idle && read.view.busy) ? checkOf(read) : null;
    if (!check) return fail('prompt_changed', 'The screen changed while the reply was pasted, so Enter was not pressed. Check the session on the PC.', read.view);
    const r = await run(d, t, SEND_ENTER_SCRIPT, check, '-');
    if (r !== 'changed') return r.ok ? null : r;
    if (attempt >= RETRIES) return fail('prompt_changed', 'The screen kept changing after the reply was pasted, so Enter was not pressed. Check the session on the PC.', read.view);
    const c = await capture(d, t);
    if (!c.ok) return c;
    read = c;
  }
}

/**
 * Enter after a startup dialog's cursor was moved (SEND_MOVE_SCRIPT), only while the launch is still starting and the
 * screen read after the move is the same dialog (its question and options) with the chosen option selected, and only
 * while it is still that screen (SAME, ROWS 0, in the same host-side script as the Enter). A prompt drawn since gets no
 * Enter. A cursor not drawn at the chosen option yet is read again, a bounded number of times.
 */
async function confirmMove(d: AnswerDeps, t: Target, moved: { sha: string; screen: string }, was: PromptView, choice: string): Promise<Fail | null> {
  const signals = signalsOf(current(d, t));
  let read: Read = { view: { ...parsePane(moved.screen, signals), quickReplies: d.quickReplies() }, sha: moved.sha, screen: moved.screen, signals };
  const label = (v: PromptView) => v.options.map((o) => o.label).join('\n');
  for (let attempt = 0; ; attempt++) {
    const v = read.view;
    const same = current(d, t).starting === true && v.kind === 'menu' && v.trust === true && v.title === was.title && label(v) === label(was);
    if (!same) return fail('prompt_changed', 'The screen changed after the cursor moved, so Enter was not pressed. Check the session on the PC.', v);
    const r = v.options.find((o) => o.selected)?.key === choice ? await run(d, t, SEND_ENTER_SCRIPT, { sha: read.sha, rows: '0' }, '-') : 'changed';
    if (r !== 'changed') return r.ok ? null : r;
    if (attempt >= RETRIES) return fail('prompt_changed', 'The screen kept changing after the cursor moved, so Enter was not pressed. Check the session on the PC.', v);
    const c = await capture(d, t);
    if (!c.ok) return c;
    read = c;
  }
}

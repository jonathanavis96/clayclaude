import type { Session } from '../types.js';
import { randomBytes } from 'node:crypto';
import { DEFAULT_GUARD, SEND_ENTER_SCRIPT, SEND_PASTE_SCRIPT, capture, cleanText, current, pressEnter, resolve, run, type AnswerDeps, type Target } from './answer.js';
import { emptyIdleBox, pastedBox } from './pane.js';
import { fail, type Fail, type MessageRequest, type Result } from './types.js';

/**
 * Task 43: a new message to a session that finished its turn and waits for a new prompt (asleep), typed from the tablet.
 *
 * The idle gate (shared with Task 42). Keys are typed into a session's input box only when ALL of these hold, and
 * nothing at all is sent otherwise:
 *   1. Claude Code itself reports the session idle and waiting for a new prompt (idleGate: Session.idle, from its hooks
 *      or its registry, never the screen), not needing you, working, starting or with a permission pending. Checked
 *      before the capture, again after it, and again before Enter.
 *   2. The pane, captured immediately before sending, shows Claude's empty idle input box at the bottom with no menu or
 *      prompt under it and Claude not working (pane.ts, emptyIdleBox: the answer path's own classification).
 *   3. The answer path's pane identity checks pass, inside every host-side script (answer.ts, CHECK): the pane id and
 *      window, the Claude process inside it in the foreground, not in copy mode, synchronize-panes off, input on.
 * The text (one line, at most MAX_ANSWER_CHARS) is a bracketed paste through the answer path's atomic check-and-send
 * script (SEND_PASTE_SCRIPT: capture, hash compare and paste in one invocation), here against the whole screen, so any
 * change since the capture the gate parsed sends nothing. Enter follows only through SEND_ENTER_SCRIPT, which re-checks
 * the screen read after the paste in the same invocation as the key (answer.ts, pressEnter), and only while that
 * screen is still Claude's input box with Claude not working.
 */

const NOTHING = 'Nothing was sent.';

/** The idle gate's first condition, from what Claude Code reports about the session: null when it holds, else why not. */
export function idleGate(s: Session): string | null {
  if (!s.tmux) return `This session has no tmux pane, so it cannot be messaged from here. ${NOTHING}`;
  if (!s.hostOnline) return `${s.host} is offline. ${NOTHING}`;
  if (!s.live || s.state === 'stopped') return `This session has stopped. ${NOTHING}`;
  if (s.starting) return `This session is still starting. ${NOTHING}`;
  if (s.permission || s.state === 'needs-you') return `This session is waiting for an answer, not a new message: use Answer. ${NOTHING}`;
  if (s.busy || s.state === 'working' || s.state === 'compacting') return `Claude is working in this session. Send a message once it has finished its turn. ${NOTHING}`;
  if (s.state !== 'asleep') return `This session is not waiting for a new prompt (${s.state}). ${NOTHING}`;
  if (!s.idle) return `Claude Code has not reported this session idle (no Stop hook event or idle registry status), so a message cannot be typed safely. ${NOTHING}`;
  return null;
}

/** Why the screen is not Claude's empty idle input box (the gate's second condition). */
function screenProblem(kind: string, busy: boolean | undefined): string {
  if (kind === 'permission') return `A permission prompt is showing in that pane. ${NOTHING}`;
  if (kind === 'menu') return `A menu is showing in that pane. ${NOTHING}`;
  if (kind === 'text' && busy) return `Claude is working in that pane. ${NOTHING}`;
  if (kind === 'text') return `Claude's input box in that pane is not empty (something is typed there on the PC). ${NOTHING}`;
  return `Claude's input box is not showing at the bottom of that pane. ${NOTHING}`;
}

const REPEAT = 'message';

export async function message(d: AnswerDeps, req: MessageRequest): Promise<Result<{ sent: string }>> {
  const t = resolve(d, req.sessionId);
  if ('ok' in t) return t;
  const text = cleanText(req.text);
  if (typeof text !== 'string') return text;
  return sendIdle(d, t, text, { repeat: REPEAT, repeatMessage: 'A message was just sent to this session. Wait for it to respond.', sent: `message (${text.length} characters)` });
}

/**
 * Task 42: Claude Code 2.1.296 renames a running session with its /rename command ("Rename the current conversation",
 * alias /name, argument [name]). It runs in Claude Code itself, with no model turn and no hook event: the session's
 * registry takes the name (name, nameSource "user") and its input box shows it on the top rule
 * (fixtures/panes/real-2.1.296/menu-captures.md).
 */
export const claudeRenameCommand = (name: string): string => `/rename ${name}`;

/**
 * "Also rename in Claude Code" (Task 42): types `/rename <name>` into an idle session, only under the idle gate, through
 * the same atomic check-and-paste as a message. Its Enter is stricter than a message's (enterExact): the screen after
 * the paste must show exactly this command as the draft and nothing new above the box, since Claude draws its
 * slash-command suggestions there and Enter would pick the highlighted one; and the whole screen, not just the box,
 * must still be that screen in the script that presses Enter. `name` is a cleaned board name (nicknames.ts).
 */
export async function renameInClaude(d: AnswerDeps, sessionId: string, name: string): Promise<Result<{ sent: string }>> {
  const t = resolve(d, sessionId);
  if ('ok' in t) return t;
  const text = cleanText(claudeRenameCommand(name));
  if (typeof text !== 'string') return text;
  return sendIdle(d, t, text, { repeat: `rename\0${name}`, repeatMessage: 'That name was just sent to Claude Code.', sent: `/rename (${name.length} characters)`, exact: true });
}

interface IdleSend { repeat: string; repeatMessage: string; sent: string; exact?: boolean }

/** The idle gate, the atomic paste and Enter, shared by Message (Task 43) and the Claude Code rename (Task 42). */
async function sendIdle(d: AnswerDeps, t: Target, text: string, o: IdleSend): Promise<Result<{ sent: string }>> {
  const gate = () => idleGate(current(d, t));
  const g1 = gate();
  if (g1) return fail('no_prompt', g1);
  const guard = d.guard ?? DEFAULT_GUARD;
  const lock = `${t.host.id}\0${t.ref.pane}`;
  if (!guard.begin(lock)) return fail('duplicate', 'Something is already being sent to this session.');
  try {
    if (guard.isRepeat(lock, o.repeat)) return fail('duplicate', o.repeatMessage);
    // Look immediately before sending: the pane identity checks run inside the capture script.
    const now = await capture(d, t);
    if (!now.ok) return now;
    const g2 = gate();
    if (g2) return fail('no_prompt', g2);
    if (!emptyIdleBox(now.screen, now.signals)) return fail('no_prompt', screenProblem(now.view.kind, now.view.busy));
    // The whole screen (ROWS 0): an idle screen holds still, so any change since this capture refuses the paste.
    const r = await run(d, t, SEND_PASTE_SCRIPT, { sha: now.sha, rows: '0' }, `clayclaude-${randomBytes(8).toString('hex')}`, text);
    if (r === 'changed') return fail('prompt_changed', `The session's screen changed just before sending. ${NOTHING}`);
    if (!r.ok) return r;
    if (!r.pasted) return fail('failed', 'unexpected reply from tmux');
    const g3 = gate();
    if (g3) return fail('no_prompt', `The ${o.exact ? 'command' : 'message'} was typed into the box but Enter was not pressed: ${g3.replace(` ${NOTHING}`, '')} Check the session on the PC.`);
    const e = o.exact ? await enterExact(d, t, r.pasted, now.screen, text) : await pressEnter(d, t, r.pasted, true);
    if (e) return e;
    guard.sent(lock, o.repeat);
    return { ok: true, sent: o.sent };
  } finally {
    guard.end(lock);
  }
}

/** How many times Enter is retried when the screen moved after the paste but still passes every check. */
const ENTER_RETRIES = 2;

/**
 * Enter after a pasted command (Task 42), only while the screen read after the paste is Claude's input box, Claude not
 * working, the draft in it exactly `text`, and the lines above it those of the empty idle screen read before the paste
 * (`before`; a line scrolled off the top as the box grew is allowed, a line added is not), and only while the whole
 * screen is still, byte for byte, that one (SEND_ENTER_SCRIPT with ROWS 0: the check and the key in one host-side
 * script). Anything else: no Enter, and the command stays in the box for the PC.
 */
async function enterExact(d: AnswerDeps, t: Target, pasted: { sha: string; screen: string }, before: string, text: string): Promise<Fail | null> {
  const want = text.replace(/\s+/gu, '');
  const was = pastedBox(before)?.above;
  let read = pasted;
  for (let attempt = 0; ; attempt++) {
    const signals = { permission: current(d, t).permission === true, busy: current(d, t).busy === true };
    const box = pastedBox(read.screen, signals);
    const above = !!box && !!was && box.above.length <= was.length && box.above.every((l, i) => l === was[was.length - box.above.length + i]);
    if (!box || box.draft !== want || !above)
      return fail('prompt_changed', `The screen did not show the command as typed (or something appeared above Claude's input box), so Enter was not pressed. The command may be in the box: check the session on the PC.`);
    const r = await run(d, t, SEND_ENTER_SCRIPT, { sha: read.sha, rows: '0' }, '-');
    if (r !== 'changed') return r.ok ? null : r;
    if (attempt >= ENTER_RETRIES) return fail('prompt_changed', 'The screen kept changing after the command was typed, so Enter was not pressed. The command is in the box: check the session on the PC.');
    const c = await capture(d, t);
    if (!c.ok) return c;
    read = c;
  }
}

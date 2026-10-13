import { promptHash } from './hash.js';
import type { PromptOption, PromptView } from './types.js';

export type ParsedPane = Omit<PromptView, 'quickReplies'>;

/**
 * What Claude Code itself reports about the session, from signals the model cannot write (Session.permission: the
 * registry's waitingFor, the "needs your permission" Notification hook). A pending permission makes the screen a
 * permission prompt whatever it shows. `busy` (Session.busy, the registry's status) marks an input box busy.
 */
export interface PaneSignals { permission?: boolean; busy?: boolean }

/**
 * The only answers the tablet offers for a permission prompt: Yes sends the digit 1 and No sends Escape (answer.ts,
 * SEND_PERMISSION_SCRIPT); the keys never depend on the screen. The digit 1 picks Claude's option 1, which is "Yes"
 * (allow once) only on some prompts: on a plan approval (ExitPlanMode) it also switches the session to bypass, auto or
 * accept-edits mode. So Yes is offered only when Claude's own option 1 on screen is positively a plain "Yes"
 * (plainYesFirst); otherwise the prompt is No only (PERMISSION_NO_ONLY). Other choices are made on the PC.
 */
export const PERMISSION_OPTIONS: readonly PromptOption[] = Object.freeze([
  Object.freeze({ key: 'yes', label: 'Yes', selected: false }),
  Object.freeze({ key: 'no', label: 'No', selected: false }),
]) as readonly PromptOption[];
export const PERMISSION_NO_ONLY: readonly PromptOption[] = Object.freeze([PERMISSION_OPTIONS[1]]) as readonly PromptOption[];

/*
 * Classification (safety does not depend on reading the model's text):
 *   1. The session reports a pending permission                      -> permission
 *   2. The bottom line is Claude's "Enter to confirm · Esc to cancel" -> its startup confirm dialog (folder trust,
 *      external imports) when one Yes and one No option, one of them selected, sit directly above; else permission
 *   3. The bottom line is exactly Claude's question footer ("Enter to select · ↑/↓ to navigate · Esc to cancel", column 0)
 *                                                                    -> AskUserQuestion menu when a numbered run ends
 *      directly above it and Claude's permission question is not directly above the run; else permission
 *   4. The bottom of the screen is Claude's input box: a column-0 rule, a "❯ " line, a column-0 rule, and only status
 *      rows (nothing numbered or prompt-shaped) under it                -> free text, marked busy while Claude works
 *      (Claude Code queues a reply typed then; answer.ts checks only the input box and the rows under it, inputBoxTail)
 *   5. Anything numbered or prompt-shaped near the bottom              -> permission
 *   6. Otherwise                                                       -> none (nothing is answered)
 * Text the model writes (a command, a description, a file path, an "allow <prefix>" label) is always above the bottom
 * line of the prompt Claude draws, so it can only ever make an unrecognised screen fall to permission or none.
 * A permission prompt offers Yes only when Claude's options at the bottom of the screen start with a plain "1. Yes";
 * model text sits above those options, so it can only take Yes away.
 */

// A solid rule at column 0, or a box's top corner: the top of a prompt or of the input box. Text the model writes in a
// prompt is indented (a " │ " gutter, a description's one-column pad, a diff's line numbers), so it never starts one.
const FRAME = /^[─━═]{8,}\s*$/;
// The top rule of a named session's input box (`claude --name`, or after /rename; Task 42): Claude Code 2.1.296 draws the
// session's name at its right, "────── name ─". In a narrow pane the rule before the name shrinks to one dash, or the
// name is cut with an ellipsis and nothing is left before it but one space (fixtures/panes/real-2.1.296/named-idle*.txt).
// Taken as the box's top only directly over its "❯ " line, at Claude's own columns: a draft's continuation lines are
// indented two columns and never start one.
const NAMED_TOP = /^(?:[─━═]+ | )\S(?:.*\S)? [─━═]\s*$/;
const TOP_FRAME = /^(?:[─━═]{8,}|[╭┌][─━═]+[╮┐])\s*$/;
const RULE = /^\s*[─━═╌╍┄┅┈┉_-]{8,}\s*$/;
const RULE_ONLY = /^(\s*)([─━═╌╍┄┅┈┉])\2{7,}\s*$/;
const SHORT_RULE = 24;
const BORDER = /^[╭╰┌└][─━═]+[╮╯┐┘]\s*$/;
const BOXED = /^[│┃]\s?(.*?)\s*[│┃]\s*$/;
const OPT = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const MARK = /^\s*[❯›>]\s*\d/;
const PROMPT = /^\s*[❯>]\s?(.*)$/;
// Claude's spinner row while it works: "✶ Effecting… (2s · ↓ 237 tokens · thinking)", "✶ Computing…" (2.1.296), or
// "✻ Cooking… (47s · esc to interrupt)". A finished turn's "✻ Cooked for 4s · done" has no ellipsis.
const SPINNER = /^\s*[✻✶✳✢✽·*]\s+\S+…(?:\s|$)/;
// Spinner and status rows, left out of the context shown for a text reply or a menu; never out of a permission prompt.
const NOISE = [/esc to interrupt/i, /^\s*[⏵⏸]/, /\/clear to save/i, SPINNER];
// Claude working: its spinner row near the input box. Only the sheet's hash depends on it (textView): model text that
// looks like one changes no key that is sent.
const WORKING = [/esc to interrupt/i, SPINNER];
const WORKING_ROWS = 15;
// Lines only a prompt draws: a question, a footer, an "(esc)" option. Never allowed in the status rows under the input box.
const PROMPTISH = /Do you want to|Would you like to|Esc to cancel|\(esc\)|Tab to amend|Enter to (?:confirm|select|approve)/i;
// Claude's startup confirm footer, at the column of the dialog's own options as 2.1.296 draws it: 1 for the folder-trust
// question, 2 for the external-imports one (fixtures/panes/real-2.1.296). findConfirm checks the options' column.
const CONFIRM_FOOT = /^( {1,2})Enter to confirm · Esc to cancel$/;
// Claude's AskUserQuestion footer, exactly as 2.1.296 draws it at column 0 (fixtures/panes/real-2.1.296/askuser.txt).
// Anything else at the bottom falls to permission.
const QUESTION_FOOT = /^Enter to select · ↑\/↓ to navigate · Esc to cancel$/;
// Claude's own question over a permission prompt's options ("Do you want to proceed?", "Do you want to make this edit
// to x?"). Directly above a numbered run, the run is a permission prompt's options, never an AskUserQuestion menu.
const PERMISSION_QUESTION = /^(?:Do you want to|Would you like to)\b.*\?$/;
const TAIL = 16;
const DETAIL_LINES = 24;
const DETAIL_CHARS = 1500;
// A permission sheet shows the whole screen: enough for any real pane, cut (with a marker) only beyond it.
const PERM_LINES = 250;
const PERM_CHARS = 30000;
// Lines Claude draws under a prompt's last option: a footer, a wrapped last label or description.
const UNDER_OPTIONS = 4;
/** Heads the sheet when no frame is on screen: the prompt is taller than the pane, so its top is not shown. */
export const TOP_OFF_SCREEN = '↑ The top of this prompt is above the screen. Read it on the PC.';

/**
 * The bullet Claude draws at column 0 of a tool call's row. While a permission prompt waits, 2.1.296 blinks the pending
 * tool's bullet: that column is "●", then a space (fixtures/panes/real-2.1.296/perm-bash.txt and perm-bash-manual.txt).
 * Every hash, here and in the send scripts' last check (answer.ts, CHECK's `norm`), reads it as a space, so the blink
 * never changes a prompt's hash. What the sheet shows is not changed.
 */
export const BLINK = /^[●⏺]/;
/** A line as every hash reads it: a bullet at column 0 is a space (BLINK). */
export const steady = (line: string): string => line.replace(BLINK, ' ');

const NONE: ParsedPane = { kind: 'none', hash: promptHash(['none']), title: '', detail: '', options: [] };

function clean(line: string): string {
  if (BORDER.test(line)) return '────────────────────────';
  const m = BOXED.exec(line);
  return (m ? m[1] : line).replace(/\s+$/, '');
}

/** Parse the visible text of a tmux pane (`capture-pane -p -J`). */
export function parsePane(raw: string, signals: PaneSignals = {}): ParsedPane {
  const screen = raw.replace(/\r/g, '').split('\n').map((l) => l.replace(/\s+$/, ''));
  while (screen.length && screen[screen.length - 1] === '') screen.pop();
  if (!screen.length) return NONE;
  if (signals.permission) return permission(screen);

  const lines = screen.map(clean);
  const foot = lines[lines.length - 1];
  if (CONFIRM_FOOT.test(foot)) return findConfirm(lines) ?? permission(screen);
  if (QUESTION_FOOT.test(foot)) return findQuestion(lines) ?? permission(screen);
  const box = findBox(lines);
  if (box !== -1) return textView(lines, box, signals.busy === true);
  if (lines.slice(-TAIL).some((l) => OPT.test(l) || PROMPTISH.test(l))) return permission(screen);
  return NONE;
}

/**
 * A permission prompt: the whole visible screen exactly as the terminal shows it, and Yes / No, or No alone when
 * Claude's option 1 is not a plain "Yes". No line is dropped or cut at a frame: a prompt can be several stacked boxes
 * (a plan approval's plan, then its options), any of its frames can be off screen, and the model can shape its text
 * like a frame, a spinner or a status row, so no line of the screen can be told apart as not part of the prompt. Only a
 * line that is one rule character repeated is drawn short, a very long screen loses its middle behind a visible marker,
 * and a screen with no frame on it is headed by TOP_OFF_SCREEN. The hash covers every line, uncut.
 */
function permission(screen: string[]): ParsedPane {
  const region = screen.slice();
  while (region.length && region[0].trim() === '') region.shift();
  const shown = region.map((l) => { const r = RULE_ONLY.exec(l); return r ? r[1] + r[2].repeat(SHORT_RULE) : l; });
  if (!region.some((l) => TOP_FRAME.test(l))) shown.unshift(TOP_OFF_SCREEN);
  const yes = plainYesFirst(region.map(clean));
  return { kind: 'permission', hash: promptHash(['permission', yes ? 'yes' : 'no-only', ...region.map(steady)]), title: '', detail: cut(shown, PERM_LINES, PERM_CHARS),
    options: (yes ? PERMISSION_OPTIONS : PERMISSION_NO_ONLY).map((o) => ({ ...o })) };
}

/**
 * True only when the screen ends in Claude's own option list and its option 1 is exactly "Yes" (allow once), so that
 * the digit 1 approves this one request and nothing more. Bottom-up: at most UNDER_OPTIONS lines (a footer, a wrapped
 * last option) under the last numbered line, then options numbered down to 1 at one column with only their own wrapped
 * lines (indented past the numbers) between them, no gaps, and option 1 a single line reading "Yes". Model text in a
 * prompt is above Claude's options, and a wrapped label is indented past the numbers, so neither can be read as the
 * option 1 here; at worst it breaks the run, and the prompt is No only.
 */
function plainYesFirst(lines: string[]): boolean {
  let i = lines.length - 1, under = 0;
  for (; i >= 0 && !OPT.test(lines[i]); i--) {
    if (lines[i].trim() === '' || RULE.test(lines[i])) continue;
    if (++under > UNDER_OPTIONS) return false;
  }
  if (i < 0) return false;
  const col = numCol(lines[i]);
  let n = Number(OPT.exec(lines[i])![1]), below = i;
  if (n < 2) return false;
  for (let j = i - 1; j >= 0; j--) {
    if (deeper(lines[j], col)) continue;                    // a wrapped label or description of the option above
    const m = OPT.exec(lines[j]);
    if (!m || numCol(lines[j]) !== col || Number(m[1]) !== n - 1) return false;
    n--;
    if (n === 1) return m[2] === 'Yes' && below === j + 1;
    below = j;
  }
  return false;
}

/**
 * The top rule of Claude's input box when it is the bottom of the screen, else -1. Bottom-up: status rows (nothing
 * numbered or prompt-shaped), then the box's closing column-0 rule, its draft (any lines, a numbered list included), and
 * its opening column-0 rule directly over a "❯ " line. The first rule from the bottom must close the box: a box drawn
 * higher up is earlier output.
 */
function findBox(lines: string[]): number {
  let bottom = lines.length - 1;
  for (; bottom >= 0 && !FRAME.test(lines[bottom]); bottom--) if (OPT.test(lines[bottom]) || PROMPTISH.test(lines[bottom])) return -1;
  let top = bottom - 1;
  while (top >= 0 && !FRAME.test(lines[top]) && !(NAMED_TOP.test(lines[top]) && top + 1 < bottom && /^[❯>]/.test(lines[top + 1]))) top--;
  if (top < 0 || top + 1 >= bottom || !PROMPT.test(lines[top + 1])) return -1;
  return top;
}

/**
 * Claude's input box. Idle, the hash covers the lines above it (what is being replied to), so a reply typed for one
 * turn is not sent after the next. While Claude works, what is above it streams and its spinner redraws every frame:
 * the hash is then just "busy", so a reply typed then still goes in (Claude Code queues it for the model's next pause).
 */
function textView(lines: string[], boxTop: number, reportedBusy: boolean): ParsedPane {
  const above = lines.slice(0, boxTop).filter((l) => l.trim() && !NOISE.some((re) => re.test(l))).slice(-10);
  const detail = above.map((l) => l.trim()).join('\n').slice(-800);
  const stable = above.map((l) => steady(l).replace(/\d+/g, '#'));
  const working = reportedBusy || lines.slice(Math.max(0, boxTop - WORKING_ROWS)).some((l) => WORKING.some((re) => re.test(l)));
  if (working) return { kind: 'text', hash: promptHash(['text', 'busy']), title: '', detail, options: [], busy: true };
  return { kind: 'text', hash: promptHash(['text', ...stable]), title: '', detail, options: [] };
}

/**
 * For a screen parsed as Claude's input box (text): its rows from the box's top rule to the bottom of the capture,
 * exactly as captured (`raw`, CAPTURE_SCRIPT's text with its one trailing newline), else null. A typed reply's last
 * check compares these rows, not the whole screen (answer.ts): above them Claude's spinner redraws every frame while it
 * works, and a permission prompt or a menu Claude draws replaces the input box, so these rows change when one appears.
 */
export function inputBoxTail(raw: string, signals: PaneSignals = {}): string | null {
  if (parsePane(raw, signals).kind !== 'text') return null;
  const rows = (raw.endsWith('\n') ? raw.slice(0, -1) : raw).split('\n');
  const top = findBox(rows.map((l) => clean(l.replace(/\r/g, '').replace(/\s+$/, ''))));
  return top === -1 ? null : rows.slice(top).join('\n');
}

/**
 * The idle gate's second condition (Tasks 43 and 42): the screen is Claude's input box at the bottom, as the answer path
 * classifies it (parsePane: a free-text input box with only status rows under it, so no menu or prompt anywhere below
 * the conversation), Claude is not working (no spinner, not reported busy), and the box is empty: one "❯" line between
 * its rules, so nothing typed on the PC is added to. Anything else is false: nothing is typed then.
 */
export function emptyIdleBox(raw: string, signals: PaneSignals = {}): boolean {
  const p = parsePane(raw, signals);
  if (p.kind !== 'text' || p.busy) return false;
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => clean(l.replace(/\s+$/, '')));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const top = findBox(lines);
  if (top === -1 || top + 2 >= lines.length || !FRAME.test(lines[top + 2])) return false;
  return /^[❯>]$/.test(lines[top + 1].trim());
}

/**
 * Task 42: what a pasted command left on screen, for the check before its Enter. `draft` is the text in Claude's input
 * box (its "❯ " stripped, wrapped lines joined, all white space removed, since a wrap can drop or keep a space), and
 * `above` the lines above the box (steadied, trailing blank lines dropped). null when the screen is not Claude's
 * input box with Claude not working.
 */
export function pastedBox(raw: string, signals: PaneSignals = {}): { draft: string; above: string[] } | null {
  const p = parsePane(raw, signals);
  if (p.kind !== 'text' || p.busy) return null;
  const lines = raw.replace(/\r/g, '').split('\n').map((l) => clean(l.replace(/\s+$/, '')));
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const top = findBox(lines);
  if (top === -1) return null;
  let bottom = top + 1;
  while (bottom < lines.length && !FRAME.test(lines[bottom])) bottom++;
  const draft = lines.slice(top + 1, bottom).map((l, i) => (i === 0 ? l.replace(/^[❯>] ?/, '') : l)).join('').replace(/\s+/gu, '');
  const above = lines.slice(0, top).map(steady);
  while (above.length && above[above.length - 1].trim() === '') above.pop();
  return { draft, above };
}

function groupAbove(lines: string[], from: number): { text: string[]; start: number } {
  let i = from;
  while (i >= 0 && lines[i].trim() === '') i--;           // skip blank gap
  const text: string[] = [];
  while (i >= 0 && lines[i].trim() !== '' && !RULE.test(lines[i])) { text.unshift(lines[i].trim()); i--; }
  return { text, start: i };
}

/** The column of an option's number. A menu's numbers line up; a wrapped label is indented past them. */
const numCol = (line: string): number => line.search(/\d/);
/** A line that belongs to the option above it (a wrapped label or a description): indented past its number. */
const deeper = (line: string, col: number): boolean => line.trim() !== '' && line.search(/\S/) > col;

/**
 * An AskUserQuestion menu, whose last line is Claude's question footer. Its options are numbered runs 1,2,3… at one
 * column; a run continues across lines indented past its numbers (a description the model wrote, however long, even
 * one starting with a number), a short gap of blank ones, and at most one rule: Claude 2.1.296 draws a rule between
 * the model's answers ("4. Type something.") and its own extra choice ("5. Chat about this"), numbering straight on, so
 * each key stays the number Claude draws. The menu is the run that ends directly above the footer, with only blank or
 * deeper lines between, so a numbered list in the question text never becomes its options.
 */
function findQuestion(lines: string[]): ParsedPane | null {
  const foot = lines.length - 1;
  type Run = { idx: number[]; nums: number[]; col: number };
  const runs: Run[] = [];
  const open = new Map<number, Run>();
  for (let i = 0; i < foot; i++) {
    const m = OPT.exec(lines[i]);
    if (!m) continue;
    const n = Number(m[1]), col = numCol(lines[i]);
    const cur = open.get(col);
    const last = cur ? cur.idx[cur.idx.length - 1] : -1;
    const gap = lines.slice(last + 1, i);
    const rules = gap.filter((t) => RULE.test(t)).length;
    const joins = cur && n === cur.nums[cur.nums.length - 1] + 1 && rules <= 1
      && gap.every((t) => t.trim() === '' || RULE.test(t) || deeper(t, col))
      && (gap.every((t) => deeper(t, col) && !RULE.test(t)) || gap.length <= 3);
    if (joins) { cur.idx.push(i); cur.nums.push(n); }
    else if (n === 1) { const r = { idx: [i], nums: [1], col }; runs.push(r); open.set(col, r); }
  }
  const found = runs.filter((r) => r.idx.length >= 2).sort((a, b) => b.idx[b.idx.length - 1] - a.idx[a.idx.length - 1])[0];
  if (!found) return null;
  const end = found.idx[found.idx.length - 1];
  if (!lines.slice(end + 1, foot).every((t) => t.trim() === '' || deeper(t, found.col))) return null;
  // Answers are single digits (decision 6), so a longer menu only offers its first nine options.
  const run = found.idx.slice(0, 9);

  const options: PromptOption[] = run.map((at, k) => {
    const m = OPT.exec(lines[at])!;
    const stop = k + 1 < run.length ? run[k + 1] : Math.min(foot, at + 4);
    const desc: string[] = [];
    for (let j = at + 1; j < stop; j++) {
      const t = lines[j];
      if (!deeper(t, found.col) || !/^\s{3,}/.test(t) || RULE.test(t)) break;
      desc.push(t.trim());
    }
    return { key: m[1], label: m[2], selected: MARK.test(lines[at]), ...(desc.length ? { description: desc.join(' ') } : {}) };
  });

  const t = groupAbove(lines, run[0] - 1);
  if (t.text.some((l) => PERMISSION_QUESTION.test(l))) return null;
  const title = t.text.join(' ');
  const span = spanAbove(lines, t.start);
  return { kind: 'menu', hash: promptHash(['menu', title, ...span.map(steady), '', ...options.map((o) => `${o.selected ? '>' : ' '}${o.key}.${o.label}\t${o.description ?? ''}`)]),
    title, detail: cut(span.map(shortRule), DETAIL_LINES, DETAIL_CHARS), options };
}

const CONFIRM_OPT = /^\s*([❯›>]\s*)?(\S.*?)\s*$/;

/**
 * One of Claude's startup confirm dialogs (Task 40): the folder-trust question ("Accessing workspace: <folder> … Is this
 * a project you created or one you trust?") and the external-imports question ("Allow external CLAUDE.md file
 * imports?"). Both draw "❯ No, …" / "Yes, …" without numbers over an "Enter to confirm · Esc to cancel" footer, the
 * bottom line. An option is picked by moving the cursor (answer.ts, SEND_MOVE_SCRIPT); its key is its position on screen.
 */
function findConfirm(lines: string[]): ParsedPane | null {
  const footCol = CONFIRM_FOOT.exec(lines[lines.length - 1])![1].length;
  let i = lines.length - 2;
  while (i >= 0 && lines[i].trim() === '') i--;
  const opts: { label: string; selected: boolean }[] = [];
  for (; i >= 0 && lines[i].trim() !== '' && !RULE.test(lines[i]) && opts.length < 9; i--) {
    if (OPT.test(lines[i])) return null;                   // these dialogs hide their numbers
    const m = CONFIRM_OPT.exec(lines[i])!;
    opts.unshift({ label: m[2], selected: !!m[1] });
  }
  if (opts.length < 2 || opts.filter((o) => /^Yes\b/.test(o.label)).length !== 1 || opts.filter((o) => /^No\b/.test(o.label)).length !== 1) return null;
  if (opts.filter((o) => o.selected).length !== 1) return null;
  // The footer starts at the options' own column (the selected one's "❯"), as Claude draws its dialog.
  if (lines.slice(i + 1, lines.length - 1).find((l) => /^\s*[❯›>]/.test(l))!.search(/\S/) !== footCol) return null;
  const span = spanAbove(lines, i);
  const options = opts.map((o, k) => ({ key: String(k + 1), label: o.label, selected: o.selected }));
  return { kind: 'menu', trust: true, title: question(span), detail: cut(span.map(shortRule), DETAIL_LINES, DETAIL_CHARS), options,
    hash: promptHash(['trust', ...span.map(steady), '', ...options.map((o) => `${o.selected ? '>' : ' '}${o.key}.${o.label}`)]) };
}

/**
 * The dialog's own question: the first sentence ending in "?", after any lead-in ("Accessing workspace: <folder>",
 * "Quick safety check:"). A sentence ends at ":", "." or "!" followed by a space, so "CLAUDE.md" stays inside one.
 */
function question(span: string[]): string {
  const q = /(?:^|[:.!]\s+)([A-Z](?:[^?:.!]|[:.!](?!\s))*\?)/.exec(span.map((l) => l.trim()).filter(Boolean).join(' '));
  return q ? q[1] : span.find((l) => l.trim())?.trim() ?? '';
}

/** Lines from just below the nearest frame above `end` (or the top of the capture) down to `end`, blank edges dropped. */
function spanAbove(lines: string[], end: number): string[] {
  let top = end;
  while (top >= 0 && !FRAME.test(lines[top])) top--;
  let span = lines.slice(top + 1, end + 1);
  if (top < 0) span = span.filter((l) => !NOISE.some((re) => re.test(l)));
  while (span.length && span[0].trim() === '') span.shift();
  while (span.length && (span[span.length - 1].trim() === '' || RULE.test(span[span.length - 1]))) span.pop();
  return span;
}

/** A menu's detail line: trimmed, a rule drawn short so it never widens the sheet. */
function shortRule(l: string): string {
  const r = RULE_ONLY.exec(l);
  return r ? r[2].repeat(SHORT_RULE) : l.trim();
}

/** Join lines, cutting the middle out with a visible marker when there are too many lines or characters. */
function cut(lines: string[], maxLines: number, maxChars: number): string {
  let out = lines;
  if (out.length > maxLines) {
    const head = Math.ceil((maxLines - 1) / 2), tail = maxLines - 1 - head;
    const n = out.length - head - tail;
    out = [...out.slice(0, head), `… ${n} more line${n === 1 ? '' : 's'} …`, ...out.slice(-tail)];
  }
  const text = out.join('\n');
  if (text.length <= maxChars) return text;
  const head = Math.ceil(maxChars * 0.6), tail = maxChars - head;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} more characters …\n${text.slice(-tail)}`;
}

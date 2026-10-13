import { promptHash } from './hash.js';
import type { PromptOption, PromptView } from './types.js';

export type ParsedPane = Omit<PromptView, 'quickReplies'>;

// Solid and dashed rules. Claude Code 2.1.296 draws the command between dashed rules (U+254C) with no blank line
// before the question, so a dashed rule must end the question just as a solid one does.
const RULE = /^\s*[─━═╌╍┄┅┈┉_-]{8,}\s*$/;
// A rule drawn in box characters is shown short in the detail: a full-width one would widen the answer sheet.
const BOX_RULE = /^\s*([─━═╌╍┄┅┈┉])\1{7,}\s*$/;
const SHORT_RULE = 24;
const BORDER = /^\s*[╭╰┌└][─━═]+[╮╯┐┘]\s*$/;
const OPT = /^\s*(?:[❯›>]\s*)?(\d{1,2})\.\s+(\S.*?)\s*$/;
const MARK = /^\s*[❯›>]\s*\d/;
const PROMPT = /^\s*[❯>]\s?(.*)$/;
const FOOTER = /(Enter to select|Esc to cancel|to navigate)/i;
const NOISE = [/esc to interrupt/i, /^\s*[⏵⏸]/, /\/clear to save/i, /^\s*[✻✶✳✢✽·*]\s+\S+….*\)/];
const TAIL = 16;
// The rule or border that opens a prompt. It starts at column 0; command text and diff lines are indented or
// numbered, so a line of dashes inside a command never matches and cannot cut the command short.
const FRAME = /^[─━═]{8,}\s*$/;
const DETAIL_LINES = 24;
const DETAIL_CHARS = 1500;

function clean(line: string): string {
  if (BORDER.test(line)) return '────────────────────────';
  const m = /^\s*[│┃]\s?(.*?)\s*[│┃]?\s*$/.exec(line);
  return (m ? m[1] : line).replace(/\s+$/, '');
}

function groupAbove(lines: string[], from: number): { text: string[]; start: number } {
  let i = from;
  while (i >= 0 && lines[i].trim() === '') i--;           // skip blank gap
  const text: string[] = [];
  while (i >= 0 && lines[i].trim() !== '' && !RULE.test(lines[i])) { text.unshift(lines[i].trim()); i--; }
  return { text, start: i };
}

/** Parse the visible text of a tmux pane (`capture-pane -p -J`). */
export function parsePane(raw: string): ParsedPane {
  const lines = raw.replace(/\r/g, '').split('\n').map(clean);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();

  const trust = findTrust(lines);
  if (trust) return trust;

  const boxTop = findBox(lines);

  if (boxTop === -1) {
    const menu = findMenu(lines);
    if (menu) return menu;
    return { kind: 'none', hash: promptHash(['none']), title: '', detail: '', options: [] };
  }
  const above = lines.slice(0, boxTop).filter((l) => l.trim() && !NOISE.some((re) => re.test(l))).slice(-10);
  const detail = above.map((l) => l.trim()).join('\n').slice(-800);
  const stable = above.map((l) => l.replace(/\d+/g, '#'));
  return { kind: 'text', hash: promptHash(['text', ...stable]), title: '', detail, options: [] };
}

/**
 * The top rule of the input box (a prompt line directly under a column-0 frame rule), or -1. Two shapes count:
 * - the pair sits in the bottom 8 lines (spec layout: a one-line draft over a short status area), the prompt line not
 *   shaped like an option;
 * - anywhere on screen, if the box is closed by a frame rule with only status rows (no numbered lines) below it,
 *   however many there are. This covers a multi-line draft, a status area of any height (transient rows such as an
 *   update notice or the auto-compact warning come and go), and a draft that is itself a numbered list ("❯ 1. …").
 * A real menu never qualifies: its options are numbered lines, and they sit below any input-box-shaped pair above it.
 */
function findBox(lines: string[]): number {
  for (let i = lines.length - 1; i >= 1; i--) {
    // The box's top rule is a frame at column 0 in both layouts. A rule inside a command or diff is indented, so a
    // "----" line followed by a "> ..." line in a permission prompt is never read as the input box.
    if (!PROMPT.test(lines[i]) || !FRAME.test(lines[i - 1])) continue;
    if (i >= lines.length - 8 && !OPT.test(lines[i])) return i - 1;
    let bottom = i + 1;
    while (bottom < lines.length && !FRAME.test(lines[bottom])) bottom++;
    if (bottom >= lines.length) continue;
    const status = lines.slice(bottom + 1);
    if (!status.some((l) => OPT.test(l))) return i - 1;
  }
  return -1;
}

function findMenu(lines: string[]): ParsedPane | null {
  // Group numbered lines into runs 1,2,3… that are not split by a rule or a footer.
  type Run = { idx: number[]; nums: number[] };
  const runs: Run[] = [];
  let cur: Run | null = null;
  let lastIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (RULE.test(l) || FOOTER.test(l)) { cur = null; continue; }
    const m = OPT.exec(l);
    if (m) {
      const n = Number(m[1]);
      if (cur && n === cur.nums[cur.nums.length - 1] + 1 && i - lastIdx <= 4) { cur.idx.push(i); cur.nums.push(n); }
      else if (n === 1) { cur = { idx: [i], nums: [1] }; runs.push(cur); }
      else cur = null;
      lastIdx = i;
    }
  }
  const found = [...runs].reverse().find((r) => r.idx.length >= 2);
  if (!found) return null;
  // Answers are single digits (decision 6), so a longer menu only offers its first nine options.
  const run = { idx: found.idx.slice(0, 9), nums: found.nums.slice(0, 9) };
  const end = run.idx[run.idx.length - 1];
  if (lines.length - 1 - end > TAIL) return null; // an old list, far above the bottom of the screen
  // A menu has no input box below it. An input-box pair (a column-0 frame, then a prompt line not shaped like an
  // option) under the list means the list is earlier output, even when findBox could not place the box itself.
  for (let j = end + 2; j < lines.length; j++) {
    if (FRAME.test(lines[j - 1]) && PROMPT.test(lines[j]) && !OPT.test(lines[j])) return null;
  }

  const options: PromptOption[] = run.idx.map((at, k) => {
    const m = OPT.exec(lines[at])!;
    const stop = k + 1 < run.idx.length ? run.idx[k + 1] : Math.min(lines.length, at + 4);
    const desc: string[] = [];
    for (let j = at + 1; j < stop; j++) {
      const t = lines[j];
      if (t.trim() === '' || RULE.test(t) || FOOTER.test(t) || OPT.test(t)) break;
      if (/^\s{3,}/.test(t)) desc.push(t.trim()); else break;
    }
    return { key: m[1], label: m[2], selected: MARK.test(lines[at]), ...(desc.length ? { description: desc.join(' ') } : {}) };
  });

  const first = run.idx[0];
  const t = groupAbove(lines, first - 1);
  const title = t.text.join(' ');
  // The detail is everything between the frame and the title: the header ("Bash command", "Edit file <path>") and
  // the whole command or diff, blank lines included (heredocs, commit messages). The hash covers all of it, untruncated;
  // only the text shown is shortened, with a marker.
  const span = spanAbove(lines, t.start);
  const detail = shown(span);
  // Descriptions are in the hash too: a long option wraps onto a second line (read as its description), and the
  // wrapped part, such as the folder in "don't ask again for … in <folder>", must change the hash when it changes.
  return { kind: 'menu', hash: promptHash(['menu', title, ...span, '', ...options.map((o) => `${o.key}.${o.label}\t${o.description ?? ''}`)]), title, detail, options };
}

const CONFIRM = /Enter to confirm/i;
const TRUST_OPT = /^\s*([❯›>]\s*)?(?:\d{1,2}\.\s+)?(\S.*?)\s*$/;
const TRUST_TITLE = 'Do you trust the files in this folder?';

/**
 * Claude's folder-trust question (Task 40), shown before a session registers in a folder the account never trusted.
 * In 2.1.296 it reads "Accessing workspace: <folder> … Is this a project you created or one you trust? …", then
 * "❯ No, exit" / "Yes, I trust this folder" without numbers, over an "Enter to confirm · Esc to cancel" footer.
 * It counts only with that footer close to the bottom, a Yes and a No option directly above it, and "trust" in the
 * text: a permission prompt has numbered options and another footer. Keys 1, 2… follow the options' order on screen.
 */
function findTrust(lines: string[]): ParsedPane | null {
  let foot = lines.length - 1;
  while (foot >= 0 && lines.length - 1 - foot <= TAIL && !CONFIRM.test(lines[foot])) foot--;
  if (foot < 0 || lines.length - 1 - foot > TAIL) return null;
  let i = foot - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  const opts: { label: string; selected: boolean }[] = [];
  for (; i >= 0 && lines[i].trim() !== '' && !RULE.test(lines[i]) && opts.length < 9; i--) {
    const m = TRUST_OPT.exec(lines[i])!;
    opts.unshift({ label: m[2], selected: !!m[1] });
  }
  if (opts.length < 2 || !opts.some((o) => /^Yes\b/.test(o.label)) || !opts.some((o) => /^No\b/.test(o.label))) return null;
  if (opts.filter((o) => o.selected).length !== 1) return null;
  const span = spanAbove(lines, i);
  if (!/trust/i.test([...span, ...opts.map((o) => o.label)].join(' '))) return null;
  // The dialog's own question: the first sentence ending in "?", after any "Quick safety check:" lead-in.
  const q = /(?:^|[:.!]\s+)([A-Z][^?:.!]*\?)/.exec(span.map((l) => l.trim()).join(' '));
  const options = opts.map((o, k) => ({ key: String(k + 1), label: o.label, selected: o.selected }));
  return { kind: 'menu', trust: true, title: q ? q[1] : TRUST_TITLE, detail: shown(span), options,
    hash: promptHash(['trust', ...span, '', ...options.map((o) => `${o.selected ? '>' : ' '}${o.key}.${o.label}`)]) };
}

/** Lines from just below the nearest frame above `end` (or the top of the capture) down to `end`, blank edges dropped. */
function spanAbove(lines: string[], end: number): string[] {
  let top = end;
  while (top >= 0 && !FRAME.test(lines[top])) top--;
  let span = lines.slice(top + 1, end + 1);
  // Without a frame the span reaches into earlier output, which may hold a ticking spinner or status line.
  if (top < 0) span = span.filter((l) => !NOISE.some((re) => re.test(l)));
  while (span.length && span[0].trim() === '') span.shift();
  // The rule the title sits under (a dashed one, in the 2.1.296 layout) closes the span; it is not part of the detail.
  while (span.length && (span[span.length - 1].trim() === '' || RULE.test(span[span.length - 1]))) span.pop();
  return span;
}

/** The detail as shown: trimmed lines, the middle cut out with a visible marker when it is too long. */
function shown(span: string[]): string {
  let out = span.map((l) => {
    const r = BOX_RULE.exec(l);
    return r ? r[1].repeat(SHORT_RULE) : l.trim();
  });
  if (out.length > DETAIL_LINES) {
    const head = Math.ceil((DETAIL_LINES - 1) / 2), tail = DETAIL_LINES - 1 - head;
    const cut = out.length - head - tail;
    out = [...out.slice(0, head), `… ${cut} more line${cut === 1 ? '' : 's'} …`, ...out.slice(-tail)];
  }
  const text = out.join('\n');
  if (text.length <= DETAIL_CHARS) return text;
  const head = Math.ceil(DETAIL_CHARS * 0.6), tail = DETAIL_CHARS - head;
  return `${text.slice(0, head)}\n… ${text.length - head - tail} more characters …\n${text.slice(-tail)}`;
}

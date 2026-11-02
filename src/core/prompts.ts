// What the person last typed into a session (Session.lastPrompts), and a one-line description of a repo from its README
// (RepoEntry.about, see about.ts), for the voice layer's router: most spoken lines name no session, only their subject, so it matches
// them against what each session was last asked and what its repo is. Both are data shown to a model, never commands.

/**
 * How many prompts a session carries, newest last, and the length each is cut to. Eight: the router shows the sessions a
 * line points at with all of them, and the rest with fewer (the voice router's eval measured the gain).
 */
export const MAX_PROMPTS = 8;
export const PROMPT_CHARS = 160;
/** How much of the session's last reply it carries (Session.lastSaid). */
export const SAID_CHARS = 600;

// Not something the person typed: skill bodies, hook output, reminders and slash-command wrappers (they start with "<"),
// the Esc marker, the resumed-session preamble and a /command.
const NOISE = /^\s*(?:<|\[Request interrupted|Caveat:|This session is being continued|Base directory for this skill|\/[a-z])/;
// A pasted log, stack trace, code block, JSON or terminal output: not a request in his words.
const PASTED = /(?:^\s*at |\bTraceback\b|^\s*[\w.-]+:\d+:\d+|```|\{\s*"|\$ |^\s*\d{2}:\d{2}:\d{2})/m;
const MIN_CHARS = 15;
const MAX_CHARS = 400;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

/**
 * The text the person typed in one transcript entry, one line and cut to PROMPT_CHARS, or undefined when the entry is
 * not a prompt he typed (tool results, meta and sidechain entries, compaction summaries, reminders, hook output, slash
 * commands, pasted blobs, anything shorter than 15 or longer than 400 characters). Pure.
 */
export function promptText(e: any): string | undefined {
  if (!e || typeof e !== 'object' || e.type !== 'user') return undefined;
  if (e.isMeta === true || e.isCompactSummary === true || e.isSidechain === true || e.toolUseResult !== undefined) return undefined;
  const c = e.message?.content;
  let text: string;
  if (typeof c === 'string') text = c;
  else if (Array.isArray(c) && c.length && c.every((b: any) => b?.type === 'text' && typeof b.text === 'string')) text = c.map((b: any) => b.text).join('\n');
  else return undefined; // tool results, images
  const t = text.trim();
  if (t.length < MIN_CHARS || t.length > MAX_CHARS || NOISE.test(t) || PASTED.test(t)) return undefined;
  return clip(t.replace(/\s+/g, ' '), PROMPT_CHARS);
}

/** The last `n` prompts typed in these transcript lines, oldest first, each once. Pure. */
export function lastPromptsOf(lines: string[], n = MAX_PROMPTS): string[] {
  const out: string[] = [];
  for (const line of lines) {
    let e: any;
    try { e = JSON.parse(line); } catch { continue; }
    const t = promptText(e);
    if (t === undefined) continue;
    const i = out.indexOf(t);
    if (i >= 0) out.splice(i, 1);
    out.push(t);
  }
  return out.slice(-n);
}

/**
 * `prev` (what the daemon remembered) followed by `seen` (the prompts in the current transcript tail), each once, the last
 * `n`. The probe reads only the tail, so a prompt that scrolled out of it is kept from an earlier poll. A prompt in
 * both keeps its place in `seen`, which is the newer order. Pure.
 */
export function mergePrompts(prev: readonly string[] | undefined, seen: readonly string[], n = MAX_PROMPTS): string[] {
  if (!prev?.length) return seen.slice(-n);
  const out = prev.filter((p) => !seen.includes(p));
  out.push(...seen);
  return out.slice(-n);
}

/**
 * The start of the session's last reply as the router sees it (Session.lastSaid): one line, cut to SAID_CHARS; undefined
 * when there is none. Pure.
 */
export function saidText(text: string | undefined): string | undefined {
  const t = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return t ? clip(t, SAID_CHARS) : undefined;
}

// A repo's one-line description lives in about.ts; the name stays importable from here.
export { ABOUT_CHARS, readmeAbout } from './about.js';

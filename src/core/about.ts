// A repo's one-line description (RepoEntry.about) for the voice layer's router and the launcher. Read, in this order, first
// hit wins: the manifest's description (package.json, pyproject.toml, Cargo.toml: the probe sends it as `manifest`), the
// tagline of the README (a bold line in a centred header block, or the first plain paragraph after the title), and last
// the first sentence of the first prose paragraph. All of it is data shown to a model, never a command; it is generic and
// names no repo.

/** Longest RepoEntry.about: cut at a word boundary, with an ellipsis, inside this. */
export const ABOUT_CHARS = 140;

/** `s` cut to at most `n` characters at a word boundary, with a trailing ellipsis. Pure. */
export function capAt(s: string, n = ABOUT_CHARS): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n - 1);
  const sp = cut.lastIndexOf(' ');
  return (sp >= n / 2 ? cut.slice(0, sp) : cut).replace(/[\s,;:(–—-]+$/, '') + '…';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

/** Markdown and HTML reduced to their text, white space collapsed. Pure. */
export function plain(s: string): string {
  return s
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[A-Za-z][^>]*>/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/`+([^`]+)`+/g, '$1')
    .replace(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/\*(?=\S)(.+?)(?<=\S)\*/g, '$1')
    .replace(/(?<![\w])_(?=\S)(.+?)(?<=\S)_(?![\w])/g, '$1')
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_, e: string) => ENTITIES[e])
    .replace(/(^|\s):[a-z0-9_+-]{2,}:(?=\s|$)/g, '$1')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ').trim();
}

const letters = (s: string) => (s.match(/[\p{L}]{2,}/gu) ?? []).length;

// What an unfilled manifest or template says ("Add your description here" is what `uv init` writes).
const PLACEHOLDER = /^(?:(?:add|enter|insert|write|put)\b.*\b(?:description|here)\b|your (?:project )?description\b.*|(?:a|my)\s+(?:new\s+|awesome\s+|cool\s+)?(?:project|app|package|repo|repository)\.?|description|todo|tbd|n\/a|none|untitled)\.?$/i;

/** A manifest's description as the one line shown: tidied, capped, undefined when empty, tiny or an unfilled placeholder. Pure. */
export function manifestAbout(desc: unknown): string | undefined {
  if (typeof desc !== 'string') return undefined;
  const t = plain(desc);
  if (t.length < 8 || letters(t) < 2 || PLACEHOLDER.test(t)) return undefined;
  return capAt(t);
}

/* ---------- README ---------- */

interface Seg { t: string; bold: boolean; link: boolean }
interface Unit { text: string; centred: boolean; level: number; boldChars: number; linkChars: number; blank: boolean }

const INLINE = new Set(['a', 'b', 'strong', 'i', 'em', 'span', 'code', 'u', 's', 'small', 'big', 'font', 'sup', 'sub', 'kbd', 'abbr', 'mark', 'tt', 'del', 'ins', 'cite', 'q', 'img', 'wbr']);
const VOID = new Set(['br', 'img', 'hr', 'wbr', 'source', 'input', 'meta', 'link']);

/** The head with front matter, comments, fenced code and non-text elements removed. */
function prepare(head: string): string {
  let lines = head.replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() === '---') { const end = lines.indexOf('---', 1); if (end > 0) lines = lines.slice(end + 1); }
  let fence = false;
  const kept: string[] = [];
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; kept.push(''); continue; }
    kept.push(fence ? '' : l);
  }
  return kept.join('\n')
    // `<mod>` in a code span is text, not a tag.
    .replace(/`[^`\n]*`/g, (c) => c.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(svg|script|style|picture|video|audio|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

/**
 * The README as lines of text in order, each with whether it sits in a centred block, its heading level (0 for none)
 * and how much of it is bold or a link. A blank unit is a paragraph break.
 */
function units(head: string): Unit[] {
  const out: Unit[] = [];
  const stack: { tag: string; centred: boolean; bold: boolean; link: boolean; level: number }[] = [];
  let segs: Seg[] = [];
  const blank = () => { if (out.length && !out[out.length - 1].blank) out.push({ text: '', centred: false, level: 0, boldChars: 0, linkChars: 0, blank: true }); };
  const flush = (paragraphBreak: boolean) => {
    let text = segs.map((s) => s.t).join('').replace(/\s+/g, ' ').trim();
    if (text) {
      let boldChars = segs.filter((s) => s.bold).reduce((n, s) => n + s.t.trim().length, 0);
      let linkChars = segs.filter((s) => s.link).reduce((n, s) => n + s.t.trim().length, 0);
      for (const m of text.matchAll(/(\*\*|__)(?=\S)(.+?)(?<=\S)\1/g)) boldChars += m[0].length;
      for (const m of text.matchAll(/\[([^\]]*)\]\([^)]*\)/g)) linkChars += m[1].length;
      let level = stack.reduce((l, e) => e.level || l, 0);
      const h = /^(#{1,6})\s+(.*)$/.exec(text);
      if (h) { level = h[1].length; text = h[2]; }
      out.push({ text, centred: stack.some((e) => e.centred), level, boldChars, linkChars, blank: false });
    }
    segs = [];
    if (paragraphBreak) blank();
  };
  const text = (s: string) => {
    const bold = stack.some((e) => e.bold), link = stack.some((e) => e.link);
    const parts = s.split('\n');
    parts.forEach((p, i) => {
      if (i > 0) flush(false);
      if (p) segs.push({ t: p, bold, link });
      // A whole empty line between two newlines is a paragraph break; the line end after a <br> is not.
      if (i > 0 && i < parts.length - 1 && !p.trim()) blank();
    });
  };
  const re = /<(\/?)([A-Za-z][A-Za-z0-9]*)\b([^>]*)>/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(head))) {
    text(head.slice(last, m.index));
    last = m.index + m[0].length;
    const close = m[1] === '/', tag = m[2].toLowerCase(), attrs = m[3];
    if (tag === 'br') { flush(false); continue; }
    if (INLINE.has(tag)) {
      if (close) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } }
      else if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) stack.push({ tag, centred: false, bold: tag === 'b' || tag === 'strong', link: tag === 'a', level: 0 });
      continue;
    }
    // A block tag ends the line, and its edges are paragraph breaks.
    flush(true);
    if (close) { for (let i = stack.length - 1; i >= 0; i--) if (stack[i].tag === tag) { stack.length = i; break; } }
    else if (!VOID.has(tag) && !/\/\s*$/.test(attrs)) {
      const centred = tag === 'center' || /\balign\s*=\s*["']?center/i.test(attrs) || /text-align\s*:\s*center/i.test(attrs);
      const lv = /^h([1-6])$/.exec(tag);
      stack.push({ tag, centred, bold: false, link: false, level: lv ? Number(lv[1]) : 0 });
    }
  }
  text(head.slice(last));
  flush(true);
  // Setext headings: a line underlined with === is a level-1 title.
  const res: Unit[] = [];
  for (const u of out) {
    const prev = res[res.length - 1];
    if (!u.blank && /^={3,}$/.test(u.text) && prev && !prev.blank && !prev.level) { prev.level = 1; continue; }
    res.push(u);
  }
  return res;
}

// A candidate that opens like a continuation of an earlier thought, a pronoun for something said before, a quotation or an
// all-italic epigraph is used only when no better candidate is among the first three.
const WEAK = /^(?:(?:because|and|but|so|or|yet|which|then|also|plus|since|thus|hence|it|they|these|those)\b|["“‘'])/i;
const weak = (raw: string) => WEAK.test(plain(raw)) || /^\s*(?:[*_])[^*_][\s\S]*(?:[*_])\s*$/.test(raw.replace(/^>\s?/gm, '').trim());
const BOILERPLATE = /^(?:table of contents|contents|copyright|licen[cs]e[ds]?\b|(?:status|note|warning|important|tip|documentation)\s*:|see also|for more|private\.?$)/i;

/**
 * A line of prose a person wrote about the project (not a list item, table row, rule, badge or link row, nor
 * navigation), as written: its Markdown is reduced by `plain` once the paragraph is joined.
 */
function prose(u: Unit): string | undefined {
  if (u.blank || u.level) return undefined;
  let t = u.text.replace(/^(?:>\s?)+/, '').trim();
  if (!t || /^([-*+]|\d+[.)])\s/.test(t) || /^\|/.test(t) || /^([-*_=]\s*){3,}$/.test(t) || /^\[[^\]]*\]:\s/.test(t) || /^\[!/.test(t)) return undefined;
  const p = plain(t);
  if (p.length < 10 || letters(p) < 2) return undefined;
  // A row of links or a bar of navigation labels is not a sentence.
  if (u.linkChars >= 0.7 * p.length) return undefined;
  const parts = p.split(/\s[|·•]\s|\s[|·•]$/).filter(Boolean);
  if (parts.length >= 3 && parts.every((w) => w.split(/\s+/).length <= 3)) return undefined;
  // An unfilled template variable (`${PROJECT_PURPOSE:-...}`, `{{ description }}`).
  if (/\$\{|\{\{/.test(p) || BOILERPLATE.test(p)) return undefined;
  return t;
}

/** The first sentence of `text` (a sentence of fewer than 25 characters takes the next one too), capped. */
function firstSentence(text: string): string {
  let out = '';
  let rest = text.replace(/^\S+[.!]\s+(?=\S+\s+\S)/, '');   // "Private. Times the burn" -> "Times the burn"
  while (rest) {
    const m = /^(.+?[.!?])(?=\s+[A-Z(“"'])/.exec(rest);
    const s = m ? m[1] : rest;
    out = out ? `${out} ${s}` : s;
    rest = rest.slice(s.length).trim();
    if (out.length >= 25 || !m) break;
  }
  return capAt(out.trim());
}

/**
 * The README's tagline: the first bold line in a centred header block (before the first sub-heading), else the first
 * plain paragraph after the title. Of the first three candidates one that does not open like a continuation ("Because",
 * "And", "But", "So", "It"), a quotation or an epigraph is preferred. Reading stops at the first sub-heading that follows
 * content, so a later section's instructions are never taken for a description. Undefined when there is none. Pure.
 */
export function readmeTagline(head: string | undefined): string | undefined {
  if (typeof head !== 'string' || !head.trim()) return undefined;
  const us = units(prepare(head));
  const candidates: string[] = [];   // as written; plain() reduces the chosen one
  /** The prose from unit `i` to the end of its paragraph, joined. */
  const paragraph = (i: number) => {
    const lines: string[] = [];
    for (let j = i; j < us.length; j++) { const t = prose(us[j]); if (!t) break; lines.push(t); }
    return lines.join(' ');
  };
  // The header block: everything before the first heading below the title.
  const sub = us.findIndex((u) => u.level >= 2);
  const headerEnd = sub < 0 ? us.length : sub;
  for (let i = 0; i < headerEnd; i++) {
    const u = us[i];
    if (!u.centred || u.boldChars < 0.8 * u.text.length) continue;
    const t = prose(u);
    if (!t || letters(plain(t)) < 3) continue;
    // "Everything you need to run X:" goes on in the lines under it.
    candidates.push(/[:,]$/.test(plain(t)) ? paragraph(i) : t);
    break;
  }
  const h1 = us.findIndex((u) => u.level === 1);
  let para: string[] = [];
  let content = false;
  const end = () => {
    if (para.length && !plain(para[para.length - 1]).endsWith(':')) candidates.push(para.join(' '));
    para = [];
  };
  for (const u of us.slice(h1 + 1)) {
    if (candidates.length >= 3) break;
    if (u.level >= 2 && content) break;
    const t = prose(u);
    if (t) para.push(t); else end();
    if (!u.blank && !u.level) content = true;
  }
  end();
  const first3 = candidates.slice(0, 3);
  const pick = first3.find((c) => !weak(c)) ?? first3[0];
  if (!pick) return undefined;
  const text = plain(pick);
  const s = firstSentence(text);
  // A paragraph cut off by the end of the 2 KB head has no end to quote.
  const cut = head.length >= 2000 && text === s && !/[.!?…)]$/.test(s) && head.trimEnd().replace(/[*_`]/g, '').replace(/\s+/g, ' ').endsWith(s.slice(-20)) ? '…' : '';
  return s.length >= 8 ? s + cut : undefined;
}

/**
 * A repo's one-line description from the head of its README: the first sentence of its first paragraph of prose,
 * skipping headings, badges, images, HTML, tables, lists, code fences and front matter, with Markdown links and emphasis
 * reduced to their text. The last resort of repoAbout. Undefined when there is none. Pure.
 */
export function readmeAbout(head: string | undefined): string | undefined {
  if (typeof head !== 'string' || !head.trim()) return undefined;
  let lines = head.replace(/\r/g, '').split('\n');
  if (lines[0]?.trim() === '---') { const end = lines.indexOf('---', 1); lines = end > 0 ? lines.slice(end + 1) : lines; }
  let para: string[] = [];
  let fence = false;
  // A paragraph ending in ":" introduces a list ("This repository contains:"): the next one is tried, but not past the
  // next sub-heading, where a README moves on to instructions.
  let intro = false, ended = true;   // `ended`: the loop stopped at a paragraph break, not at the end of the head
  const done = () => para.length > 0 && !para[para.length - 1].endsWith(':');
  for (const raw of lines) {
    const l = raw.trim();
    if (/^(```|~~~)/.test(l)) { fence = !fence; if (done()) { ended = true; break; } para = []; continue; }
    if (fence) continue;
    ended = false;
    if (/^#{2,6}\s/.test(l) && intro && !done()) return undefined;
    if (para.length && !done()) intro = true;
    if (/^([-*+]|\d+\.) /.test(l) && !para.length) intro = true;
    const skip = !l || /^(#|<|!\[|\[!\[|\||>|[-*+] |\d+\. |={3,}|-{3,}|\[[^\]]*\]:)/.test(l);
    if (skip) { if (done()) { ended = true; break; } para = []; continue; }
    para.push(l);
  }
  if (!done()) return undefined;
  const text = plain(para.join(' '));
  if (/\$\{|\{\{/.test(text)) return undefined;   // an unfilled template variable
  // The first sentence: up to a . ! or ? followed by a space and a capital letter, or the end.
  const m = /^(.+?[.!?])(?=\s+[A-Z(“"'])/.exec(text);
  const first = (m ? m[1] : text).trim();
  // A paragraph cut off by the end of the 2 KB head has no end to quote.
  const cutOff = !m && !ended && head.length >= 2000 && !/[.!?]$/.test(first);
  return first.length >= 8 ? capAt(cutOff ? first + '…' : first) : undefined;
}

/** What the probe sent for one repo: the manifest's description and the head of its README. */
export interface AboutInputs { manifest?: string; readme?: string }

/** The repo's one line: manifest description, else README tagline, else the README's first sentence. Pure. */
export function repoAbout(i: AboutInputs): string | undefined {
  return manifestAbout(i.manifest) ?? readmeTagline(i.readme) ?? readmeAbout(i.readme);
}

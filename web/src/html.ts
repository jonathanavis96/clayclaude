export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));

// Invisible format characters (bidi overrides, embeddings, isolates and marks, zero-width joiners, soft hyphens…) and
// the Unicode line and paragraph separators. A terminal draws none of them and never reorders text around them; a
// browser applies them.
const FORMAT = /[\p{Cf}\u2028\u2029]/gu;

/**
 * Text from a session's screen, escaped for HTML and shown as the terminal shows it: every invisible format character
 * becomes a visible marker such as ⟨U+202E⟩, so none of them can reorder or hide what the PC terminal shows. Pair it
 * with CSS that lays the text out left to right in written order (overlay.css, .sheet-body). For display only, never
 * for a value that is sent.
 */
export const screenText = (s: unknown) =>
  esc(String(s ?? '').replace(FORMAT, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}⟩`));

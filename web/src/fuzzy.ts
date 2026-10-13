/** Subsequence match score, higher is better; null when `query` is not a subsequence of `text`. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.toLowerCase().replace(/\s+/g, ''), t = text.toLowerCase();
  if (!q) return 0;
  let score = 0, ti = 0, prev = -2;
  for (const ch of q) {
    const at = t.indexOf(ch, ti);
    if (at === -1) return null;
    score += 1;
    if (at === prev + 1) score += 3;                              // consecutive
    if (at === 0 || /[-_/. ]/.test(t[at - 1])) score += 4;         // start of a word
    score -= Math.min(2, (at - ti) * 0.1);                         // gaps cost a little
    prev = at; ti = at + 1;
  }
  return score - t.length * 0.02;                                  // prefer shorter names
}

/** Filter and rank. An empty query keeps the original order (most recent first). */
export function fuzzyFilter<T>(items: T[], query: string, text: (x: T) => string, limit = 30): T[] {
  if (!query.trim()) return items.slice(0, limit);
  return items
    .map((x, i) => ({ x, i, s: fuzzyScore(query, text(x)) }))
    .filter((r): r is { x: T; i: number; s: number } => r.s !== null)
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, limit).map((r) => r.x);
}

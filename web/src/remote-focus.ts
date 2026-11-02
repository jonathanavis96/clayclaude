/**
 * Focus requests from the daemon (the voice layer, `{ type: 'focus', sessionId }` on /ws): open that session's focus
 * view. A session the board does not show yet (a launch the daemon has not listed, a state message still in flight) is
 * kept for WAIT_MS and opened when it appears; a newer request replaces an older one.
 */
export const WAIT_MS = 60_000;

export class RemoteFocus {
  private wanted: { key: string; until: number } | null = null;

  /** A request arrived. Returns the key to open now, or null when the session is not on the board yet (kept). */
  request(key: string, visible: (k: string) => boolean, now: number): string | null {
    if (visible(key)) { this.wanted = null; return key; }
    this.wanted = { key, until: now + WAIT_MS };
    return null;
  }

  /** On every state message: the kept key once its session shows, else null. Drops a request that has waited too long. */
  onState(visible: (k: string) => boolean, now: number): string | null {
    const w = this.wanted;
    if (!w) return null;
    if (now > w.until) { this.wanted = null; return null; }
    if (!visible(w.key)) return null;
    this.wanted = null;
    return w.key;
  }
}

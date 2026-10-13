/**
 * Full screen without installing (decision 19). Chrome on some Android Go tablets offers no "Install app", so the
 * manifest's `display: fullscreen` never applies. Browsers allow full screen only from a tap, and drop it on exit.
 * Since UI round 4 (spec §5.1) a double tap on the clock or on blank space toggles it; there is no full-screen button.
 * No orientation lock (Task 35): a locked page cannot follow a rotation, and the board stays full screen through one
 * (measured on the tablet); the tablet's own rotation setting keeps it landscape.
 */

export interface FsDoc { documentElement: { requestFullscreen(o?: { navigationUI?: 'auto' | 'hide' | 'show' }): Promise<void> } }

/** Call straight from a click handler: `requestFullscreen` runs before the first `await`, inside the user gesture. */
export async function enterFullscreen(doc: FsDoc): Promise<{ ok: boolean; error?: string }> {
  try { await doc.documentElement.requestFullscreen({ navigationUI: 'hide' }); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

export function displayMode(): string {
  for (const m of ['fullscreen', 'standalone', 'minimal-ui']) if (matchMedia(`(display-mode: ${m})`).matches) return m;
  return 'browser';
}

export interface FsToggleDoc extends FsDoc { fullscreenElement: unknown; exitFullscreen(): Promise<void> }

/** Leave full screen when in it, otherwise enter it. Call straight from the tap, like enterFullscreen. */
export async function toggleFullscreen(doc: FsToggleDoc): Promise<{ ok: boolean; error?: string }> {
  if (!doc.fullscreenElement) return enterFullscreen(doc);
  try { await doc.exitFullscreen(); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
}

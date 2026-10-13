import { displayMode, enterFullscreen, type FsDoc } from './fullscreen.js';
import { overlayCount } from './overlay.js';

/**
 * "Tap to start" for kiosk mode (spec §5.4). The daemon opens the board as http://localhost:<port>/#kiosk. While the
 * page is not full screen, this overlay covers all of it, so wherever a tap lands it reaches this handler, which goes
 * full screen (a tap is the user gesture Chrome requires).
 *
 * No human tap (Task 35): the daemon injects the tap over adb. It used to do that once per plug-in, so a reload (a
 * new build), a tab switch, Back or a swipe left the board on "Tap to start". Now the page asks the daemon for a tap
 * (POST /api/kiosk/tap) whenever it is visible and not full screen: on load, when full screen is lost, after a
 * rotation or other viewport change, and when the tab comes back to the front. Leaving full screen by double tap
 * is deliberate: the cover stays away and nothing is asked for until the next load or rotation. Losing full screen
 * with a sheet or the focus view open is Back (Chrome takes the first Back to leave full screen): the cover stays away
 * so the next Back closes the sheet, and the board asks once it is closed.
 */

export interface KioskEnv { kiosk: boolean; fullscreen: boolean; displayMode: string }

const KEYED = /^#kiosk=([0-9a-f]{16,64})$/;
/** The `#kiosk` fragment the daemon's launch URL carries, with its launch key (`#kiosk=<hex>`) or without. */
export const isKioskHash = (hash: string) => hash === '#kiosk' || KEYED.test(hash);
/** The launch key in a kiosk fragment; '' when there is none. Only the page the launch opened has it (src/kiosk.ts). */
export const kioskKey = (hash: string) => KEYED.exec(hash)?.[1] ?? '';

/** Only in a kiosk launch, in a plain browser tab that is not full screen. An installed app is full screen already. */
export const showStartOverlay = (e: KioskEnv) => e.kiosk && !e.fullscreen && e.displayMode === 'browser';

/** When the board covers itself and asks for a tap. Pure: the DOM wiring is in initKiosk. */
export class KioskTrigger {
  private userExit = false;
  /** Full screen was lost with an overlay open: Back is closing it, so wait until it is closed. */
  private backHeld = false;
  constructor(private orientation: string) {}
  /** A double tap left full screen: stay out until the next load or rotation. */
  userExited() { this.userExit = true; }
  /** Full screen again (by any tap): a later exit by Back or a swipe is not the person's choice. */
  entered() { this.userExit = false; this.backHeld = false; }
  /** Full screen was lost, with `open` overlays (sheets, the focus view) showing. */
  left(open: number) { if (open > 0) this.backHeld = true; }
  /** The overlays showing now: none ends the wait for Back to close them. */
  overlays(open: number) { if (open === 0) this.backHeld = false; }
  /** A viewport change. A new orientation is a rotation, which ends a deliberate exit. */
  viewport(orientation: string) {
    if (orientation !== this.orientation) { this.orientation = orientation; this.userExit = false; this.backHeld = false; }
  }
  /** Show the "Tap to start" cover. */
  cover(e: KioskEnv) { return showStartOverlay(e) && !this.userExit && !this.backHeld; }
  /** Ask the daemon for its tap: covered, and the tab in front (a tap goes to the visible tab). */
  wants(e: KioskEnv & { visible: boolean }) { return this.cover(e) && e.visible; }
}

/** The daemon's answer: `retryMs` to ask again later (a launch is running), `disabled` when it has no kiosk. */
export interface TapReply { tapped?: boolean; reason?: string; retryMs?: number; disabled?: boolean }

const USER_EXIT = 'clayclaude:fullscreen-user-exit';
/** Called by the double-tap toggle just before it leaves full screen. */
export function noteUserExit(doc: Document = document) { doc.dispatchEvent(new Event(USER_EXIT)); }

/** Asks the daemon for the tap, with the launch key of the URL as it is now (a relaunch may change only the fragment). */
export async function postTap(fetchFn: typeof fetch = fetch): Promise<TapReply> {
  try {
    const r = await fetchFn('/api/kiosk/tap', { method: 'POST', body: '{}',
      headers: { 'content-type': 'application/json', 'x-clayclaude': '1', 'x-clayclaude-kiosk': kioskKey(location.hash) } });
    // 404: a daemon with the kiosk off (or an older one). 403: not the page the launch opened (no key, or an old one).
    if (r.status === 404 || r.status === 403) return { disabled: true };
    return r.ok ? await r.json() as TapReply : {};
  } catch { return {}; }
}

const screenOrientation = () => {
  const t = (screen as { orientation?: { type?: string } }).orientation?.type;
  return t ? t.split('-')[0] : innerWidth >= innerHeight ? 'landscape' : 'portrait';
};

export interface KioskDeps {
  doc?: Document;
  mode?: () => string;
  orientation?: () => string;
  /** How many overlays (sheets, the focus view) are open. */
  overlays?: () => number;
  /** Called with the result of each attempt; the default logs a failure to the console. */
  onResult?: (r: { ok: boolean; error?: string }) => void;
  requestTap?: () => Promise<TapReply>;
  /** Wait after an event before asking, so a burst of resizes is one request and the cover is laid out. */
  settleMs?: number;
  /** Shortest gap between two requests. */
  gapMs?: number;
}

/** Adds the overlay when the page was opened as a kiosk launch. Returns a function that removes it. */
export function initKiosk(deps: KioskDeps = {}): () => void {
  const doc = deps.doc ?? document;
  const win = doc.defaultView ?? window;
  const mode = deps.mode ?? displayMode;
  const orientation = deps.orientation ?? screenOrientation;
  const overlays = deps.overlays ?? overlayCount;
  const onResult = deps.onResult ?? ((r) => { if (!r.ok) console.warn(`clayclaude: full screen refused: ${r.error}`); });
  const requestTap = deps.requestTap ?? (() => postTap());
  const settleMs = deps.settleMs ?? 500, gapMs = deps.gapMs ?? 3000;
  if (!isKioskHash(doc.location.hash)) return () => {};

  const trigger = new KioskTrigger(orientation());
  const env = () => ({ kiosk: true, fullscreen: !!doc.fullscreenElement, displayMode: mode(), visible: doc.visibilityState === 'visible' });
  const el = doc.createElement('div');
  el.id = 'kiosk-start';
  el.setAttribute('role', 'button');
  el.textContent = 'Tap to start';
  Object.assign(el.style, {
    position: 'fixed', inset: '0', zIndex: '2147483647', display: 'grid', placeItems: 'center',
    background: 'var(--bg, #0e1014)', color: 'var(--ink, #f2f4f7)', font: '600 28px system-ui, sans-serif',
    touchAction: 'manipulation', userSelect: 'none', cursor: 'pointer',
  });
  // `click`: on a touch screen Chrome grants the user activation at the end of the tap, not at pointerdown.
  const onClick = (ev: Event) => {
    ev.preventDefault(); ev.stopPropagation();
    void enterFullscreen(doc as unknown as FsDoc).then(onResult);
  };

  let timer: ReturnType<typeof setTimeout> | undefined, lastAsk = -Infinity, disabled = false, stopped = false;
  const ask = (delay = settleMs) => {
    if (disabled || stopped || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!trigger.wants(env())) return;
      const early = lastAsk + gapMs - Date.now();
      if (early > 0) { ask(early); return; }
      lastAsk = Date.now();
      void requestTap().then((r) => {
        if (r.disabled) disabled = true;
        else if (r.retryMs) ask(r.retryMs);
      });
    }, delay);
  };
  const sync = () => {
    trigger.overlays(overlays());
    el.style.display = trigger.cover(env()) ? 'grid' : 'none';
    ask();
  };
  const onFs = () => { if (doc.fullscreenElement) trigger.entered(); else trigger.left(overlays()); sync(); };
  // Back closes an overlay in overlay.ts's own popstate listener, which runs after this one: look once it has.
  let popTimer: ReturnType<typeof setTimeout> | undefined;
  const onPop = () => { clearTimeout(popTimer); popTimer = setTimeout(sync, 0); };
  const onViewport = () => { trigger.viewport(orientation()); sync(); };
  const onUserExit = () => trigger.userExited();
  el.addEventListener('click', onClick);
  doc.addEventListener('fullscreenchange', onFs);
  doc.addEventListener('visibilitychange', sync);
  doc.addEventListener(USER_EXIT, onUserExit);
  win.addEventListener('resize', onViewport);
  win.addEventListener('orientationchange', onViewport);
  win.addEventListener('popstate', onPop);
  doc.body.append(el);
  sync();
  return () => {
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    clearTimeout(popTimer);
    el.removeEventListener('click', onClick);
    doc.removeEventListener('fullscreenchange', onFs);
    doc.removeEventListener('visibilitychange', sync);
    doc.removeEventListener(USER_EXIT, onUserExit);
    win.removeEventListener('resize', onViewport);
    win.removeEventListener('orientationchange', onViewport);
    win.removeEventListener('popstate', onPop);
    el.remove();
  };
}

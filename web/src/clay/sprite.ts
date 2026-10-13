import { bucketFor, type SheetKey, type SheetLayout } from './sheet.js';
import type { RenderSpec } from './stage.js';
import type { ClayStateId } from './states.js';
import { resolvePlayback } from './timeline.js';

export type DrawMode = 'bake' | 'pc' | 'live';
export interface DecodedSheet { bitmap: ImageBitmap; layout: SheetLayout }

/** What a sprite needs from the controller. */
export interface SpriteEnv {
  /** How to draw `id` now: null while Auto is still deciding, 'none' once every mode has failed for it. */
  modeFor(id: ClayStateId, large: boolean): DrawMode | 'none' | null;
  /** The decoded sheet, or null (and a load starts, urgent ones first). */
  sheet(key: SheetKey, urgent: boolean): DecodedSheet | null;
  pin(key: SheetKey): void;
  unpin(key: SheetKey): void;
  /** Forget a decoded sheet that can no longer be drawn (its bitmap was closed or its GPU memory lost); it reloads. */
  drop(key: SheetKey): void;
  shadows(): boolean;
  readonly version: string;
  /** Draw one live frame into `ctx` (px × px). False when live rendering failed. */
  live(ctx: CanvasRenderingContext2D, px: number, spec: RenderSpec): boolean;
}

/** Live frames are never larger than this many device pixels. */
export const MAX_LIVE_PX = 320;
/**
 * The one large focus-view character renders live at its slot's own device-pixel size, up to this. The slot is at
 * most 220 CSS px (overlay.css .char-large), so 480 covers a 2x tablet; 320 px stretched to a 360 px slot was blurry.
 */
export const MAX_LARGE_LIVE_PX = 480;

const sameKey = (a: SheetKey, b: SheetKey) =>
  a.state === b.state && a.puffed === b.puffed && a.size === b.size && a.shadows === b.shadows && a.colour === b.colour && a.version === b.version;

/**
 * One character in one slot element. It owns a canvas that fills the square slot and draws either
 * a baked frame (one drawImage from the sheet: no 3D work) or a live frame. Until its first frame
 * is ready, the slot's placeholder (`.ph`) stays visible.
 */
export class Sprite {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null;
  private id: ClayStateId = 'W2';
  private puffed = false;
  private colour = '#e07a4f';
  private t0 = 0;
  private started = false;
  private devicePx = 0;
  private shown: SheetKey | null = null;
  private shownFrame = -1;
  private drawn = false;
  /** False while scrolled out of view: the sprite draws nothing. */
  onScreen = true;

  constructor(readonly el: HTMLElement, private env: SpriteEnv, readonly large = false) {
    this.canvas = el.ownerDocument.createElement('canvas');
    // absolutely positioned, so the canvas never gives the slot an intrinsic size: the slot's size
    // comes from its row (height) and aspect-ratio (width) and the picture always fills it exactly
    this.canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.className = 'clay';
    this.ctx = this.canvas.getContext('2d'); // null only without a canvas implementation (unit tests)
    // Chrome can drop a 2D canvas's backing store under GPU memory pressure (low-RAM Android): redraw when it is back
    this.canvas.addEventListener('contextrestored', () => { this.shownFrame = -1; });
  }

  get state(): ClayStateId { return this.id; }
  get px(): number { return this.devicePx; }
  setDevicePx(px: number): void { this.devicePx = px; }

  /**
   * Ask for a state. Every state loops (round 3: no "plays once" states), so how long the session has been in it
   * (`_sinceMs`) does not change what shows. Re-asking for what is playing never restarts it.
   */
  setTarget(id: ClayStateId, puffed: boolean, colour: string, _sinceMs: number, perfNow: number): void {
    this.puffed = puffed;
    this.colour = colour;
    if (this.started && this.id === id) return;
    this.started = true;
    this.id = id;
    this.t0 = perfNow;
    this.shownFrame = -1;
  }

  /** Called by the shared ticker. */
  tick(now: number): void {
    if (!this.started || !this.onScreen || this.devicePx <= 0) return;
    const id = this.id;
    const r = resolvePlayback(id, now - this.t0);
    const mode = this.env.modeFor(id, this.large);
    if (mode === null || mode === 'none') return;

    if (mode === 'live') {
      const px = Math.max(32, Math.min(this.large ? MAX_LARGE_LIVE_PX : MAX_LIVE_PX, Math.round(this.devicePx)));
      if (this.canvas.width !== px) { this.canvas.width = px; this.canvas.height = px; }
      this.ctx?.clearRect(0, 0, px, px);
      if (this.ctx && this.env.live(this.ctx, px, { state: id, t: r.t, puffed: this.puffed, colour: this.colour, shadows: this.env.shadows() })) this.reveal();
      this.shown = null;
      return;
    }

    const size = bucketFor(this.devicePx);
    const key: SheetKey = { state: id, puffed: this.puffed, size, shadows: this.env.shadows(), colour: this.colour, version: this.env.version };
    const sheet = this.env.sheet(key, true);
    if (!sheet) return; // not ready: the previous picture, or the placeholder, stays
    const same = this.shown !== null && sameKey(this.shown, key);
    if (same && this.shownFrame === r.frame) return; // nothing to do this tick
    if (!same) {
      this.env.pin(key);
      if (this.shown) this.env.unpin(this.shown);
      this.shown = key;
    }
    if (this.canvas.width !== size) { this.canvas.width = size; this.canvas.height = size; }
    const { layout, bitmap } = sheet;
    const f = Math.min(r.frame, layout.frames - 1);
    this.ctx?.clearRect(0, 0, size, size);
    try {
      this.ctx?.drawImage(bitmap, (f % layout.cols) * size, Math.floor(f / layout.cols) * size, size, size, 0, 0, size, size);
    } catch {
      // a closed or lost bitmap: drop it so the next tick reloads it (from storage, else by baking)
      this.env.unpin(key);
      this.env.drop(key);
      this.shown = null;
      this.shownFrame = -1;
      return;
    }
    this.shownFrame = r.frame;
    this.reveal();
  }

  private reveal(): void {
    if (this.drawn) return;
    this.drawn = true;
    this.el.querySelector('.ph')?.remove();
    // the canvas fills its nearest positioned ancestor: a static slot would let it cover the whole overlay or page
    // (the focus view's characters once did, stacked full screen over the feed and meters)
    const view = this.el.ownerDocument.defaultView;
    if (view && view.getComputedStyle(this.el).position === 'static') this.el.style.position = 'relative';
    this.el.appendChild(this.canvas);
  }

  /** Forget what is shown (its sheet is gone): the next tick fetches and pins it again. */
  forget(): void { this.shown = null; this.shownFrame = -1; }

  destroy(): void {
    if (this.shown) this.env.unpin(this.shown);
    this.shown = null;
    this.canvas.remove();
    // free the backing store now: rows come and go all day on a 3 GB device, and a detached canvas keeps it until GC
    this.canvas.width = this.canvas.height = 0;
  }
}

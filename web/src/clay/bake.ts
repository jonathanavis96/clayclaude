import { layoutFor, sheetLayout, type SheetKey, type SheetLayout } from './sheet.js';
import type { Stage } from './stage.js';
import { frameCount, frameTime } from './timeline.js';

export type SheetCanvas = HTMLCanvasElement | OffscreenCanvas;
export interface BakedSheet { canvas: SheetCanvas; layout: SheetLayout; renderMs: number }

export function makeCanvas(w: number, h: number): SheetCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const nextTask = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Render every frame of one state into a sprite sheet (frames left to right, top to bottom).
 * `yieldEvery` > 0 gives the event loop a turn that often (main-thread baking).
 * `paceMs` > 0 rests that long after every frame: idle (background) bakes leave the GPU to the page.
 * `frames` overrides the state's frame count (perf page only: the 24- and 48-frame trials).
 */
export async function bakeSheet(stage: Stage, key: SheetKey, opts: { yieldEvery?: number; paceMs?: number; frames?: number } = {}): Promise<BakedSheet> {
  const t0 = performance.now();
  const n = opts.frames ?? frameCount(key.state);
  const layout = opts.frames ? sheetLayout(n, key.size) : layoutFor(key);
  const canvas = makeCanvas(layout.width, layout.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) throw new Error('no 2d context for the sheet');
  for (let i = 0; i < n; i++) {
    const t = opts.frames ? i / n : frameTime(key.state, i);
    // every frame: on the main thread the Stage is shared with live sprites, which resize it during our yields
    stage.setSize(key.size);
    stage.render({ state: key.state, t, puffed: key.puffed, colour: key.colour, shadows: key.shadows });
    if (stage.lost()) throw new Error('WebGL context lost while baking');
    // the GL drawing buffer is only valid until control returns to the event loop: copy it now
    ctx.drawImage(stage.canvas as CanvasImageSource, (i % layout.cols) * key.size, Math.floor(i / layout.cols) * key.size);
    if (opts.paceMs) await nextTask(opts.paceMs);
    else if (opts.yieldEvery && (i + 1) % opts.yieldEvery === 0) await nextTask();
  }
  if (!hasPixels(ctx, layout)) throw new Error('bake produced an empty sheet');
  return { canvas, layout, renderMs: performance.now() - t0 };
}

/** A sheet whose first frame is fully transparent means the GPU silently drew nothing. */
function hasPixels(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, l: SheetLayout): boolean {
  const s = l.size;
  const d = ctx.getImageData(Math.floor(s / 4), Math.floor(s / 4), Math.ceil(s / 2), Math.ceil(s / 2)).data;
  for (let i = 3; i < d.length; i += 16) if (d[i] > 0) return true;
  return false;
}

/** PNG keeps the alpha channel exactly; sheets are stored in IndexedDB in this form. */
export function encodeSheet(canvas: SheetCanvas): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/png' });
  return new Promise((res, rej) => (canvas as HTMLCanvasElement).toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'));
}

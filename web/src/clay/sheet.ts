import { CLAY_STATES, type ClayStateId } from './states.js';
import { frameCount } from './timeline.js';

/** Frame edge sizes in device pixels. A slot asks for the smallest bucket at least its own size. */
export const SIZE_BUCKETS = [48, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320] as const;
/** Largest sheet edge. 4096 is safe on every WebGL2 / Android GPU. */
export const MAX_SHEET_PX = 4096;

export function bucketFor(devicePx: number): number {
  for (const b of SIZE_BUCKETS) if (devicePx <= b) return b;
  return SIZE_BUCKETS[SIZE_BUCKETS.length - 1];
}

/** Everything a baked sheet depends on (spec §7.3: state, pixel size, shadows, colour, renderer version). */
export interface SheetKey {
  state: ClayStateId;
  /** The X2 modifier baked in. */
  puffed: boolean;
  size: number;
  shadows: boolean;
  /** "#rrggbb", lower case. */
  colour: string;
  version: string;
}

export function keyString(k: SheetKey): string {
  return [k.state, k.puffed ? 'p' : 'n', k.size, k.shadows ? 's' : 'f', k.colour.replace('#', '').toLowerCase(), k.version].join('|');
}

export interface SheetLayout { frames: number; cols: number; rows: number; size: number; width: number; height: number }

export function sheetLayout(frames: number, size: number): SheetLayout {
  const cols = Math.max(1, Math.min(frames, Math.floor(MAX_SHEET_PX / size), 8));
  const rows = Math.ceil(frames / cols);
  return { frames, cols, rows, size, width: cols * size, height: rows * size };
}

export const layoutFor = (k: Pick<SheetKey, 'state' | 'size'>): SheetLayout => sheetLayout(frameCount(k.state), k.size);

/** Bytes a decoded sheet holds in memory (RGBA). */
export const sheetBytes = (l: SheetLayout): number => l.width * l.height * 4;

/** Decoded bytes for every state at one size: the memory planning number in the plan header. */
export function allStatesBytes(size: number): number {
  return CLAY_STATES.reduce((n, id) => n + sheetBytes(layoutFor({ state: id, size })), 0);
}

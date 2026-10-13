/**
 * Pixel measurements for the round-3 character checks (spec §7.4.8): frame-to-frame motion, the frame-jump check
 * (whole frame and 8x8 tiles, so a small particle that pops or flashes for one frame cannot hide in a big frame),
 * and the eye catch-light segmentation. Pure functions over decoded PNGs; the tests and tools/clay-shots.ts share them.
 */
import { PNG } from 'pngjs';
import type { Page } from 'playwright-core';
import type { DebugPass } from '../../web/src/clay/character.js';
import type { ClayStateId } from '../../web/src/clay/states.js';
import { frameCount, frameTime, poseFor } from '../../web/src/clay/timeline.js';

/** The board's row background (style.css --panel): frames are judged as they are seen, composited over it. */
export const BG = [0x16, 0x1a, 0x21] as const;

/** One frame as luminance 0..1, composited over BG. */
export interface Luma { w: number; h: number; v: Float32Array }

export function luma(png: PNG): Luma {
  const { width: w, height: h, data } = png;
  const v = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3] / 255;
    const c = [0, 1, 2].map((k) => (data[i * 4 + k] * a + BG[k] * (1 - a)) / 255);
    v[i] = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  return { w, h, v };
}

/** Mean absolute luminance difference of two frames, 0..1. */
export function frameDiff(a: Luma, b: Luma): number {
  let s = 0;
  for (let i = 0; i < a.v.length; i++) s += Math.abs(a.v[i] - b.v[i]);
  return s / a.v.length;
}

export const TILE = 8;
/** Tiles overlap by half (stride TILE / 2), so a small particle never splits its pixels over four tiles. */
const STRIDE = TILE / 2;
/** A tile's surroundings: the tile grown by one tile each way (24 x 24 px). */
const AROUND = TILE;

/** Summed-area table of |a - b|, for the sum over any rectangle in O(1). */
function diffTable(a: Luma, b: Luma): Float64Array {
  const w = a.w, h = a.h, t = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += Math.abs(a.v[y * w + x] - b.v[y * w + x]);
      t[(y + 1) * (w + 1) + x + 1] = t[y * (w + 1) + x + 1] + row;
    }
  }
  return t;
}
/** Mean of a diff table over the rectangle [x0, x1) x [y0, y1), clipped to the frame. */
function meanIn(t: Float64Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number): number {
  x0 = Math.max(0, x0); y0 = Math.max(0, y0); x1 = Math.min(w, x1); y1 = Math.min(h, y1);
  if (x1 <= x0 || y1 <= y0) return 0; // wholly outside the frame
  const W = w + 1;
  return (t[y1 * W + x1] - t[y0 * W + x1] - t[y1 * W + x0] + t[y0 * W + x0]) / ((x1 - x0) * (y1 - y0));
}

/** Mean absolute luminance difference per TILE x TILE tile (overlapping), 0..1. */
export function tileDiffs(a: Luma, b: Luma): Float32Array {
  const t = diffTable(a, b);
  const nx = Math.floor((a.w - TILE) / STRIDE) + 1, ny = Math.floor((a.h - TILE) / STRIDE) + 1;
  const out = new Float32Array(nx * ny);
  for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) out[ty * nx + tx] = meanIn(t, a.w, a.h, tx * STRIDE, ty * STRIDE, tx * STRIDE + TILE, ty * STRIDE + TILE);
  return out;
}

export interface JumpReport {
  /** Mean frame-to-frame difference over the loop, seam included (the state's motion). */
  mean: number;
  /** The largest whole-frame difference between adjacent frames, and which pair ("k->k+1", the seam is "n-1->0"). */
  worst: { pair: string; diff: number };
  /** The largest tile difference between adjacent frames, and where. */
  worstTile: { pair: string; tile: number; diff: number };
  /** Tiles that flash: something there for exactly one frame, in still surroundings. */
  spikes: string[];
  /** Tiles that pop: a step change between two frames, far more than anything round it the frame before and after. */
  pops: string[];
  /** The largest pop ratio (a tile's step over the most anything round it moved the frame before and after), and where. */
  worstPop: { pair: string; tile: number; ratio: number };
  /** Per pair k -> k+1 (the last is the seam), its worst tile's pop ratio (tiles changing by over `tile` only). */
  popRatios: number[];
  /** Every adjacent pair's whole-frame difference, k -> k+1 (the last is the seam). */
  diffs: number[];
}

/**
 * The frame-jump check over one loop of frames (cyclic: the last frame leads into the first, every state loops).
 * Adjacent pairs k -> k+1 are compared whole and per 8x8 tile.
 *  - Flash: a tile flashes at frame k when it differs by more than `tile` from both frame k-1 and frame k+1 while it
 *    and every tile round it (24 x 24 px) are still, each under a third of `tile`, from k-2 to k-1, from k-1 to k+1 and
 *    from k+1 to k+2: something was there for one frame only. Motion, however fast, moves the surroundings too (an arm
 *    crossing a tile in one frame, a swing turning), so it never counts. This is for still parts of the frame; a
 *    particle flashing among other particles is `particleSpikeCheck`'s, on the particle-only pass.
 *  - Pop: a tile changing by more than `tile` between k and k+1 pops when that is more than `pop.any` times (at the
 *    loop seam, the last pair, `pop.seam` times) the most that any tile round it changed between k-1 and k and between
 *    k+1 and k+2: a step, with nothing moving that fast round it the frame before or after. A loop whose ends do not
 *    meet (a body that jumps sideways, a squash or an eye that snaps at the seam) pops at the seam; smooth motion never
 *    does, since a tile's change grows and dies away over several frames. `popRatios` has each pair's worst ratio.
 */
export function jumpCheck(frames: Luma[], tile: number, pop: { any: number; seam: number } = { any: Infinity, seam: Infinity }): JumpReport {
  const n = frames.length;
  const m = (k: number) => ((k % n) + n) % n;
  const at = (k: number) => frames[m(k)];
  const pair = (k: number) => `${m(k)}->${m(k + 1)}`;
  const { w, h } = frames[0];
  const step = Array.from({ length: n }, (_, k) => diffTable(at(k), at(k + 1)));   // k -> k+1
  const skip = Array.from({ length: n }, (_, k) => diffTable(at(k - 1), at(k + 1))); // k-1 -> k+1
  const whole = step.map((t) => meanIn(t, w, h, 0, 0, w, h));
  const spikes: string[] = [], pops: string[] = [];
  let worstTile = { pair: '', tile: -1, diff: 0 };
  let worstPop = { pair: '', tile: -1, ratio: 0 };
  const popRatios = new Array<number>(n).fill(0);
  const nx = Math.floor((w - TILE) / STRIDE) + 1, ny = Math.floor((h - TILE) / STRIDE) + 1;
  for (let k = 0; k < n; k++) for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
    const x0 = tx * STRIDE, y0 = ty * STRIDE, x1 = x0 + TILE, y1 = y0 + TILE;
    const cur = meanIn(step[k], w, h, x0, y0, x1, y1);
    if (cur > worstTile.diff) worstTile = { pair: pair(k), tile: ty * nx + tx, diff: cur };
    if (n < 5 || cur <= tile) continue;
    const still = (t: Float64Array) => {
      for (let dy = -AROUND; dy <= AROUND; dy += STRIDE) for (let dx = -AROUND; dx <= AROUND; dx += STRIDE) {
        if (meanIn(t, w, h, x0 + dx, y0 + dy, x1 + dx, y1 + dy) >= tile / 3) return false;
      }
      return true;
    };
    // a pop: this tile steps far more than anything round it moved the frame before and the frame after
    const around = (t: Float64Array) => {
      let mx = 0;
      for (let dy = -AROUND; dy <= AROUND; dy += STRIDE) for (let dx = -AROUND; dx <= AROUND; dx += STRIDE) mx = Math.max(mx, meanIn(t, w, h, x0 + dx, y0 + dy, x1 + dx, y1 + dy));
      return mx;
    };
    const ratio = cur / Math.max(1e-6, around(step[m(k - 1)]), around(step[m(k + 1)]));
    if (ratio > worstPop.ratio) worstPop = { pair: pair(k), tile: ty * nx + tx, ratio };
    popRatios[k] = Math.max(popRatios[k], ratio);
    if (ratio > (k === n - 1 ? pop.seam : pop.any)) {
      pops.push(`pop at ${pair(k)} tile (${x0},${y0}): ${cur.toFixed(3)}, ${ratio.toFixed(1)}x anything round it the frame before and after`);
      continue;
    }
    const prev = meanIn(step[m(k - 1)], w, h, x0, y0, x1, y1);
    if (prev <= tile) continue;
    if (still(skip[k]) && still(step[m(k - 2)]) && still(step[m(k + 1)])) {
      spikes.push(`flash at frame ${m(k)} tile (${x0},${y0}): ${prev.toFixed(3)} in, ${cur.toFixed(3)} out, still around it`);
    }
  }
  const worst = whole.reduce((r, v, k) => (v > r.diff ? { pair: pair(k), diff: v } : r), { pair: '', diff: 0 });
  return { mean: whole.reduce((a, b) => a + b, 0) / n, worst, worstTile, spikes, pops, worstPop, popRatios, diffs: whole };
}

interface Blob { x: number; y: number; mass: number; peak: number; px: number[] }

const INK = 2; // alpha over 2/255 is a particle pixel

/** Connected particles (8-connected pixels with alpha over 2/255) of a particle-pass frame: centroid, mass (sum of alpha), pixels. */
export function blobs(png: PNG): Blob[] {
  const { width: w, height: h, data } = png;
  const seen = new Uint8Array(w * h);
  const out: Blob[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || data[i * 4 + 3] <= INK) continue;
    let mass = 0, sx = 0, sy = 0, peak = 0;
    const stack = [i], px: number[] = [];
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop()!, x = j % w, y = (j - x) / w, a = data[j * 4 + 3] / 255;
      px.push(j);
      mass += a; sx += a * x; sy += a * y; peak = Math.max(peak, a);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const X = x + dx, Y = y + dy, k = Y * w + X;
        if (X < 0 || Y < 0 || X >= w || Y >= h || seen[k] || data[k * 4 + 3] <= INK) continue;
        seen[k] = 1;
        stack.push(k);
      }
    }
    out.push({ x: sx / mass, y: sy / mass, mass, peak, px });
  }
  return out;
}

/** Particle pixels of `png` grown by `r` px (a square), as a mask. */
function reachMask(png: PNG, r: number): Uint8Array {
  const { width: w, height: h, data } = png;
  const row = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (data[(y * w + x) * 4 + 3] <= INK) continue;
    for (let X = Math.max(0, x - r); X <= Math.min(w - 1, x + r); X++) row[y * w + X] = 1;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!row[y * w + x]) continue;
    for (let Y = Math.max(0, y - r); Y <= Math.min(h - 1, y + r); Y++) out[Y * w + x] = 1;
  }
  return out;
}

/**
 * The particle check, over one loop of the particle-only pass (cyclic, seam included): every particle must fade in
 * and out (spec §7.4.8). A blob none of whose pixels is within `reach` px of a particle pixel in the frame before
 * appeared there; it fails if it appeared both strong (some pixel over `alpha`) and big (more than `mass` fully opaque
 * pixels' worth): a particle may only come in faint or small. Likewise a blob with no particle pixel within `reach` px
 * in the next frame vanished, and must have faded or shrunk first. Particles move at most a few pixels a frame at board
 * size, so a moving particle is never taken for a new one. A particle shown for a single frame fails both ways.
 */
export function particleCheck(frames: PNG[], mass: number, alpha: number, reach = 6): { events: string[]; worst: number } {
  const n = frames.length;
  const bs = frames.map(blobs);
  const masks = frames.map((f) => reachMask(f, reach));
  const events: string[] = [];
  let worst = 0;
  const pair = (k: number) => `${k}->${(k + 1) % n}`;
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    const pop = (b: Blob) => { if (b.peak > alpha) worst = Math.max(worst, b.mass); return b.mass > mass && b.peak > alpha; };
    const at = (b: Blob) => `(${b.x.toFixed(0)},${b.y.toFixed(0)}) mass ${b.mass.toFixed(1)}, alpha ${b.peak.toFixed(2)}`;
    for (const b of bs[k1]) if (!b.px.some((j) => masks[k][j]) && pop(b)) events.push(`appears at ${pair(k)} ${at(b)}`);
    for (const b of bs[k]) if (!b.px.some((j) => masks[k1][j]) && pop(b)) events.push(`vanishes at ${pair(k)} ${at(b)}`);
  }
  return { events, worst };
}

/** A frame's alpha, 0..1 per pixel. */
function alphaOf(png: PNG): Float32Array {
  const a = new Float32Array(png.width * png.height);
  for (let i = 0; i < a.length; i++) a[i] = png.data[i * 4 + 3] / 255;
  return a;
}

/**
 * `a` blurred by the 5 x 5 binomial kernel (1 4 6 4 1)/16 each way, mass kept: a moving particle's anti-aliased edges
 * land on different pixels each frame, and thin strokes (a 0 is a one-pixel ring at board size) leave a few pixels'
 * worth uncovered by any whole-pixel shift; blurred, they match to within about a pixel's worth.
 */
function blur(a: Float32Array, w: number, h: number): Float32Array {
  const k = [1 / 16, 4 / 16, 6 / 16, 4 / 16, 1 / 16];
  const t = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -2; i <= 2; i++) { const X = x + i; if (X >= 0 && X < w) v += k[i + 2] * a[y * w + X]; }
    t[y * w + x] = v;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let v = 0;
    for (let i = -2; i <= 2; i++) { const Y = y + i; if (Y >= 0 && Y < h) v += k[i + 2] * t[Y * w + x]; }
    out[y * w + x] = v;
  }
  return out;
}

/**
 * The particle mass (summed alpha) of `cur` in the TILE x TILE tile at (x0, y0) that `other`, moved as a whole by any
 * whole-pixel shift of up to `reach` px each way, cannot cover: the least, over the shifts, of the sum of
 * max(0, cur - shifted other). Block matching, as a video codec does: a particle that moved is covered by the shift
 * that follows it; one that is not in `other` at all is not, whatever other particles are about. Stops early once the
 * answer is at most `enough`.
 */
function uncovered(cur: Float32Array, other: Float32Array, w: number, h: number, x0: number, y0: number, reach: number, enough: number, size: number): number {
  let best = Infinity;
  for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) {
    let s = 0;
    for (let y = Math.max(0, y0); y < Math.min(h, y0 + size) && s < best; y++) for (let x = Math.max(0, x0); x < Math.min(w, x0 + size); x++) {
      const c = cur[y * w + x];
      if (c === 0) continue;
      const X = x + dx, Y = y + dy;
      const o = X >= 0 && Y >= 0 && X < w && Y < h ? other[Y * w + X] : 0;
      if (c > o) s += c - o;
    }
    if (s < best) best = s;
    if (best <= enough) return best;
  }
  return best;
}

/**
 * The particle spike check, over one loop of the particle-only pass (cyclic, seam included), wherever the particles
 * are, busy or not (spec §7.4.8: "fail on any tile whose difference spikes for a single frame"). For every 8x8 tile
 * (overlapping) and every frame k: the mass in the tile at k that neither frame k-1 nor frame k+1 can cover (each
 * shifted by up to `reach` px, a particle's most movement in a frame: `uncovered`) is a one-frame flash; the mass in
 * the tile at k-1, and at k+1, that frame k cannot cover is a one-frame gap. Mass is in fully opaque pixels' worth;
 * over `limit` fails. A particle that moves, grows or fades over several frames is covered from one side or the other
 * (it is brighter or bigger the frame after it fades in, the frame before it fades out), so it never spikes; a particle
 * shown, or hidden, for a single frame is not, even touching or overlapping other particles, which `particleCheck`'s
 * blob test (a blob touching last frame's particles counts as moving) cannot see. (A particle wholly hidden behind an
 * opaque one adds no alpha and is not seen; nor is it on the board.) The frames are blurred first (`blur`), so
 * anti-aliasing and sub-pixel movement do not count as mass. One event per frame and kind, at
 * its worst tile.
 */
export function particleSpikeCheck(frames: PNG[], limit: number, reach = 6): { events: string[]; worst: number; flash: number; gap: number } {
  const n = frames.length;
  const { width: w, height: h } = frames[0];
  const al = frames.map((f) => blur(alphaOf(f), w, h));
  const m = (k: number) => ((k % n) + n) % n;
  const events: string[] = [];
  let worstFlash = 0, worstGap = 0;
  if (n < 3) return { events, worst: 0, flash: 0, gap: 0 };
  const ST = TILE;
  const nx = Math.floor((w - ST) / STRIDE) + 1, ny = Math.floor((h - ST) / STRIDE) + 1;
  const mass = (a: Float32Array, x0: number, y0: number) => {
    let s = 0;
    for (let y = y0; y < y0 + ST; y++) for (let x = x0; x < x0 + ST; x++) s += a[y * w + x];
    return s;
  };
  for (let k = 0; k < n; k++) {
    const [a, b, c] = [al[m(k - 1)], al[k], al[m(k + 1)]];
    let flash = { v: 0, x: 0, y: 0 }, gap = { v: 0, x: 0, y: 0 };
    for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
      const x0 = tx * STRIDE, y0 = ty * STRIDE;
      // flash: in the tile at k, covered from neither side (what is uncovered is at most the tile's mass)
      if (mass(b, x0, y0) > flash.v) {
        const v = Math.min(uncovered(b, a, w, h, x0, y0, reach, flash.v, ST), uncovered(b, c, w, h, x0, y0, reach, flash.v, ST));
        if (v > flash.v) flash = { v, x: x0, y: y0 };
      }
      // gap: in the tile at k-1 and at k+1, and not covered by frame k
      if (Math.min(mass(a, x0, y0), mass(c, x0, y0)) > gap.v) {
        const v = Math.min(uncovered(a, b, w, h, x0, y0, reach, gap.v, ST), uncovered(c, b, w, h, x0, y0, reach, gap.v, ST));
        if (v > gap.v) gap = { v, x: x0, y: y0 };
      }
    }
    worstFlash = Math.max(worstFlash, flash.v); worstGap = Math.max(worstGap, gap.v);
    if (flash.v > limit) events.push(`flash at frame ${k} tile (${flash.x},${flash.y}): ${flash.v.toFixed(1)} px of particle there in no frame either side`);
    if (gap.v > limit) events.push(`gap at frame ${k} tile (${gap.x},${gap.y}): ${gap.v.toFixed(1)} px of particle there either side and not in this frame`);
  }
  return { events, worst: Math.max(worstFlash, worstGap), flash: worstFlash, gap: worstGap };
}

/**
 * The particle mass spike, over one loop of the particle-only pass (cyclic, seam included), wherever the particles are,
 * busy or not: for every `size` x `size` neighbourhood (stride 4 px) and every frame k, its total particle alpha
 * (blurred, in fully opaque pixels' worth) at k against frames k-1 and k+1. A flash is a one-frame peak: the mass at k
 * over the larger of the two sides, each side taken at its fullest neighbourhood within `reach` px (where a moving
 * particle went). A gap is a one-frame dip: the smaller of the two sides over frame k's fullest neighbourhood within
 * `reach`. Over `limit` fails; one event per frame and kind, at its worst neighbourhood. Nothing about the surroundings
 * is asked: a particle shown for one frame on top of, or beside, other particles adds its whole mass all the same.
 * Movement is followed by the shift, and growing and fading make the mass climb or fall over frames, never peak or dip
 * at one; only a particle at the top of a quick twinkle peaks, by the little it gains on the frames either side.
 * (Against the plain mean of k-1 and k+1, a particle fading out over two or three frames measures as much as a
 * one-frame particle: N6's drips and W7's drops reach 46 and 25.) Complements `particleSpikeCheck`'s block matching,
 * in which a one-frame particle shaped like a neighbour (a Z beside a Z) partly hides.
 */
export function particleMassSpike(frames: PNG[], limit: number, reach = 6, size = 24): { events: string[]; flash: number; gap: number } {
  const n = frames.length;
  const { width: w, height: h } = frames[0];
  const events: string[] = [];
  if (n < 3) return { events, flash: 0, gap: 0 };
  const W = w + 1;
  const tables = frames.map((f) => {
    const a = blur(alphaOf(f), w, h), t = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) { row += a[y * w + x]; t[(y + 1) * W + x + 1] = t[y * W + x + 1] + row; }
    }
    return t;
  });
  const sum = (t: Float64Array, x0: number, y0: number) => {
    const X0 = Math.max(0, x0), Y0 = Math.max(0, y0), X1 = Math.min(w, x0 + size), Y1 = Math.min(h, y0 + size);
    return X1 <= X0 || Y1 <= Y0 ? 0 : t[Y1 * W + X1] - t[Y0 * W + X1] - t[Y1 * W + X0] + t[Y0 * W + X0];
  };
  // the fullest neighbourhood of `t` within `reach` px of (x0, y0): where anything in this one could have moved to
  const most = (t: Float64Array, x0: number, y0: number) => {
    let v = 0;
    for (let dy = -reach; dy <= reach; dy++) for (let dx = -reach; dx <= reach; dx++) v = Math.max(v, sum(t, x0 + dx, y0 + dy));
    return v;
  };
  const m = (k: number) => ((k % n) + n) % n;
  let worstFlash = 0, worstGap = 0;
  for (let k = 0; k < n; k++) {
    const [a, b, c] = [tables[m(k - 1)], tables[k], tables[m(k + 1)]];
    let flash = { v: 0, x: 0, y: 0 }, gap = { v: 0, x: 0, y: 0 };
    for (let y0 = 0; y0 + size <= h; y0 += 4) for (let x0 = 0; x0 + size <= w; x0 += 4) {
      const mb = sum(b, x0, y0), ma = sum(a, x0, y0), mc = sum(c, x0, y0);
      if (mb - Math.max(ma, mc) > flash.v) { const v = mb - Math.max(most(a, x0, y0), most(c, x0, y0)); if (v > flash.v) flash = { v, x: x0, y: y0 }; }
      if (Math.min(ma, mc) - mb > gap.v) { const v = Math.min(ma, mc) - most(b, x0, y0); if (v > gap.v) gap = { v, x: x0, y: y0 }; }
    }
    worstFlash = Math.max(worstFlash, flash.v); worstGap = Math.max(worstGap, gap.v);
    if (flash.v > limit) events.push(`mass flash at frame ${k} (${flash.x},${flash.y}) ${size}px: ${flash.v.toFixed(1)} px of particle over the mean of the frames either side`);
    if (gap.v > limit) events.push(`mass gap at frame ${k} (${gap.x},${gap.y}) ${size}px: ${gap.v.toFixed(1)} px of particle under the mean of the frames either side`);
  }
  return { events, flash: worstFlash, gap: worstGap };
}

/** Paste a small, fully opaque soft blob (a stand-in particle, like a 0/1 glyph at board size) into `png` at (x, y). */
export function injectParticle(png: PNG, x: number, y: number, rgb: readonly [number, number, number] = [0x8f, 0xd8, 0xff], r = 2.5): PNG {
  const out = new PNG({ width: png.width, height: png.height });
  png.data.copy(out.data);
  for (let py = Math.floor(y - r - 1); py <= Math.ceil(y + r + 1); py++) for (let px = Math.floor(x - r - 1); px <= Math.ceil(x + r + 1); px++) {
    const a = Math.max(0, Math.min(1, r + 0.5 - Math.hypot(px - x, (py - y) * 0.8)));
    if (a <= 0 || px < 0 || py < 0 || px >= png.width || py >= png.height) continue;
    const i = (py * png.width + px) * 4, ba = out.data[i + 3] / 255;
    for (let c = 0; c < 3; c++) out.data[i + c] = Math.round(rgb[c] * a + out.data[i + c] * (1 - a));
    out.data[i + 3] = Math.round(255 * (a + ba * (1 - a)));
  }
  return out;
}

/** Render one frame through the bake page (web/clay-bake.html), as a decoded PNG. */
export async function renderFrame(page: Page, id: ClayStateId, t: number, size: number, debug?: DebugPass): Promise<PNG> {
  const b64 = await page.evaluate(([state, tt, s, dbg]) => (window as any).__clay.frame({ state, t: tt, puffed: false, colour: '#e07a4f', shadows: true }, s, dbg),
    [id, t, size, debug] as const);
  return PNG.sync.read(Buffer.from(b64 as string, 'base64'));
}

/** Every baked frame of `id`, in order. */
export async function renderLoop(page: Page, id: ClayStateId, size: number, debug?: DebugPass): Promise<PNG[]> {
  const out: PNG[] = [];
  for (let i = 0; i < frameCount(id); i++) out.push(await renderFrame(page, id, frameTime(id, i), size, debug));
  return out;
}

/** A state's motion per second of animation: mean frame-to-frame difference, scaled to 24 frames a second. */
export const motionPerSecond = (mean: number, fps: number) => (mean * fps) / 24;

// ---------- eye catch-lights ----------

const near = (data: Buffer, i: number, rgb: readonly number[], tol: number) =>
  data[i + 3] > 128 && Math.abs(data[i] - rgb[0]) <= tol && Math.abs(data[i + 1] - rgb[1]) <= tol && Math.abs(data[i + 2] - rgb[2]) <= tol;

/**
 * Catch-light pixels (the `highlight` pass paints them flat magenta) checked against the visible eyeball (the `eyes`
 * pass paints it flat blue, catch-lights hidden). The lid edge of a column is the top of the visible eyeball there.
 * `above`: catch-light pixels above the lid edge of their column, or in a column with no visible eyeball (sitting on
 * the lid); `off`: catch-light pixels with no visible eyeball within one pixel (on the lid or the face); `gap`: the
 * fewest pixels from any catch-light pixel up to the lid edge of its column (0: it touches the lid line).
 */
export function catchlightCheck(hi: PNG, eyes: PNG): { pixels: number; above: string[]; off: string[]; gap: number } {
  const { width: w, height: h } = hi;
  const isHi = (x: number, y: number) => near(hi.data, (y * w + x) * 4, [255, 0, 255], 90);
  const isEye = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && near(eyes.data, (y * w + x) * 4, [0, 0, 255], 110);
  const top = new Int32Array(w).fill(-1);
  for (let x = 0; x < w; x++) for (let y = 0; y < h; y++) if (isEye(x, y)) { top[x] = y; break; }
  let pixels = 0, gap = Infinity;
  const above: string[] = [], off: string[] = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!isHi(x, y)) continue;
    pixels++;
    // the top of the eyeball in this column, allowing a pixel of anti-aliasing either side
    const edge = Math.min(...[x - 1, x, x + 1].map((c) => (c >= 0 && c < w && top[c] >= 0 ? top[c] : Infinity)));
    if (edge === Infinity || y < edge - 1) above.push(`(${x},${y}) lid edge ${edge === Infinity ? 'none' : edge}`);
    if (edge !== Infinity) gap = Math.min(gap, y - edge);
    let ok = false;
    for (let dy = -1; dy <= 1 && !ok; dy++) for (let dx = -1; dx <= 1 && !ok; dx++) ok = isEye(x + dx, y + dy);
    if (!ok) off.push(`(${x},${y})`);
  }
  return { pixels, above, off, gap };
}

/**
 * The lid frames of a state, found from its pose data (spec §7.4.8): `half`, a frame whose lids are half closed (a bead
 * squashed to 0.25-0.75 open, the closest to half; or, in a state with half-lids over the beads, W3+'s narrowed eyes
 * and N3's flat lids, its most open frame, where the most catch-light is under the lid), `full`, its most closed frame
 * when that is under 0.25 open, and `most`, its most closed frame in any case. Frames are listed once.
 */
export function lidFrames(id: ClayStateId): { half?: number; full?: number; most: number; frames: number[]; lidded: boolean } {
  const poses = Array.from({ length: frameCount(id) }, (_, i) => poseFor(id, frameTime(id, i), false));
  const open = poses.map((p) => p.eyeOpen);
  const most = open.indexOf(Math.min(...open));
  const lidded = poses.some((p) => p.narrowEyes > 0.5 || p.flatEyes > 0.5);
  let half: number | undefined;
  if (lidded) half = open.indexOf(Math.max(...open));
  else {
    const cands = open.map((v, i) => [Math.abs(v - 0.5), i, v] as const).filter(([, , v]) => v >= 0.25 && v <= 0.75).sort((a, b) => a[0] - b[0]);
    half = cands[0]?.[1];
  }
  const full = open[most] < 0.25 ? most : undefined;
  return { half, full, most, lidded, frames: [...new Set([half, full, most].filter((x): x is number => x !== undefined))] };
}

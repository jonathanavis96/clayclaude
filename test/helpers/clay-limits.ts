/**
 * Limits of the round-3 pixel checks (spec §7.4.8), chosen from measurements of every state at board size (96 px)
 * with tools/clay-measure.ts (its --md=<file> writes the measured values as a table).
 */
import type { ClayStateId } from '../../web/src/clay/states.js';

/**
 * Whole frame: the largest mean luminance difference allowed between adjacent frames (loop seam included). Round 2
 * asked for the 99th percentile of all adjacent pairs x 2: measured over all 796 pairs (round 3) that is 0.073 x 2 =
 * 0.146, the top 1 % being N6's deliberately aggressive jumping; the largest pair is 0.077 (N6). The limit is tighter
 * than the rule: 0.1, a quarter above the largest real pair. A small particle cannot show at this scale (a one-frame
 * 0/1 is about 0.002 of the frame), which is what the tile and particle checks are for.
 */
export const JUMP = 0.1;
/** Tile: a change above this in an 8x8 tile that pops (calm either side) or flashes (one frame only) fails. */
export const TILE_JUMP = 0.06;
/**
 * Particle pass: a particle may appear or vanish between two frames only while small (at most PARTICLE_MASS fully
 * opaque pixels' worth) or faint (no pixel over PARTICLE_ALPHA). A 0/1 at full strength is about 10 such pixels.
 */
export const PARTICLE_MASS = 3;
export const PARTICLE_ALPHA = 0.3;
/**
 * Particle spike check (`particleSpikeCheck`, the particle-only pass): particle mass, in fully opaque pixels' worth,
 * shown in an 8x8 tile for one frame only, or missing there for one frame only, wherever the other particles are.
 * Measured over every state: at most 4.7 (W7's flung drops, which turn as they fly; S7's ice glints at the top of a
 * twinkle). A full-strength 0/1 bit is about 23, a Z about 45; the fixtures' stand-in particle touching a W2 bit, or an
 * extra Zzz beside S3's, 7.6 or more.
 */
export const PARTICLE_SPIKE = 6;
/**
 * Particle mass spike (`particleMassSpike`, the particle-only pass, 24 x 24 px neighbourhoods): particle mass, in fully
 * opaque pixels' worth, that a neighbourhood gains for one frame only (or loses for one frame only), measured against
 * the frames either side. Measured over every state: at most 7.4 (W7's flung drops), then S2's and S7's twinkles about
 * 6. The fixtures: a stand-in particle touching a W2 bit 20.9 or more; S3's middle Z shown at full strength and size
 * for one frame (the round-3 review's case, merged with the other two Zs) 12.3 or more over the loop, least where
 * the Z is already near full size (frames 12-16, about 20 px of mass added), most at the start of its rise (37).
 * `particleSpikeCheck` alone measures that case at 4.5-5.7 in frames 9-16, under its limit.
 */
export const PARTICLE_MASS_SPIKE = 10;
/** The farthest a particle moves in one frame at board size (px), the spike checks' search; N6's sweat drips about 11. */
export const PARTICLE_REACH = 6;
export const PARTICLE_REACH_BY_STATE: Partial<Record<ClayStateId, number>> = { N6: 12 };
export const particleReach = (id: ClayStateId) => PARTICLE_REACH_BY_STATE[id] ?? PARTICLE_REACH;
/**
 * Tile pops (`jumpCheck`): a tile's change between two frames over this many times the most any tile round it changed
 * the frame before and the frame after. Measured: inside a loop, at most 3.8 (X2, X3, S6: an eye opening or shutting in
 * one frame, an authored blink); at the loop seam at most 1.6 (W7), and no pair of any state other than a blink goes
 * over 2.4 (N1). Seams that do not meet: W1's squash jumping 0.1 measures 4.0, S1's eyes jumping from half to fully
 * open 3.6, X2's body jumping 0.15 sideways 12.
 */
export const POP = { any: 5, seam: 2.5 } as const;
/** Each step of an escalating timeline moves at least this much more than the one before (spec §7.4.8). */
export const MOTION_STEP = 1.15;
export const MOTION_ORDERS: ReadonlyArray<readonly ClayStateId[]> = [
  ['N4', 'N5', 'N6'],
  ['W2', 'W3', 'W4', 'W5', 'W6', 'W7'],
];

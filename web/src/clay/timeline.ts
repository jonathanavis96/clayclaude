import { applyOverrides, loopMsFor } from './overrides.js';
import { applyPuff, evalScript, type Pose } from './pose.js';
import { FROZEN, SCRIPTS } from './scripts.js';
import type { ClayStateId } from './states.js';

/** Baked frames in one pass of a state. A still state has one. */
export function frameCount(id: ClayStateId): number {
  const s = SCRIPTS[id];
  return s.still ? 1 : Math.max(2, Math.round((loopMs(id) * s.fps) / 1000));
}

/** Length of one pass of `id` in ms: the script's, or its authored timing (overrides.json). */
export const loopMs = (id: ClayStateId): number => loopMsFor(id, SCRIPTS[id].loopMs);

/**
 * Loop position of baked frame `i` (t = i / N): the pose at the start of the slot `resolvePlayback`
 * shows it in. A loop never repeats frame 0 at its end, so it wraps seamlessly. Every state loops
 * (round 3: there are no "plays once" states).
 */
export function frameTime(id: ClayStateId, i: number): number {
  const n = frameCount(id);
  return n === 1 ? 0 : i / n;
}

/** X2 strain cycles per pass: about 1.7 Hz, and always at least 4 baked frames per cycle. */
export const puffCycles = (id: ClayStateId): number => Math.max(1, Math.round(loopMs(id) / 600));

/**
 * The pose of `id` at loop position `t`, with the X2 modifier applied (X2 alone is the idle pose puffed), and the
 * authored overrides last (spec §7.4.7). Pure for a given overrides file.
 */
export function poseFor(id: ClayStateId, t: number, puffed: boolean): Pose {
  let p = evalScript(SCRIPTS[id], t);
  // a stopped character lies flat; it does not strain
  if (id !== 'X1' && (puffed || id === 'X2')) p = applyPuff(p, t, puffCycles(id), FROZEN.has(id));
  return applyOverrides(id, t, p);
}

export interface Resolved {
  /** Baked frame to show. */
  frame: number;
  /** Loop position 0..1 (for live rendering). */
  t: number;
}

/** What plays `elapsedMs` after `id` started: every state loops (round 3), a still state is its one frame. Pure. */
export function resolvePlayback(id: ClayStateId, elapsedMs: number): Resolved {
  const e = Math.max(0, elapsedMs);
  const ms = loopMs(id);
  const n = frameCount(id);
  if (n === 1) return { frame: 0, t: 0 };
  const t = (e % ms) / ms;
  return { frame: Math.min(n - 1, Math.floor(t * n)), t };
}

/**
 * Frame-rate cap for the shared loop. rAF fires at the display rate; this lets a tick through
 * every 1000/cap ms, with 4 ms of slack so a 30 fps cap on a 60 Hz display is every second tick.
 */
export class FrameGate {
  private last = -Infinity;
  constructor(private cap: number) {}
  setCap(cap: number): void { this.cap = cap; }
  pass(now: number): boolean {
    if (this.cap >= 60 || now - this.last >= 1000 / this.cap - 4) { this.last = now; return true; }
    return false;
  }
}

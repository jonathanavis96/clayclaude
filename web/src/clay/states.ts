import type { Session } from '../../../src/types.js';

/** 26 renderable states: spec §7.2's 25 (W1–W7, N1–N7, S1–S7, X1–X4) plus L1, the launcher's waving card (§5.2). */
export type ClayStateId =
  | 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W7'
  | 'N1' | 'N2' | 'N3' | 'N4' | 'N5' | 'N6' | 'N7'
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6' | 'S7'
  | 'X1' | 'X2' | 'X3' | 'X4'
  | 'L1';

export const CLAY_STATES: readonly ClayStateId[] = Object.freeze([
  'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
  'X1', 'X2', 'X3', 'X4',
  'L1',
] as ClayStateId[]);

export const isClayState = (x: unknown): x is ClayStateId => typeof x === 'string' && (CLAY_STATES as readonly string[]).includes(x);

const MIN = 60_000;

/** Lower bounds (minutes) of W2..W7. The W thresholds are fixed times (spec §7.2). */
export const WORKING_FROM_MIN = [1, 5, 15, 30, 60, 120] as const;
/** Lower bounds (minutes) of N2..N5 and S2..S5. N6/S6 start 5 min before the cache TTL, N7/S7 at it. */
export const WAITING_FROM_MIN = [1, 5, 10, 30] as const;
/** N6 and S6 start this many minutes before `cacheTtlMinutes`. */
export const CACHE_WARN_MIN = 5;

/** Step (1-based) of a timeline whose step k+1 starts at `bounds[k-1]`. */
const step = (age: number, bounds: readonly number[]): number => 1 + bounds.filter((b) => age >= b).length;

/**
 * Pure. Picks the animation for a session at `now` (spec §7.2, three timelines of seven).
 * - Lower bounds are inclusive: at exactly 1 min a working session is W2.
 * - The cache brackets win: N6/S6 start 5 min before `cacheTtlMinutes`, N7/S7 at it, whatever
 *   the earlier brackets say (with a 20 min TTL, needs-you goes N1, N2, N3, N4 then N6 at 15 min).
 * - W1 and S1 are returned for their whole bracket (0–1 min) and loop like every other state (round 3:
 *   there are no "plays once" states).
 * - `puffed` is the X2 modifier, `overContext` as-is. The renderer ignores it for X1 (a stopped
 *   character lies flat and does not strain).
 */
export function clayStateFor(
  s: Pick<Session, 'state' | 'stateSince' | 'overContext'>,
  now: number,
  cacheTtlMinutes: number,
): { id: ClayStateId; puffed: boolean } {
  const age = Math.max(0, now - s.stateSince) / MIN;
  const ttl = cacheTtlMinutes;
  const waiting = (p: 'N' | 'S'): ClayStateId =>
    `${p}${age >= ttl ? 7 : age >= ttl - CACHE_WARN_MIN ? 6 : step(age, WAITING_FROM_MIN)}` as ClayStateId;
  let id: ClayStateId;
  switch (s.state) {
    case 'working': id = `W${step(age, WORKING_FROM_MIN)}` as ClayStateId; break;
    case 'needs-you': id = waiting('N'); break;
    case 'asleep': id = waiting('S'); break;
    case 'stopped': id = 'X1'; break;
    case 'limit': id = 'X3'; break;
    default: id = 'X4'; // compacting
  }
  return { id, puffed: !!s.overContext };
}

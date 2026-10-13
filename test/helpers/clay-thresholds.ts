import type { Session } from '../../src/types.js';

/**
 * Spec 7.2 thresholds (approved character list, three timelines of seven), written out independently
 * of Plan 2's clayStateFor so the demo can be tested on its own. test/clay-states.test.ts cross-checks
 * this against the real function.
 */
export function refClay(s: Pick<Session, 'state' | 'stateSince' | 'overContext'>, now: number, ttlMin: number): { id: string; puffed: boolean } {
  const min = Math.max(0, now - s.stateSince) / 60_000;
  const puffed = s.overContext;
  // N and S share their brackets; the two cache brackets win over the earlier ones when the TTL is short
  const timed = (p: string) => min >= ttlMin ? p + '7' : min >= ttlMin - 5 ? p + '6'
    : min < 1 ? p + '1' : min < 5 ? p + '2' : min < 10 ? p + '3' : min < 30 ? p + '4' : p + '5';
  let id: string;
  switch (s.state) {
    case 'working': id = min < 1 ? 'W1' : min < 5 ? 'W2' : min < 15 ? 'W3' : min < 30 ? 'W4' : min < 60 ? 'W5' : min < 120 ? 'W6' : 'W7'; break;
    case 'needs-you': id = timed('N'); break;
    case 'asleep': id = timed('S'); break;
    case 'stopped': id = 'X1'; break;
    case 'limit': id = 'X3'; break;
    default: id = 'X4';
  }
  return { id, puffed };
}

/** Every renderable state except L1 (the launcher card): the demo gallery shows all 25. */
export const ALL_CLAY_IDS = [
  'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
  'X1', 'X2', 'X3', 'X4',
];

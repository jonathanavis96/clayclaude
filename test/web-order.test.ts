import { describe, it, expect } from 'vitest';
import { sortSessions, formatAge, formatCountdown } from '../web/src/order.js';

const s = (key: string, state: string, stateSince: number) => ({ key, state, stateSince } as any);

describe('sortSessions', () => {
  it('orders by state precedence, then age rules', () => {
    const out = sortSessions([s('a', 'asleep', 5), s('b', 'working', 1), s('c', 'needs-you', 9), s('d', 'needs-you', 2), s('e', 'stopped', 9), s('f', 'working', 8)]);
    expect(out.map((x) => x.key)).toEqual(['d', 'c', 'f', 'b', 'a', 'e']);
  });
});
describe('formatAge', () => {
  it('formats', () => {
    expect([45_000, 12 * 60_000, 74 * 60_000, 2 * 86400_000].map(formatAge)).toEqual(['45s', '12m', '1h 14m', '2d']);
  });
});
describe('formatCountdown', () => {
  it('rounds up, so "resets in" never claims less time than is left', () => {
    expect([45_000, 45_200, 61_000, 12 * 60_000, 59 * 60_000 + 1, 90 * 60_000 + 30_000, 150 * 60_000, 26 * 3600_000, 3 * 86400_000 - 1].map(formatCountdown))
      .toEqual(['45s', '46s', '2m', '12m', '1h', '1h 31m', '2h 30m', '1d 2h', '3d']);
  });
  it('never shows a negative time', () => {
    expect(formatCountdown(-5000)).toBe('0s');
  });
});

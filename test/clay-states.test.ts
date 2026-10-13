import { describe, it, expect } from 'vitest';
import { CLAY_STATES, clayStateFor } from '../web/src/clay/states.js';
import { refClay } from './helpers/clay-thresholds.js';

const MIN = 60_000;
const NOW = Date.parse('2026-10-12T12:00:00Z');
const at = (state: string, minutes: number, overContext = false, ttl = 60) =>
  clayStateFor({ state: state as never, stateSince: NOW - minutes * MIN, overContext }, NOW, ttl);
const id = (state: string, minutes: number, ttl = 60) => at(state, minutes, false, ttl).id;
const ids = (state: string, minutes: number[], ttl = 60) => minutes.map((m) => id(state, m, ttl));

describe('clayStateFor', () => {
  it('lists the 26 renderable states in timeline order (spec §7.2: W1–W7, N1–N7, S1–S7, X1–X4, plus L1)', () => {
    expect(CLAY_STATES).toEqual([
      'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7',
      'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
      'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
      'X1', 'X2', 'X3', 'X4',
      'L1',
    ]);
  });

  it('working: W1 0–1, W2 1–5, W3 5–15, W4 15–30, W5 30–60, W6 60–120, W7 120+ (lower bounds inclusive; fixed, whatever the TTL)', () => {
    const m = [0, 0.999, 1, 4.999, 5, 14.999, 15, 29.999, 30, 59.999, 60, 119.999, 120, 600];
    const want = ['W1', 'W1', 'W2', 'W2', 'W3', 'W3', 'W4', 'W4', 'W5', 'W5', 'W6', 'W6', 'W7', 'W7'];
    expect(ids('working', m)).toEqual(want);
    expect(ids('working', m, 20)).toEqual(want);
  });

  it('needs you, TTL 60: N1 0–1, N2 1–5, N3 5–10, N4 10–30, N5 30–55, N6 55–60, N7 60+', () => {
    expect(ids('needs-you', [0, 0.999, 1, 4.999, 5, 9.999, 10, 29.999, 30, 54.999, 55, 59.999, 60, 300]))
      .toEqual(['N1', 'N1', 'N2', 'N2', 'N3', 'N3', 'N4', 'N4', 'N5', 'N5', 'N6', 'N6', 'N7', 'N7']);
  });

  it('asleep, TTL 60: S1 0–1, S2 1–5, S3 5–10, S4 10–30, S5 30–55, S6 55–60, S7 60+', () => {
    expect(ids('asleep', [0, 0.999, 1, 4.999, 5, 9.999, 10, 29.999, 30, 54.999, 55, 59.999, 60, 300]))
      .toEqual(['S1', 'S1', 'S2', 'S2', 'S3', 'S3', 'S4', 'S4', 'S5', 'S5', 'S6', 'S6', 'S7', 'S7']);
  });

  it('TTL 20: the cache brackets win (N6/S6 at 15, N7/S7 at 20), so N5/S5 never show', () => {
    const m = [0, 0.999, 1, 4.999, 5, 9.999, 10, 14.999, 15, 19.999, 20, 300];
    expect(ids('needs-you', m, 20)).toEqual(['N1', 'N1', 'N2', 'N2', 'N3', 'N3', 'N4', 'N4', 'N6', 'N6', 'N7', 'N7']);
    expect(ids('asleep', m, 20)).toEqual(['S1', 'S1', 'S2', 'S2', 'S3', 'S3', 'S4', 'S4', 'S6', 'S6', 'S7', 'S7']);
  });

  it('N6/S6 start 5 min before cacheTtlMinutes and N7/S7 at it', () => {
    expect(ids('needs-you', [84.999, 85, 89.999, 90], 90)).toEqual(['N5', 'N6', 'N6', 'N7']);
    expect(ids('asleep', [84.999, 85, 89.999, 90], 90)).toEqual(['S5', 'S6', 'S6', 'S7']);
  });

  it('a very short TTL still lets the cache brackets win from the start', () => {
    expect(ids('needs-you', [4, 5, 9.999, 10], 10)).toEqual(['N2', 'N6', 'N6', 'N7']);
    expect(ids('asleep', [0, 4.999, 5], 5)).toEqual(['S6', 'S6', 'S7']);
  });

  it('W1 and S1 cover their whole bracket, and loop there like every state (round 3: no hand-over)', () => {
    expect(id('working', 0.5)).toBe('W1');
    expect(id('asleep', 0.5)).toBe('S1');
  });

  it('stopped, limit and compacting map to X1, X3 and X4', () => {
    expect([id('stopped', 3), id('limit', 3), id('compacting', 3)]).toEqual(['X1', 'X3', 'X4']);
  });

  it('puffed is the X2 modifier, overContext as-is, on any base state', () => {
    expect(at('working', 7, true)).toEqual({ id: 'W3', puffed: true });
    expect(at('asleep', 7, false)).toEqual({ id: 'S3', puffed: false });
    expect(at('stopped', 7, true)).toEqual({ id: 'X1', puffed: true });
  });

  it('a stateSince in the future (clock skew) counts as just entered', () => {
    expect(id('working', -3)).toBe('W1');
  });

  it('the demo tests\' independent threshold table agrees with clayStateFor at every boundary', () => {
    const minutes = [0, 0.5, 1, 3, 5, 7, 10, 14.999, 15, 19.999, 20, 29.999, 30, 45, 54.999, 55, 59.999, 60, 90, 119.999, 120, 300];
    for (const ttl of [20, 60, 90]) for (const state of ['working', 'needs-you', 'asleep', 'stopped', 'limit', 'compacting']) for (const m of minutes) {
      const s = { state: state as never, stateSince: NOW - m * MIN, overContext: m > 50 };
      expect(clayStateFor(s, NOW, ttl), `${state} ${m} min, TTL ${ttl}`).toEqual(refClay(s, NOW, ttl));
    }
  });
});

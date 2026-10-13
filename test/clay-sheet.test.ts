import { describe, it, expect } from 'vitest';
import { DECODED_BUDGET, DecodedCache, planEviction } from '../web/src/clay/budget.js';
import { MAX_SHEET_PX, SIZE_BUCKETS, allStatesBytes, bucketFor, keyString, layoutFor, sheetBytes } from '../web/src/clay/sheet.js';
import { CLAY_STATES } from '../web/src/clay/states.js';

const MB = 1024 * 1024;

describe('sheets', () => {
  it('a slot asks for the smallest bucket at least its size', () => {
    expect([1, 48, 49, 96, 97, 144, 145, 320, 900].map(bucketFor)).toEqual([48, 48, 64, 96, 112, 144, 160, 320, 320]);
  });

  it('the key has every part spec §7.3 names: state, pixel size, shadows, colour, renderer version (and puff)', () => {
    expect(keyString({ state: 'N4', puffed: true, size: 96, shadows: false, colour: '#E07A4F', version: 'abc' })).toBe('N4|p|96|f|e07a4f|abc');
  });

  it('every layout fits a 4096 px texture at every bucket', () => {
    for (const size of SIZE_BUCKETS) for (const state of CLAY_STATES) {
      const l = layoutFor({ state, size });
      expect(l.cols * l.rows).toBeGreaterThanOrEqual(l.frames);
      expect(Math.max(l.width, l.height)).toBeLessThanOrEqual(MAX_SHEET_PX);
    }
  });

  it('memory plan: all 26 states decoded is about 30 MB at 96 px and 68 MB at 144 px (797 frames, round 3)', () => {
    expect(allStatesBytes(96) / MB).toBeCloseTo(30.1, 0);
    expect(allStatesBytes(144) / MB).toBeCloseTo(68.4, 0);
    expect(allStatesBytes(96)).toBeLessThan(DECODED_BUDGET);
    expect(sheetBytes(layoutFor({ state: 'W2', size: 96 }))).toBe(8 * 96 * 6 * 96 * 4);
  });
});

describe('DecodedCache', () => {
  it('evicts least recently used unpinned sheets over budget, never pinned ones', () => {
    const freed: string[] = [];
    const c = new DecodedCache<string>(100, (v) => freed.push(v));
    c.set('a', 'A', 40); c.set('b', 'B', 40);
    c.pin('a');
    c.get('b');
    c.set('c', 'C', 40);                  // 120 > 100: b is the only unpinned older entry
    expect(freed).toEqual(['B']);
    expect(c.keys().sort()).toEqual(['a', 'c']);
    c.set('d', 'D', 70);                  // 150: c goes; a is pinned; d was just loaded and stays
    expect(freed).toEqual(['B', 'C']);
    expect(c.bytes).toBe(110);            // over budget only because of the pin
    c.unpin('a');                         // now a can go
    expect(freed).toEqual(['B', 'C', 'A']);
    expect(c.keys()).toEqual(['d']);
  });

  it('replacing a key frees the old value', () => {
    const freed: string[] = [];
    const c = new DecodedCache<string>(1000, (v) => freed.push(v));
    c.set('a', 'A1', 10); c.set('a', 'A2', 10);
    expect(freed).toEqual(['A1']);
    expect(c.bytes).toBe(10);
  });
});

describe('DecodedCache.delete', () => {
  it('forgets an entry without freeing it (its bitmap may already be unusable)', () => {
    const freed: string[] = [];
    const c = new DecodedCache<string>(1000, (v) => freed.push(v));
    c.set('a', 'A', 10);
    c.delete('a');
    expect([c.keys(), c.bytes, freed]).toEqual([[], 0, []]);
  });
});

describe('planEviction', () => {
  it('drops other renderer versions first, then least recently used over budget', () => {
    const e = (key: string, bytes: number, lastUsed: number, version = 'v2') => ({ key, bytes, lastUsed, version });
    expect(planEviction([e('old', 5, 9, 'v1'), e('a', 50, 1), e('b', 50, 2), e('c', 50, 3)], 'v2', 100)).toEqual(['old', 'a']);
    expect(planEviction([e('a', 10, 1)], 'v2', 100)).toEqual([]);
  });
});

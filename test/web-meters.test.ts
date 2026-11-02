import { describe, it, expect } from 'vitest';
import { ringsSvg, barsSvg } from '../web/src/meters.js';

const u = (fiveHour: number | null, weekly: number | null, stale = false) =>
  ({ account: 'a', label: 'A', colour: '#4fd1c5', fiveHour, weekly, stale } as any);

describe('meters', () => {
  it('rings show the 5-hour % and turn the outer ring amber at 80%', () => {
    expect(ringsSvg(u(64, 41))).toContain('>64%<');
    expect(ringsSvg(u(64, 41))).not.toContain('var(--needs)');
    expect(ringsSvg(u(82, 41))).toContain('var(--needs)');
  });
  it('rings render a dash when unknown and dim when stale', () => {
    const svg = ringsSvg(u(null, null, true));
    expect(svg).toContain('>–<');
    expect(svg).toContain('opacity:.45');
  });
  it('bars render two bars', () => {
    expect(barsSvg(u(10, 20)).match(/<rect/g)!.length).toBe(4);
  });
  it('a weekly-only plan (no five-hour limit): one ring and one bar, the week figure, no 5h figure and no 0%', () => {
    const rings = ringsSvg(u(null, 47));
    expect(rings).toContain('>47%<');
    expect(rings.match(/<circle/g)!.length).toBe(2);
    expect(rings).not.toContain('>–<');
    expect(barsSvg(u(null, 47)).match(/<rect/g)!.length).toBe(2);
    expect(barsSvg(u(null, 47, true))).toContain('opacity:.45'); // stale still dims it
  });
  it('a five-hour figure of 0 is still a figure, not weekly-only', () => {
    expect(ringsSvg(u(0, 47)).match(/<circle/g)!.length).toBe(4);
    expect(barsSvg(u(0, 47)).match(/<rect/g)!.length).toBe(4);
  });
  it('a stale meter says "stale" with the age of its last value, in rings and in bars (spec §12)', () => {
    const NOW = Date.parse('2026-10-12T12:00:00Z');
    const old = { ...u(41, 63, true), updatedAt: NOW - 25 * 60_000 };
    for (const html of [ringsSvg(old, NOW), barsSvg(old, NOW)]) expect(html).toContain('<div class="stale">stale · 25m</div>');
    expect(ringsSvg({ ...u(null, null, true), updatedAt: null }, NOW)).toContain('<div class="stale">stale</div>');
    expect(ringsSvg({ ...u(41, 63), updatedAt: NOW }, NOW)).not.toContain('class="stale"');
  });
});

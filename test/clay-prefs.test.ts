import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAY_PREFS, normaliseClayPrefs, readClayPrefs, writeClayPrefs } from '../web/src/clay/prefs.js';

const mem = (init?: string) => { const m = new Map<string, string>(); if (init !== undefined) m.set('clayclaude.prefs', init); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }; };

describe('clay prefs', () => {
  it('defaults match the documented clay prefs', () => {
    expect(DEFAULT_CLAY_PREFS).toEqual({ mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' });
  });
  it('keeps good values and replaces bad ones', () => {
    expect(normaliseClayPrefs({ mode: 'live', shadows: false, fpsCap: 30, bodyColour: '#AABBCC' })).toEqual({ mode: 'live', shadows: false, fpsCap: 30, bodyColour: '#aabbcc' });
    expect(normaliseClayPrefs({ mode: 'warp', shadows: 'yes', fpsCap: 144, bodyColour: 'red;x' })).toEqual(DEFAULT_CLAY_PREFS);
    expect(normaliseClayPrefs(null)).toEqual(DEFAULT_CLAY_PREFS);
  });
  it('reads `clay` from clayclaude.prefs, tolerating anything', () => {
    expect(readClayPrefs(mem(JSON.stringify({ meters: 'bars', clay: { mode: 'bake' } }))).mode).toBe('bake');
    expect(readClayPrefs(mem('{bad'))).toEqual(DEFAULT_CLAY_PREFS);
    expect(readClayPrefs(mem())).toEqual(DEFAULT_CLAY_PREFS);
    expect(readClayPrefs({ getItem: () => { throw new Error('blocked'); }, setItem: () => {} })).toEqual(DEFAULT_CLAY_PREFS);
  });
  it('writes only `clay`, keeping every other key', () => {
    const s = mem(JSON.stringify({ meters: 'bars', night: { enabled: true } }));
    writeClayPrefs(s, { ...DEFAULT_CLAY_PREFS, shadows: false });
    expect(JSON.parse(s.m.get('clayclaude.prefs')!)).toEqual({ meters: 'bars', night: { enabled: true }, clay: { ...DEFAULT_CLAY_PREFS, shadows: false } });
  });
});

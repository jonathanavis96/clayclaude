import { describe, it, expect } from 'vitest';
import { DEFAULT_PREFS, effective, loadPrefs, parsePrefs, savePrefs } from '../web/src/prefs.js';
import { nightLevel } from '../web/src/night.js';
import { newlyNeedsYou, needsYouKeys, visibleSessions } from '../web/src/filter.js';
import { fuzzyFilter, fuzzyScore } from '../web/src/fuzzy.js';
import { esc } from '../web/src/html.js';
import { postAction } from '../web/src/net.js';

const mem = (init?: string) => { let v = init ?? null; return { getItem: () => v, setItem: (_k: string, x: string) => { v = x; }, get: () => v }; };

describe('prefs', () => {
  it('fills defaults for missing, corrupt and wrong-typed values', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('{nope')).toEqual(DEFAULT_PREFS);
    expect(parsePrefs('[1]')).toEqual(DEFAULT_PREFS);
    const p = parsePrefs(JSON.stringify({ meters: 'bars', night: { enabled: true, from: '25:99', level: 7 }, sound: 'yes', quickReplies: ['ok', '', 5] }));
    expect(p.meters).toBe('bars');
    expect(p.night).toEqual({ enabled: true, from: '22:00', to: '06:30', level: 0.6 });
    expect(p.sound).toBe(false);
    expect(p.quickReplies).toEqual(['ok']);
  });
  it('layout is auto unless strips or grid was chosen (spec §5.3)', () => {
    expect(DEFAULT_PREFS.layout).toBe('auto');
    expect(parsePrefs('{"layout":"grid"}').layout).toBe('grid');
    expect(parsePrefs('{"layout":"strips"}').layout).toBe('strips');
    expect(parsePrefs('{"layout":"mosaic"}').layout).toBe('auto');
  });
  it('reads Plan 1\'s {meters} object as-is', () => {
    expect(parsePrefs('{"meters":"bars"}').meters).toBe('bars');
  });
  it('saving keeps keys it does not own (the clay prefs)', () => {
    const s = mem(JSON.stringify({ meters: 'rings', clay: { mode: 'bake', shadows: false } }));
    savePrefs(s, { ...loadPrefs(s), sound: true });
    const saved = JSON.parse(s.get()!);
    expect(saved.clay).toEqual({ mode: 'bake', shadows: false });
    expect(saved.sound).toBe(true);
  });
  it('config defaults apply unless the user chose', () => {
    const d = { quickReplies: ['yes', 'no'], confirmBeforeSend: false, stoppedRetentionMs: 3 * 3600_000 };
    expect(effective(DEFAULT_PREFS, d)).toEqual(d);
    expect(effective({ ...DEFAULT_PREFS, confirmBeforeSend: true, quickReplies: ['go'], stoppedRetentionMs: 60_000 }, d)).toEqual({ quickReplies: ['go'], confirmBeforeSend: true, stoppedRetentionMs: 60_000 });
  });
});

describe('nightLevel', () => {
  const n = { enabled: true, from: '22:00', to: '06:30', level: 0.5 };
  const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m);
  it('dims across midnight', () => {
    expect([at(21, 59), at(22, 0), at(23, 30), at(2), at(6, 29), at(6, 30), at(12)].map((d) => nightLevel(d, n))).toEqual([0, 0.5, 0.5, 0.5, 0.5, 0, 0]);
  });
  it('handles a same-day window and being off', () => {
    expect(nightLevel(at(13), { ...n, from: '12:00', to: '14:00' })).toBe(0.5);
    expect(nightLevel(at(15), { ...n, from: '12:00', to: '14:00' })).toBe(0);
    expect(nightLevel(at(23), { ...n, enabled: false })).toBe(0);
    expect(nightLevel(at(23), { ...n, from: '10:00', to: '10:00' })).toBe(0);
  });
});

describe('filter', () => {
  const s = (key: string, state: string, stateSince = 0, hostOnline = true) => ({ key, state, stateSince, hostOnline }) as any;
  it('hides old stopped sessions only', () => {
    const out = visibleSessions([s('a', 'stopped', 0), s('b', 'stopped', 9_000), s('c', 'working', 0)], 5_000, 10_000);
    expect(out.map((x) => x.key)).toEqual(['b', 'c']);
  });
  it('finds sessions that just started needing you', () => {
    const list = [s('a', 'needs-you'), s('b', 'needs-you'), s('c', 'working'), s('d', 'needs-you', 0, false)];
    expect(newlyNeedsYou(new Set(['a']), list).map((x) => x.key)).toEqual(['b']);
    expect([...needsYouKeys(list)]).toEqual(['a', 'b', 'd']);
  });
});

describe('fuzzy', () => {
  const repos = ['tidepool-ui', 'orchard-api', 'quill-site', 'pebble-cli', 'lantern-docs'];
  it('matches subsequences, best first, and drops non-matches', () => {
    expect(fuzzyScore('xyz', 'tidepool-ui')).toBeNull();
    expect(fuzzyFilter(repos, 'oapi', (x) => x)[0]).toBe('orchard-api');
    expect(fuzzyFilter(repos, 'ti', (x) => x)[0]).toBe('tidepool-ui');
    expect(fuzzyFilter(repos, 'zz', (x) => x)).toEqual([]);
  });
  it('keeps recency order for an empty query and caps the list', () => {
    expect(fuzzyFilter(repos, '  ', (x) => x, 2)).toEqual(['tidepool-ui', 'orchard-api']);
  });
});

describe('html and net', () => {
  it('escapes', () => expect(esc(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;'));
  it('postAction sends the required headers and survives a dead daemon', async () => {
    let seen: any;
    const ok = await postAction({ action: 'open' }, (async (u: string, init: any) => { seen = { u, init }; return new Response(JSON.stringify({ ok: true, message: 'x' }), { status: 200 }); }) as any);
    expect(ok).toEqual({ ok: true, message: 'x' });
    expect(seen.u).toBe('/api/action');
    expect(seen.init.headers).toEqual({ 'content-type': 'application/json', 'x-clayclaude': '1' });
    expect(await postAction({}, (async () => { throw new Error('down'); }) as any)).toMatchObject({ ok: false, message: expect.stringContaining('Cannot reach') });
    expect(await postAction({}, (async () => new Response('<html>', { status: 502 })) as any)).toMatchObject({ ok: false });
  });
});

import { loadClayPrefs, saveClayPrefs } from '../web/src/prefs.js';
describe('clay prefs storage', () => {
  it('reads defaults when absent, merges stored values, and writes without touching other keys', () => {
    const s = mem(JSON.stringify({ meters: 'bars', sound: true }));
    expect(loadClayPrefs(s, { mode: 'auto', shadows: true })).toEqual({ mode: 'auto', shadows: true });
    saveClayPrefs(s, { mode: 'bake', shadows: false });
    expect(JSON.parse(s.get()!)).toEqual({ meters: 'bars', sound: true, clay: { mode: 'bake', shadows: false } });
    expect(loadClayPrefs(s, { mode: 'auto', shadows: true, fpsCap: 60 })).toEqual({ mode: 'bake', shadows: false, fpsCap: 60 });
    expect(loadClayPrefs(mem('{bad'), { a: 1 })).toEqual({ a: 1 });
  });
});

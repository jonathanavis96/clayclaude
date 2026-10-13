import { describe, it, expect } from 'vitest';
import { BUILD, buildLabel, staleAgainst, reloadFor, type Stamp } from '../web/src/build.js';
import { settingsHtml } from '../web/src/settings-view.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';
import type { ClayPrefs } from '../web/src/clay/index.js';

// Spec §5.1 (UI round 4) and Task 32: the page knows its own build, compares it with what the daemon now serves, and
// an always-on tab that is running old code (the daemon was upgraded under it) reloads itself instead of showing an
// old bug for hours.

const page: Stamp = { version: '0.1.0', commit: 'abc1234', builtAt: '2026-10-12T19:30:00.000Z' };
const mem = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) }; };

describe('build stamp in the page', () => {
  it('is baked in by the build (Vitest runs from source: dev)', () => {
    expect(BUILD.version).toBeTypeOf('string');
    expect(BUILD.commit).toBeTypeOf('string');
  });
  it('labels the build with version, commit and local build time', () => {
    expect(buildLabel(page)).toMatch(/^v0\.1\.0 · abc1234 · built \d{1,2} Oct \d{2}:\d{2}$/);
    expect(buildLabel({ version: 'dev', commit: 'dev', builtAt: null })).toBe('vdev · dev');
  });
  it('is stale when the daemon serves a different build; not when it is the same, unknown, or a dev page', () => {
    expect(staleAgainst(page, { ...page, commit: 'def5678' })).toBe(true);
    expect(staleAgainst(page, { ...page, builtAt: '2026-10-12T20:00:00.000Z' })).toBe(true);   // rebuilt, same commit
    expect(staleAgainst(page, { ...page })).toBe(false);
    expect(staleAgainst(page, null)).toBe(false);
    expect(staleAgainst(page, { version: 'unknown', commit: 'unknown', builtAt: null })).toBe(false);
    // Built outside a git checkout (a release download): no commit, but its build time still tells two builds apart.
    const zip = { version: '0.1.0', commit: 'unknown', builtAt: '2026-10-12T19:00:00.000Z' };
    expect(staleAgainst(zip, { ...zip, builtAt: '2026-10-12T20:00:00.000Z' })).toBe(true);
    expect(staleAgainst(zip, { ...zip })).toBe(false);
    expect(staleAgainst({ version: 'dev', commit: 'dev', builtAt: null }, { ...page, commit: 'def5678' })).toBe(false);
  });
  it('reloads once per served build, never in a loop, and waits while a sheet is open', () => {
    const s = mem();
    const next = { ...page, commit: 'def5678' };
    expect(reloadFor(page, next, s, false)).toBe('wait');            // the focus view or a sheet is open
    expect(reloadFor(page, next, s, true)).toBe('reload');
    expect(reloadFor(page, next, s, true)).toBe('stale');            // reloaded already and still old: say so, do not loop
    expect(reloadFor(page, page, s, true)).toBe('current');
    expect(reloadFor(page, { ...page, commit: 'fff0000' }, s, true)).toBe('reload');   // a newer build again
  });
});

describe('settings panel', () => {
  const C: ClayPrefs = { mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' };
  const base = { prefs: DEFAULT_PREFS, clay: C, config: null, clayStatus: { mode: 'live', reason: 'x', baked: 0, total: 0 },
    effective: { quickReplies: [], confirmBeforeSend: false, stoppedRetentionMs: 3_600_000 } };
  it('shows the page\'s build, and the daemon\'s when it differs', () => {
    const same = settingsHtml({ ...base, build: { page, served: page } });
    expect(same).toContain('abc1234');
    expect(same).not.toContain('Daemon serves');
    const differ = settingsHtml({ ...base, build: { page, served: { ...page, commit: 'def<5678' } } });
    expect(differ).toContain('Daemon serves');
    expect(differ).toContain('def&lt;5678');
  });
});

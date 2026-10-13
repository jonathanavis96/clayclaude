// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { openSettings } from '../web/src/settings.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';

// openSettings waits for /api/config before it shows the sheet, so a second tap on the cog in that gap opened a
// second Settings sheet on top of the first.
describe('openSettings', () => {
  it('a double tap on the cog opens one sheet', async () => {
    vi.stubGlobal('fetch', async () => { await new Promise((r) => setTimeout(r, 20)); return new Response('null', { status: 404 }); });
    const ctx = {
      getPrefs: () => DEFAULT_PREFS, setPrefs: () => {}, getClayPrefs: () => ({ mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' }) as any,
      setClayPrefs: () => {}, clay: { status: () => ({ mode: 'bake', reason: 'x', baked: 0, total: 26 }) } as any,
    };
    await Promise.all([openSettings(ctx), openSettings(ctx)]);
    expect(document.querySelectorAll('.settings-panel').length).toBe(1);
    vi.unstubAllGlobals();
  });
});

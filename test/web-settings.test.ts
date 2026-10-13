import { describe, it, expect } from 'vitest';
import { applyChange } from '../web/src/settings-model.js';
import { settingsHtml } from '../web/src/settings-view.js';
import { DEFAULT_PREFS, effective } from '../web/src/prefs.js';
import type { ClayPrefs } from '../web/src/clay/index.js';

const P = DEFAULT_PREFS;
const C: ClayPrefs = { mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' };   // Plan 2's defaults; a type-only import keeps three.js out of node

describe('applyChange', () => {
  it('changes clay prefs, validating each', () => {
    expect(applyChange(P, C, 'clay.mode', 'live').clay.mode).toBe('live');
    expect(applyChange(P, C, 'clay.mode', 'turbo').clay).toEqual(C);
    expect(applyChange(P, C, 'clay.fpsCap', '30').clay.fpsCap).toBe(30);
    expect(applyChange(P, C, 'clay.fpsCap', '144').clay.fpsCap).toBe(60);
    expect(applyChange(P, C, 'clay.shadows', false).clay.shadows).toBe(false);
    expect(applyChange(P, C, 'clay.bodyColour', '#112233').clay.bodyColour).toBe('#112233');
    expect(applyChange(P, C, 'clay.bodyColour', 'red;x').clay.bodyColour).toBe(C.bodyColour);
  });
  it('changes board prefs', () => {
    expect(applyChange(P, C, 'meters', 'bars').prefs.meters).toBe('bars');
    expect(applyChange(P, C, 'layout', 'grid').prefs.layout).toBe('grid');
    expect(applyChange({ ...P, layout: 'grid' }, C, 'layout', 'strips').prefs.layout).toBe('strips');
    expect(applyChange({ ...P, layout: 'grid' }, C, 'layout', 'tiles').prefs.layout).toBe('grid');
    expect(applyChange(P, C, 'sound', true).prefs.sound).toBe(true);
    expect(applyChange(P, C, 'confirmBeforeSend', true).prefs.confirmBeforeSend).toBe(true);
    expect(applyChange({ ...P, stoppedRetentionMs: 5 }, C, 'stoppedRetentionMs', '').prefs.stoppedRetentionMs).toBeNull();
    expect(applyChange(P, C, 'stoppedRetentionMs', '3600000').prefs.stoppedRetentionMs).toBe(3_600_000);
    expect(applyChange(P, C, 'stoppedRetentionMs', '-5').prefs.stoppedRetentionMs).toBeNull();
  });
  it('validates night dimming', () => {
    expect(applyChange(P, C, 'night.enabled', true).prefs.night.enabled).toBe(true);
    expect(applyChange(P, C, 'night.from', '21:15').prefs.night.from).toBe('21:15');
    expect(applyChange(P, C, 'night.from', '9pm').prefs.night.from).toBe('22:00');
    expect(applyChange(P, C, 'night.level', '70').prefs.night.level).toBe(0.7);
    expect(applyChange(P, C, 'night.level', '99').prefs.night.level).toBe(0.6);
  });
  it('parses quick replies, dropping blanks and overlong entries, and resets to the config default when empty', () => {
    expect(applyChange(P, C, 'quickReplies', ' ok , , go on,' + 'x'.repeat(300)).prefs.quickReplies).toEqual(['ok', 'go on']);
    expect(applyChange({ ...P, quickReplies: ['a'] }, C, 'quickReplies', ' , ').prefs.quickReplies).toBeNull();
  });
});

describe('settingsHtml', () => {
  const config = { demo: true, hosts: [{ id: 'desk', ssh: null, tmuxSession: 's', repoRoots: ['~/code'] }, { id: 'rack', ssh: 'rack<1>', tmuxSession: 's', repoRoots: [] }],
    accounts: [{ id: 'a', label: 'Studio <b>', colour: '#e8b54a', host: 'desk', configDir: '/x', usage: 'oauth', open: 'app' }], ui: { quickReplies: ['yes'], confirmBeforeSend: false }, stoppedRetentionMs: 3 * 3_600_000, lan: { enabled: false } };
  const html = settingsHtml({ prefs: P, clay: C, config, clayStatus: { mode: 'bake', reason: 'the tablet is not fast enough for live 3D', baked: 12, total: 23 }, effective: effective(P, { quickReplies: ['yes', 'no'], confirmBeforeSend: false, stoppedRetentionMs: 3 * 3_600_000 }) });
  it('has every setting from the spec', () => {
    for (const name of ['layout', 'clay.mode', 'clay.shadows', 'clay.fpsCap', 'meters', 'night.enabled', 'night.from', 'night.to', 'night.level', 'sound', 'stoppedRetentionMs', 'confirmBeforeSend', 'quickReplies', 'showBackground'])
      expect(html).toContain(`data-pref="${name}"`);
    expect(html).toContain('Now using bake: the tablet is not fast enough for live 3D (12 of 23 baked)');
  });
  it('lists accounts and hosts read-only, escaped, with the demo notice', () => {
    expect(html).toContain('Studio &lt;b&gt;');
    expect(html).toContain('rack&lt;1&gt;');
    expect(html).toContain('Demo mode: nothing here is real.');
    expect(html).not.toContain('configDir');
  });
  it('marks the current choices', () => {
    expect(html).toMatch(/<option value="rings" selected>/);
    expect(html).toMatch(/<option value="auto" selected>/);
    expect(html).toContain('Default (3 h)');
  });
  it('the Default retention names the config default, not a chosen retention (final tablet pass)', () => {
    const p = { ...P, stoppedRetentionMs: 3_600_000 };
    const h = settingsHtml({ prefs: p, clay: C, config, clayStatus: { mode: 'bake', reason: '', baked: 0, total: 0 }, effective: effective(p, { quickReplies: ['yes'], confirmBeforeSend: false, stoppedRetentionMs: 3 * 3_600_000 }) });
    expect(h).toContain('<option value="">Default (3 h)</option>');
    expect(h).toMatch(/<option value="3600000" selected>1 hour<\/option>/);
  });
});

import { describe, it, expect } from 'vitest';
import { createDemo } from '../src/demo/index.js';
import { refClay } from './helpers/clay-thresholds.js';

const clay = await import('../web/src/clay/index.js').catch((e) => { console.warn('demo-clay: could not import Plan 2 clay module:', String(e).split('\n')[0]); return null; });

describe.skipIf(!clay || typeof clay.clayStateFor !== 'function')('demo against the real clayStateFor', () => {
  const now = Date.parse('2026-10-12T12:00:00Z');
  const sessions = createDemo({ scenario: 'gallery', now: () => now }).collector.sessions();

  it('the gallery reaches every renderable state except the launcher card', () => {
    const ids = new Set<string>();
    for (const s of sessions) { const r = clay!.clayStateFor(s, now, 60); ids.add(r.id); if (r.puffed) ids.add('X2'); }
    expect([...ids].sort()).toEqual([...clay!.CLAY_STATES].filter((x) => x !== 'L1').sort());
  });
  it('agrees with the reference thresholds for every demo session', () => {
    for (const s of sessions) {
      const real = clay!.clayStateFor(s, now, 60), ref = refClay(s, now, 60);
      expect([s.name, real.id, real.puffed]).toEqual([s.name, ref.id, ref.puffed]);
    }
  });
});

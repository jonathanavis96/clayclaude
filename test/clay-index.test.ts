import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('clay public entry', () => {
  it('imports in plain node, with no DOM and without loading three.js', async () => {
    expect(typeof (globalThis as { document?: unknown }).document).toBe('undefined');
    const clay = await import('../web/src/clay/index.js');
    expect(clay.CLAY_STATES).toHaveLength(26);
    expect(typeof clay.clayStateFor).toBe('function');
    expect(typeof clay.createClayController).toBe('function');
    expect(clay.DEFAULT_CLAY_PREFS).toEqual({ mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' });
    expect(clay.RENDERER_VERSION).toMatch(/^[0-9a-f]{12}$/);
  });

  it('nothing in the web app gates animation on prefers-reduced-motion (spec §7.3)', () => {
    const dir = join(import.meta.dirname, '..', 'web', 'src');
    const files = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(join(d, e.name)) : [join(d, e.name)]);
    for (const f of files(dir)) expect(readFileSync(f, 'utf8'), f).not.toMatch(/prefers-reduced-motion|reducedMotion/);
  });
});

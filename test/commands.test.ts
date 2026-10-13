import { describe, it, expect } from 'vitest';
import { dispatch, USAGE } from '../src/commands/index.js';

describe('commands', () => {
  it('leaves serve and unknown commands to the caller', async () => {
    expect(await dispatch('serve', [])).toBe(false);
    expect(await dispatch(undefined, [])).toBe(false);
    expect(await dispatch('rm', ['-rf'])).toBe(false);
  });
  it('documents every command', () => {
    for (const c of ['serve', 'setup', 'demo']) expect(USAGE).toContain(`clayclaude ${c}`);
  });
  it('lists every demo option the demo itself accepts', async () => {
    const { DEMO_USAGE } = await import('../src/commands/demo.js');
    const opts = [...DEMO_USAGE.matchAll(/--[a-z]+/g)].map((m) => m[0]);
    expect(opts.length).toBeGreaterThan(4);
    expect(opts.filter((o) => !USAGE.includes(o))).toEqual([]);
  });
});

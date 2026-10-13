import { describe, it, expect } from 'vitest';
import { chooseMode, nextMode, validAuto } from '../web/src/clay/auto.js';

const live = (fps: number, worstMs: number) => ({ fps, worstMs, stutters: 0, frames: 60 });

describe('Auto (spec §7.3)', () => {
  it('picks live only at 55+ fps with no frame over 50 ms', () => {
    expect(chooseMode({ bakeOk: true, bakeMs: 300, live: live(55, 50) }).mode).toBe('live');
    expect(chooseMode({ bakeOk: true, bakeMs: 300, live: live(54.9, 20) }).mode).toBe('bake');
    expect(chooseMode({ bakeOk: true, bakeMs: 300, live: live(60, 51) }).mode).toBe('bake');
  });
  it('reproduces the tablet decision: live at 31.6 fps -> bake, and says why', () => {
    const r = chooseMode({ bakeOk: true, bakeMs: 307, live: live(31.6, 50) });
    expect(r).toEqual({ mode: 'bake', reason: 'live ran at 31.6 fps, worst frame 50 ms; a test bake took 307 ms' });
  });
  it('falls back to baked by PC only when baking fails', () => {
    expect(chooseMode({ bakeOk: false, bakeMs: 0, live: live(20, 90) }).mode).toBe('pc');
    expect(chooseMode({ bakeOk: false, bakeMs: 0, live: null }).reason).toContain('live 3D would not start');
  });
  it('a failed mode falls to the next one not tried yet (spec §12)', () => {
    expect(nextMode(new Set(['bake']), 'bake')).toBe('pc');
    expect(nextMode(new Set(['bake', 'pc']), 'pc')).toBe('live');
    expect(nextMode(new Set(['live']), 'live')).toBe('bake');
    expect(nextMode(new Set(['bake', 'pc', 'live']), 'live')).toBeNull();
  });
  it('a stored choice is reused only for the same renderer version', () => {
    const r = { version: 'v1', mode: 'bake', reason: 'x', at: 1 };
    expect(validAuto(r, 'v1')).toBe(true);
    expect(validAuto(r, 'v2')).toBe(false);
    expect(validAuto({ ...r, mode: 'warp' }, 'v1')).toBe(false);
    expect(validAuto(null, 'v1')).toBe(false);
  });
});

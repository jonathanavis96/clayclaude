import { describe, it, expect } from 'vitest';
import { SCRIPTS } from '../web/src/clay/scripts.js';
import { FrameGate, frameCount, frameTime, resolvePlayback } from '../web/src/clay/timeline.js';

describe('timeline', () => {
  it('frame counts follow loop length and fps', () => {
    expect(frameCount('W2')).toBe(48);   // 2000 ms at 24 fps
    expect(frameCount('S2')).toBe(36);   // 3000 ms at 12 fps
    expect(frameCount('X1')).toBe(1);
  });

  it('loops never repeat frame 0 at the end', () => {
    expect(frameTime('W2', 47)).toBeCloseTo(47 / 48);
    const n = frameCount('W1');
    expect(frameTime('W1', n - 1)).toBeCloseTo((n - 1) / n);
    // each baked frame is the pose at the start of the slot resolvePlayback shows it in
    for (let i = 0; i < n; i++) expect(resolvePlayback('W1', frameTime('W1', i) * SCRIPTS.W1.loopMs + 1).frame).toBe(i);
  });

  it('W1 and S1 loop like every other state (round 3: no "plays once" states, no hand-over)', () => {
    for (const id of ['W1', 'S1'] as const) {
      const ms = SCRIPTS[id].loopMs, n = frameCount(id);
      expect(resolvePlayback(id, 0)).toEqual({ frame: 0, t: 0 });
      expect(resolvePlayback(id, ms - 1).frame).toBe(n - 1);
      expect(resolvePlayback(id, ms)).toEqual({ frame: 0, t: 0 });                  // the seam: straight back to frame 0
      expect(resolvePlayback(id, ms * 7 + ms / 2).frame).toBe(Math.floor(n / 2));
    }
    for (const s of Object.values(SCRIPTS)) expect(s).not.toHaveProperty('once');
  });

  it('loops wrap and stay in range', () => {
    const r = resolvePlayback('N5', SCRIPTS.N5.loopMs * 7 + SCRIPTS.N5.loopMs / 2);
    expect(r.frame).toBe(frameCount('N5') / 2);
    expect(resolvePlayback('X1', 99_999)).toMatchObject({ frame: 0 });
  });

  it('the frame gate lets 30 fps through every second 60 Hz tick', () => {
    const g = new FrameGate(30);
    const passed = Array.from({ length: 12 }, (_, i) => g.pass(i * 16.67)).filter(Boolean).length;
    expect(passed).toBe(6);
    g.setCap(60);
    expect([0, 16.67, 33.3].map((t) => g.pass(1000 + t))).toEqual([true, true, true]);
  });
});

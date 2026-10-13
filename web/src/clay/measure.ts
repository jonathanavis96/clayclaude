export interface FrameStats { fps: number; worstMs: number; stutters: number; frames: number }

/** Summarise frame-to-frame gaps (ms). A stutter is a gap over 50 ms. Pure. */
export function summariseFrames(gaps: number[], totalMs: number): FrameStats {
  const worst = gaps.reduce((m, g) => Math.max(m, g), 0);
  return {
    fps: totalMs > 0 ? Math.round((gaps.length / totalMs) * 10000) / 10 : 0,
    worstMs: Math.round(worst),
    stutters: gaps.filter((g) => g > 50).length,
    frames: gaps.length,
  };
}

/** Run `work` once per animation frame for `ms` and report the frame rate. The first tick only anchors the clock. */
export function measureFrames(ms: number, work: (now: number) => void): Promise<FrameStats> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let start = 0;
    let last = 0;
    const step = (now: number) => {
      if (!start) { start = last = now; requestAnimationFrame(step); return; }
      gaps.push(now - last);
      last = now;
      work(now);
      if (now - start < ms) requestAnimationFrame(step); else resolve(summariseFrames(gaps, now - start));
    };
    requestAnimationFrame(step);
  });
}

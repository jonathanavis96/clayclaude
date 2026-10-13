import { describe, it, expect, vi, afterEach } from 'vitest';
import { bakeSheet } from '../web/src/clay/bake.js';
import type { SheetKey } from '../web/src/clay/sheet.js';
import type { Stage } from '../web/src/clay/stage.js';
import { CLAY_STATES } from '../web/src/clay/states.js';
import { frameCount } from '../web/src/clay/timeline.js';

/** A 2d sheet canvas that records the stage size at every frame copy and reports pixels present. */
class FakeSheet {
  draws: number[] = [];
  constructor(public width: number, public height: number) {}
  getContext() {
    return {
      drawImage: (src: { size: number }) => { this.draws.push(src.size); },
      getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
    };
  }
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('bakeSheet', () => {
  // the main-thread baker shares the live renderer's Stage, and a live tick can run during any yield
  for (const opts of [{ yieldEvery: 1 }, { paceMs: 1 }]) {
    it(`renders every frame at key.size even when a live sprite resizes the shared stage between frames (${JSON.stringify(opts)})`, async () => {
      const sheets: FakeSheet[] = [];
      vi.stubGlobal('OffscreenCanvas', class { constructor(w: number, h: number) { const s = new FakeSheet(w, h); sheets.push(s); return s; } });
      const state = CLAY_STATES.find((s) => frameCount(s) >= 4)!;
      const key: SheetKey = { state, puffed: false, size: 96, shadows: true, colour: '#e07a4f', version: 'v' };
      const canvas = { size: 0 };
      const rendered: number[] = [];
      const stage = {
        canvas,
        setSize(px: number) { canvas.size = px; },
        render() {
          rendered.push(canvas.size);
          setTimeout(() => stage.setSize(320)); // the live mountLarge sprite ticks before the bake resumes
        },
        lost: () => false,
      };
      await bakeSheet(stage as unknown as Stage, key, opts);
      expect(rendered).toHaveLength(frameCount(state));
      expect(rendered.every((px) => px === key.size)).toBe(true);
      expect(sheets[0].draws.every((px) => px === key.size)).toBe(true);
    });
  }
});

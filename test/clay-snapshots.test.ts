import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, ROOT, launch, startWeb } from './helpers/browser.js';
import { CLAY_STATES } from '../web/src/clay/states.js';
import { frameCount, frameTime } from '../web/src/clay/timeline.js';

/**
 * Spec §13: a snapshot of each of the 26 states at frame 0 and frame N/2, rendered by the real
 * renderer in headless Chromium (SwiftShader WebGL, so no GPU is needed and output is repeatable).
 * Update after an intended change:  CLAY_SNAPSHOTS=update tools/sem.sh npx vitest run test/clay-snapshots.test.ts
 */
const DIR = join(ROOT, 'test', 'snapshots', 'clay');
const SIZE = 96;
const UPDATE = process.env.CLAY_SNAPSHOTS === 'update';
/** A pixel differs when its colour distance is over pixelmatch's 0.1; a frame fails over 0.5% of pixels. */
const MAX_DIFF = Math.ceil(SIZE * SIZE * 0.005);

/**
 * Pixels on the frame's outer rows and columns that are not transparent or floor shadow. Spec §7.4 (Task 4
 * Step 7): every prop is fully inside the square, and nothing on the character is ever cropped. The floor
 * shadow (pure black at the ShadowMaterial's 0.28 opacity, 71/255 at most) may run off the edge.
 */
const edgeLeaks = (png: PNG): string[] => {
  const out: string[] = [];
  const at = (x: number, y: number) => {
    const k = (y * SIZE + x) * 4, [r, g, b, a] = png.data.subarray(k, k + 4);
    if (a > 0 && !(r === 0 && g === 0 && b === 0 && a <= 72)) out.push(`(${x},${y}) rgba ${r},${g},${b},${a}`);
  };
  for (let i = 0; i < SIZE; i++) { at(i, 0); at(i, SIZE - 1); at(0, i); at(SIZE - 1, i); }
  return out;
};

const cases = CLAY_STATES.flatMap((id) => [...new Set([0, Math.floor(frameCount(id) / 2)])].map((frame) => ({ id, frame })));

describe.skipIf(!CHROMIUM)('clay snapshots (26 states, frames 0 and N/2)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    web = await startWeb();
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${web.url}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
    if (UPDATE) mkdirSync(DIR, { recursive: true });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  const render = async (id: string, frame: number) => {
    const b64 = await page.evaluate(([state, t, size]) => (window as any).__clay.frame({ state, t, puffed: false, colour: '#e07a4f', shadows: true }, size),
      [id, frameTime(id as never, frame), SIZE] as const);
    return Buffer.from(b64 as string, 'base64');
  };

  it('has two cases per animated state and one for the still X1 (51 images)', () => {
    expect(cases).toHaveLength(51);
  });

  it('renders the same frame identically twice', async () => {
    const a = PNG.sync.read(await render('W3', 5)), b = PNG.sync.read(await render('W3', 5));
    expect(pixelmatch(a.data, b.data, null, SIZE, SIZE, { threshold: 0.1 })).toBe(0);
  });

  // Task 4 Step 7: mid-loop really differs from the start (arms, props or Zzz have moved), so each animated
  // state is tested at two poses. More than MAX_DIFF pixels, so the snapshot comparison could tell them apart.
  for (const id of CLAY_STATES.filter((s) => frameCount(s) > 1)) {
    it(`${id} frame N/2 differs from frame 0`, async () => {
      const a = PNG.sync.read(await render(id, 0)), b = PNG.sync.read(await render(id, Math.floor(frameCount(id) / 2)));
      expect(pixelmatch(a.data, b.data, null, SIZE, SIZE, { threshold: 0.1 }), id).toBeGreaterThan(MAX_DIFF);
    });
  }

  it('no baked frame of any state is cropped at the frame edge (every frame, not only the snapshots)', async () => {
    const bad: string[] = [];
    for (const id of CLAY_STATES) for (let i = 0; i < frameCount(id); i++) {
      const leaks = edgeLeaks(PNG.sync.read(await render(id, i)));
      if (leaks.length) bad.push(`${id} frame ${i}: ${leaks.length} edge pixels, first ${leaks[0]}`);
    }
    expect(bad).toEqual([]);
  }, 120_000);

  for (const { id, frame } of cases) {
    it(`${id} frame ${frame}`, async () => {
      const png = await render(id, frame);
      const file = join(DIR, `${id}-f${frame}.png`);
      if (UPDATE) { writeFileSync(file, png); return; }
      expect(existsSync(file), `${file} missing: run with CLAY_SNAPSHOTS=update`).toBe(true);
      const got = PNG.sync.read(png), want = PNG.sync.read(readFileSync(file));
      expect([got.width, got.height]).toEqual([want.width, want.height]);
      const diff = new PNG({ width: SIZE, height: SIZE });
      const n = pixelmatch(got.data, want.data, diff.data, SIZE, SIZE, { threshold: 0.1 });
      if (n > MAX_DIFF) {
        writeFileSync(join(DIR, `${id}-f${frame}.actual.png`), png);
        writeFileSync(join(DIR, `${id}-f${frame}.diff.png`), PNG.sync.write(diff));
      }
      expect(n, `${id} frame ${frame}: ${n} pixels differ (limit ${MAX_DIFF}); see ${id}-f${frame}.diff.png`).toBeLessThanOrEqual(MAX_DIFF);
    });
  }
});

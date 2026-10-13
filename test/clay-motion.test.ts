import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, launch, startWeb } from './helpers/browser.js';
import { MOTION_ORDERS, MOTION_STEP } from './helpers/clay-limits.js';
import { jumpCheck, luma, motionPerSecond, renderLoop } from './helpers/clay-pixels.js';
import { SCRIPTS } from '../web/src/clay/scripts.js';
import type { ClayStateId } from '../web/src/clay/states.js';

/**
 * Motion escalates (spec §7.4.8, round 3): N4 rings its bell gently, N5 jumps and bobs ringing it, N6 the same, bigger and
 * faster; W2 to W7 work ever harder. Each state's motion is measured on one loop at board size with the real renderer:
 * the mean frame-to-frame pixel difference, per second of animation. Each step must be at least MOTION_STEP times the one
 * before. tools/clay-measure.ts --md=<file> writes the table.
 */
describe.skipIf(!CHROMIUM)('clay motion escalates: N4 < N5 < N6 and W2 < W3 < ... < W7 (round 3)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let page: Page;
  const motion = new Map<ClayStateId, number>();
  beforeAll(async () => {
    web = await startWeb();
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${web.url}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
    for (const id of MOTION_ORDERS.flat()) {
      motion.set(id, motionPerSecond(jumpCheck((await renderLoop(page, id, 96)).map(luma), 1).mean, SCRIPTS[id].fps));
    }
  }, 180_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  for (const line of MOTION_ORDERS) {
    it(`${line.join(' < ')}, each at least ${MOTION_STEP}x the one before`, () => {
      const v = line.map((id) => motion.get(id)!);
      console.log(line.map((id, i) => `${id} ${(v[i] * 1000).toFixed(2)}${i ? ` (${(v[i] / v[i - 1]).toFixed(2)}x)` : ''}`).join('  '));
      for (let i = 1; i < line.length; i++) expect(v[i] / v[i - 1], `${line[i]} / ${line[i - 1]}`).toBeGreaterThanOrEqual(MOTION_STEP);
    });
  }
});

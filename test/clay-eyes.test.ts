import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, launch, startWeb } from './helpers/browser.js';
import { catchlightCheck, lidFrames, renderFrame } from './helpers/clay-pixels.js';
import { CLAY_STATES, type ClayStateId } from '../web/src/clay/states.js';
import { frameCount, frameTime } from '../web/src/clay/timeline.js';

/**
 * Eye catch-lights (spec §7.4.8, round 3, the third review request about the eyes): the white catch-light is part of
 * the eyeball, so the lid hides it; it never sits on or above the lid line. Every state is rendered at its half-closed
 * and fully closed lid frames (lidFrames: found from the pose data; a state that never half-closes at its most closed
 * frame) twice: once with the catch-lights painted flat magenta, once with them hidden and the visible eyeball painted
 * flat blue. Every catch-light pixel must lie on the visible eyeball, at or below the lid edge (the top of the visible
 * eyeball) of its column. 3x the board size (288 px), so a pixel is a third of a board pixel.
 * Gate 2 (round 3): under a half-lid (W3-W7's narrowed eyes, N3's flat lids) the catch-light must not merely be cut by
 * the lid, which left it as a white chip on the lid line: it sits inside the visible slit with a gap of at least
 * LID_GAP pixels (a board pixel) of eyeball above it in every column.
 * Evidence crops: tools/clay-shots.ts --eyes writes them.
 */
const SIZE = 288;
const LID_GAP = 3;

describe.skipIf(!CHROMIUM)('clay eye catch-lights are clipped by the lid (round 3)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let page: Page;
  beforeAll(async () => {
    web = await startWeb();
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${web.url}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
  }, 90_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  const check = async (id: ClayStateId, frame: number, legacyHighlight = false, forceGlint = false) => {
    const t = frameTime(id, frame);
    const hi = await renderFrame(page, id, t, SIZE, { pass: 'highlight', legacyHighlight, forceGlint });
    const eyes = await renderFrame(page, id, t, SIZE, { pass: 'eyes', legacyHighlight });
    return catchlightCheck(hi, eyes);
  };

  it('finds lid frames from the pose data: half-lids in W3-W7 and N3, half-shut beads in W1 and S1-S2, shut eyes in S3-S7', () => {
    for (const id of ['W3', 'W7', 'N3', 'W1', 'S1', 'S2'] as const) expect(lidFrames(id).half, id).toBeDefined();
    for (const id of ['S3', 'S4', 'S5', 'S6', 'X4', 'N1'] as const) expect(lidFrames(id).full, id).toBeDefined();
  });

  it('regression fixture: round 2\'s catch-light (a sphere proud of the bead) sits on the half-lids of N3 and W3, and the check fails on it', async () => {
    for (const id of ['N3', 'W3'] as const) {
      const r = await check(id, lidFrames(id).half!, true);
      expect(r.above.length, `${id}: catch-light pixels above the lid edge`).toBeGreaterThan(0);
    }
  });

  it('the check sees catch-lights: open eyes show them (N1 frame 0, W2 frame 0, S1 frame 0), and so do shut eyes with the catch-light forced on', async () => {
    for (const id of ['N1', 'W2', 'S1'] as const) expect((await check(id, 0)).pixels, id).toBeGreaterThan(10);
    for (const id of ['S3', 'X4'] as const) expect((await check(id, lidFrames(id).full!, false, true)).pixels, `${id} shut, forced on`).toBeGreaterThan(0);
  });

  it('in every state, at its half-closed and fully closed lid frames, no catch-light pixel lies above the lid edge or off the eyeball', async () => {
    const bad: string[] = [];
    const seen: string[] = [];
    for (const id of CLAY_STATES) {
      const { frames: lf, half, full, lidded } = lidFrames(id);
      // under a half-lid the gap is checked through the whole loop (every third frame): the eyes look about under it
      const frames = lidded ? [...new Set([...lf, ...Array.from({ length: Math.ceil(frameCount(id) / 3) }, (_, i) => i * 3)])] : lf;
      for (const f of frames) {
        const r = await check(id, f);
        seen.push(`${id} f${f}${f === half ? ' half' : ''}${f === full ? ' full' : ''}: ${r.pixels} px, gap ${r.gap}`);
        if (lidded && (f === half ? !(r.pixels > 0 && r.gap >= LID_GAP) : r.gap < LID_GAP)) bad.push(`${id} frame ${f} (under a half-lid): ${r.pixels} catch-light pixels, ${r.gap} px below the lid edge, want a visible catch-light at least ${LID_GAP} px below it`);
        if (r.above.length) bad.push(`${id} frame ${f}: ${r.above.length} catch-light pixels above the lid edge, first ${r.above[0]}`);
        if (r.off.length) bad.push(`${id} frame ${f}: ${r.off.length} catch-light pixels off the eyeball, first ${r.off[0]}`);
        if (f === full) {
          // by design the catch-light has faded out by 0.25 open, so a shut eye shows none; and were it drawn, the
          // lid would still clip it: the same check with it forced on at full strength
          if (r.pixels) bad.push(`${id} frame ${f} (shut): ${r.pixels} catch-light pixels, none expected`);
          const forced = await check(id, f, false, true);
          seen.push(`${id} f${f} full, catch-light forced on: ${forced.pixels} px`);
          if (forced.above.length) bad.push(`${id} frame ${f} (shut, forced on): ${forced.above.length} catch-light pixels above the lid edge, first ${forced.above[0]}`);
          if (forced.off.length) bad.push(`${id} frame ${f} (shut, forced on): ${forced.off.length} catch-light pixels off the eyeball, first ${forced.off[0]}`);
        }
      }
    }
    console.log(`lid frames checked:\n  ${seen.join('\n  ')}`);
    expect(bad).toEqual([]);
  }, 240_000);
});

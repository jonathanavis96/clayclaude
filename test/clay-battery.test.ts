import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { PNG } from 'pngjs';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, launch, startWeb } from './helpers/browser.js';
import { renderLoop } from './helpers/clay-pixels.js';
import { SCRIPTS } from '../web/src/clay/scripts.js';

/**
 * X3 reads as a nearly empty battery (round 3 item 6, spec §7.2): rendered by the real renderer, in every frame of the
 * loop the orange charge band fills the character from the feet up (the legs are orange), its top edge (the fill line)
 * sits at 35-40 % of the character's height measured from the feet (gallery review note B, 2026-10-13: 15-25 %
 * sat too low to read), still well under half, so it reads as low, nothing above the line is orange, and the band's
 * brightness cycles slowly (one cycle a loop, a loop of at least 1.5 s). Rendered at 3x board size, so a pixel row is
 * a third of a board pixel.
 */
const SIZE = 288;
/** Battery orange, lit or in shade, dim or bright: red well over green, green over blue. The grey clay (r/g about 1.1) is not. */
const orange = (r: number, g: number, b: number) => r > 1.35 * g && g > 1.15 * b && r - b > 40;
/** The character itself: opaque and lighter than the board (the floor shadow is translucent black). */
const solid = (r: number, g: number, b: number, a: number) => a > 200 && 0.2126 * r + 0.7152 * g + 0.0722 * b > 60;

interface Band { top: number; bottom: number; line: number; aboveOrange: number; legRows: number; legOrange: number; brightness: number }

/** Silhouette rows, the fill line (the highest row that is mostly orange), and the band's mean brightness. */
function band(png: PNG): Band {
  const rows: Array<{ solid: number; orange: number }> = [];
  let top = SIZE, bottom = -1, sum = 0, n = 0;
  for (let y = 0; y < SIZE; y++) {
    let s = 0, o = 0;
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4, [r, g, b, a] = png.data.subarray(i, i + 4);
      if (!solid(r, g, b, a)) continue;
      s++;
      if (orange(r, g, b)) { o++; sum += 0.2126 * r + 0.7152 * g + 0.0722 * b; n++; }
    }
    rows.push({ solid: s, orange: o });
    if (s > 2) { top = Math.min(top, y); bottom = Math.max(bottom, y); }
  }
  let line = bottom;
  for (let y = bottom; y >= top; y--) if (rows[y].solid > 2 && rows[y].orange >= 0.5 * rows[y].solid) line = y;
  let aboveOrange = 0;
  // the arms hang behind the front of the body, so the same level sits up to 3 board pixels higher on them in the
  // camera's view (round 3, note B: at 35-40 % the band reaches the arms); anything higher than that is a stray orange
  for (let y = top; y < line - Math.round(0.06 * (bottom - top)); y++) aboveOrange += rows[y].orange;
  // the legs: the lowest 8 % of the character
  let legRows = 0, legOrange = 0;
  for (let y = bottom - Math.round(0.08 * (bottom - top)); y <= bottom; y++) { legRows += rows[y].solid; legOrange += rows[y].orange; }
  return { top, bottom, line, aboveOrange, legRows, legOrange, brightness: n ? sum / n : 0 };
}

describe.skipIf(!CHROMIUM)('clay X3: a nearly empty battery (round 3)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let page: Page;
  let bands: Band[] = [];
  beforeAll(async () => {
    web = await startWeb();
    browser = await launch();
    page = await browser.newPage();
    await page.goto(`${web.url}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 60_000 });
    bands = (await renderLoop(page, 'X3', SIZE)).map(band);
  }, 120_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  it('the orange band fills the legs and the bottom of the body, its fill line at 35-40 % of the height from the feet; nothing above it is orange', () => {
    const fracs = bands.map((b) => (b.bottom - b.line) / (b.bottom - b.top));
    console.log(`X3 fill line, fraction of the height from the feet: ${Math.min(...fracs).toFixed(3)}-${Math.max(...fracs).toFixed(3)}`);
    bands.forEach((b, i) => {
      const f = (b.bottom - b.line) / (b.bottom - b.top);
      expect(f, `X3 frame ${i}: fill line height`).toBeGreaterThanOrEqual(0.35);
      expect(f, `X3 frame ${i}: fill line height`).toBeLessThanOrEqual(0.4);
      expect(b.legOrange / b.legRows, `X3 frame ${i}: the legs are orange`).toBeGreaterThan(0.85);
      expect(b.aboveOrange, `X3 frame ${i}: orange pixels above the fill line`).toBe(0);
    });
  });

  it('the band dims and brightens slowly: one cycle a loop, a loop of 1.5 s or more', () => {
    const v = bands.map((b) => b.brightness);
    const hi = Math.max(...v), lo = Math.min(...v);
    console.log(`X3 band brightness ${lo.toFixed(1)}-${hi.toFixed(1)} over ${SCRIPTS.X3.loopMs} ms`);
    expect(hi / lo, 'a visible blink').toBeGreaterThan(1.15);
    // one rise and one fall a loop: the series changes direction twice round the loop, seam included
    let turns = 0;
    for (let i = 0; i < v.length; i++) {
      const d0 = v[(i + 1) % v.length] - v[i], d1 = v[(i + 2) % v.length] - v[(i + 1) % v.length];
      if (Math.abs(d0) > 0.3 && Math.abs(d1) > 0.3 && Math.sign(d0) !== Math.sign(d1)) turns++;
    }
    expect(turns, 'one slow cycle a loop').toBeLessThanOrEqual(2);
    expect(SCRIPTS.X3.loopMs).toBeGreaterThanOrEqual(1500);
  });
});

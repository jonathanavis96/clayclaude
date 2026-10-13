// 26 states: spec §7.2 v2 (W1–W7, N1–N7, S1–S7, X1–X4) plus L1, the launcher card.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Browser, Page } from 'playwright-core';
import { CHROMIUM, launch, startWeb } from './helpers/browser.js';

describe.skipIf(!CHROMIUM)('clay in a real browser (SwiftShader WebGL)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  beforeAll(async () => { web = await startWeb(); browser = await launch(); }, 60_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  async function open(query: string, viewport = { width: 961, height: 601 }): Promise<Page> {
    const page = await browser.newPage({ viewport, deviceScaleFactor: 4 / 3 });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`${web.url}/clay-lab.html?${query}`);
    await page.waitForFunction('window.__lab?.ready === true');
    return page;
  }
  const count = (p: Page, sel: string) => p.evaluate((s) => document.querySelectorAll(s).length, sel);

  it('bake mode: every state shows, and playback does no 3D work and runs one shared rAF loop', async () => {
    const p = await open('view=gallery&mode=bake');
    await p.waitForFunction('document.querySelectorAll(".char canvas.clay").length === 26', undefined, { timeout: 90_000 });
    const r0 = await p.evaluate('window.__lab.renders()');
    // For one second, count the frames the page draws next to the loop's rAF calls. A loaded machine draws
    // fewer frames, so a fixed calls-per-second floor failed under the full suite; the loop's calls per
    // frame do not change with load.
    const { loop, frames } = await p.evaluate(() => new Promise<{ loop: number; frames: number }>((resolve) => {
      const lab = (window as unknown as { __lab: { rafCalls(): number } }).__lab;
      const c0 = lab.rafCalls(), t0 = performance.now();
      let frames = 0; // this counter's own rAF calls: one per frame, subtracted below
      const tick = () => {
        frames++;
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else resolve({ loop: lab.rafCalls() - c0 - frames, frames });
      };
      requestAnimationFrame(tick);
    }));
    expect(await p.evaluate('window.__lab.renders()')).toBe(r0);
    expect(r0).toBe(0); // the page never built a Stage: bakes ran in the worker
    expect(frames).toBeGreaterThan(0);
    expect(loop).toBeGreaterThan(0);
    expect(loop).toBeGreaterThanOrEqual(frames - 2); // the loop asks on every frame
    expect(loop).toBeLessThanOrEqual(frames + 2);    // 26 characters, one loop
    const painted = await p.evaluate(() => [...document.querySelectorAll<HTMLCanvasElement>('canvas.clay')].filter((c) => {
      const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) return true;
      return false;
    }).length);
    expect(painted).toBe(26);
    // CLAY_SHOTS=<absolute dir>: save the gallery at board size for the visual review gate (spec §7.4.6)
    if (process.env.CLAY_SHOTS) {
      await p.setViewportSize({ width: 961, height: 780 }); // tall enough for all five groups; the cells keep board size
      await p.waitForTimeout(500);
      await p.screenshot({ path: `${process.env.CLAY_SHOTS}/gallery-board-size.png` });
    }
    await p.close();
  }, 120_000);

  it('a second visit plays every state from IndexedDB without baking again', async () => {
    const ctx = await browser.newContext({ viewport: { width: 961, height: 601 }, deviceScaleFactor: 4 / 3 });
    const first = await ctx.newPage();
    await first.goto(`${web.url}/clay-lab.html?view=gallery&mode=bake`);
    await first.waitForFunction('window.__lab?.clay.status().baked === 26', undefined, { timeout: 90_000 });
    expect(await first.evaluate('window.__lab.bakes()')).toBeGreaterThanOrEqual(26);
    await first.close();
    const again = await ctx.newPage();
    await again.goto(`${web.url}/clay-lab.html?view=gallery&mode=bake`);
    await again.waitForFunction('document.querySelectorAll(".char canvas.clay").length === 26', undefined, { timeout: 90_000 });
    expect(await again.evaluate('window.__lab.bakes()')).toBe(0);
    await ctx.close();
  }, 180_000);

  it('pauses the loop while the page is hidden', async () => {
    const p = await open('view=gallery&mode=bake');
    await p.waitForFunction('document.querySelectorAll(".char canvas.clay").length > 0', undefined, { timeout: 90_000 });
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    const a = await p.evaluate('window.__lab.rafCalls()');
    await p.waitForTimeout(500);
    expect(await p.evaluate('window.__lab.rafCalls()')).toBe(a);
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { value: false, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForTimeout(300);
    expect(await p.evaluate('window.__lab.rafCalls()')).toBeGreaterThan(a as number);
    await p.close();
  }, 120_000);

  it('when baking fails and no PC baker answers, states fall back to live (spec §12)', async () => {
    const p = await open('view=gallery&mode=bake&fail=worker,main');
    await p.waitForFunction('document.querySelectorAll(".char canvas.clay").length === 26', undefined, { timeout: 90_000 });
    const reason = await p.evaluate('window.__lab.clay.status().reason') as string;
    expect(reason).toMatch(/bake failed for .*using pc/);
    expect(reason).toMatch(/pc failed for .*using live/);
    expect(await p.evaluate('window.__lab.renders()')).toBeGreaterThan(0);
    await p.close();
  }, 120_000);

  for (const viewport of [{ width: 961, height: 601 }, { width: 961, height: 433 }, { width: 800, height: 500 }, { width: 800, height: 433 }]) {
    it(`board at ${viewport.width}x${viewport.height}: every character is square, inside its row, never cropped or squashed`, async () => {
      const p = await open('view=board&n=10&mode=bake', viewport);
      // characters scrolled out of view draw nothing (by design), so bring each row into view in turn
      for (let i = 0; i < 10; i++) {
        await p.evaluate((i) => document.querySelectorAll('.row')[i].scrollIntoView({ block: 'nearest' }), i);
        await p.waitForFunction((i) => !!document.querySelectorAll('.row')[i]?.querySelector('canvas.clay'), i, { timeout: 60_000 });
      }
      const boxes = await p.evaluate(() => [...document.querySelectorAll('.row')].map((row) => {
        const r = row.getBoundingClientRect();
        const c = row.querySelector('canvas.clay')!.getBoundingClientRect();
        return { needs: row.classList.contains('st-needs-you'), row: [r.left, r.top, r.right, r.bottom], c: [c.left, c.top, c.right, c.bottom], w: c.width, h: c.height };
      }));
      expect(boxes).toHaveLength(10);
      for (const b of boxes) {
        expect(Math.abs(b.w - b.h)).toBeLessThan(0.6);                   // square: not squashed
        expect(b.w).toBeGreaterThan(40);
        expect(b.c[0]).toBeGreaterThanOrEqual(b.row[0] - 0.5);           // inside its row: not cropped
        expect(b.c[1]).toBeGreaterThanOrEqual(b.row[1] - 0.5);
        expect(b.c[2]).toBeLessThanOrEqual(b.row[2] + 0.5);
        expect(b.c[3]).toBeLessThanOrEqual(b.row[3] + 0.5);
      }
      // spec §5.1 (UI round 4): needs-you rows are taller, but every row's character is the same size
      const big = boxes.find((b) => b.needs)!.h, small = boxes.find((b) => !b.needs)!.h;
      expect(Math.abs(big - small)).toBeLessThanOrEqual(1);
      // CLAY_SHOTS=<absolute dir>: also save what the board looked like, for a person to check
      if (process.env.CLAY_SHOTS) {
        await p.evaluate(() => document.querySelector('main.strips')!.scrollTo(0, 0));
        await p.waitForTimeout(500);
        await p.screenshot({ path: `${process.env.CLAY_SHOTS}/board-${viewport.width}x${viewport.height}.png` });
      }
      await p.close();
    }, 120_000);
  }

  // The grid's cards follow the same rule (spec §5.1): the character square, inside its card, never cropped or squashed.
  for (const viewport of [{ width: 961, height: 601 }, { width: 800, height: 480 }, { width: 800, height: 433 }]) {
    it(`grid at ${viewport.width}x${viewport.height}: every character is square, inside its card, never cropped or squashed`, async () => {
      const p = await open('view=board&n=10&mode=bake&layout=grid', viewport);
      await p.waitForFunction('document.querySelectorAll(".gcard").length === 10', undefined, { timeout: 30_000 });
      for (let i = 0; i < 10; i++) {
        await p.evaluate((i) => document.querySelectorAll('.gcard')[i].scrollIntoView({ block: 'nearest' }), i);
        await p.waitForFunction((i) => !!document.querySelectorAll('.gcard')[i]?.querySelector('canvas.clay'), i, { timeout: 60_000 });
      }
      const boxes = await p.evaluate(() => [...document.querySelectorAll('.gcard')].map((card) => {
        const r = card.getBoundingClientRect();
        const c = card.querySelector('canvas.clay')!.getBoundingClientRect();
        return { card: [r.left, r.top, r.right, r.bottom], c: [c.left, c.top, c.right, c.bottom], w: c.width, h: c.height };
      }));
      expect(boxes).toHaveLength(10);
      expect(await p.evaluate('document.querySelectorAll(".row").length')).toBe(0);
      expect(await p.evaluate('document.querySelectorAll("canvas.clay").length')).toBe(10);   // one character per session
      for (const b of boxes) {
        expect(Math.abs(b.w - b.h)).toBeLessThan(0.6);                   // square: not squashed
        expect(b.w).toBeGreaterThan(30);
        expect(b.c[0]).toBeGreaterThanOrEqual(b.card[0] - 0.5);          // inside its card: not cropped
        expect(b.c[1]).toBeGreaterThanOrEqual(b.card[1] - 0.5);
        expect(b.c[2]).toBeLessThanOrEqual(b.card[2] + 0.5);
        expect(b.c[3]).toBeLessThanOrEqual(b.card[3] + 0.5);
      }
      if (process.env.CLAY_SHOTS) {
        await p.evaluate(() => document.querySelector('main.grid')!.scrollTo(0, 0));
        await p.waitForTimeout(500);
        await p.screenshot({ path: `${process.env.CLAY_SHOTS}/grid-${viewport.width}x${viewport.height}.png` });
      }
      await p.close();
    }, 120_000);
  }

  it('live mode renders every frame', async () => {
    const p = await open('view=gallery&mode=live');
    await p.waitForFunction('document.querySelectorAll(".char canvas.clay").length === 26', undefined, { timeout: 90_000 });
    const r0 = await p.evaluate('window.__lab.renders()') as number;
    // every tick renders all 26 in 3D (slow in software WebGL): wait for at least one more full tick
    await p.waitForFunction((r0) => (window as any).__lab.renders() >= r0 + 26, r0, { timeout: 30_000 });
    await p.close();
  }, 120_000);
});

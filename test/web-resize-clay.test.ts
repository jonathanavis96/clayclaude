// Task 32: the stacked, blurry characters came back "when going full screen". Entering or leaving full
// screen, a rotation, or Chrome's bars hiding are all viewport resizes. This drives the real board (production build,
// real daemon server, demo data) through many of them, and a storm of resize/fullscreenchange events, with the plain
// board (strips and grid), the focus view and the launcher open, and checks every character slot after each step:
// exactly one character canvas per slot once drawn, never two, each inside its own slot, and none anywhere else.
// Root cause, reproduced on the tablet: the 7420 daemon still served 7176f5f, from before b28ad5a made the focus and
// launcher slots position: relative, so every focus-view canvas filled the whole viewport (stretched, stacked) and
// followed it in and out of full screen. On that build this test fails at "canvases outside their slot focus view".
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import type { Browser, Page } from 'playwright-core';
import { startServer } from '../src/server.js';
import { createDemo } from '../src/demo/index.js';
import { createActionRoutes } from '../src/actions/routes.js';
import { createClayRoutes } from '../src/clay/routes.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/** Every element the app mounts a character in: board rows and grid cards, the focus view's large and small cards, launcher account cards. */
const SLOTS = '.char[data-key], #f-char, .mini-char, .acct-char';
// 961x601 is the tablet in full screen, 961x480 and 800x480 with Chrome's bars; 961x400 is short enough that the auto layout
// switches to the grid, so every cycle also re-mounts the board's characters in new slots (strips <-> grid)
const SIZES = [{ width: 961, height: 601 }, { width: 961, height: 480 }, { width: 800, height: 480 }, { width: 961, height: 400 }];
const CYCLES = 12;
const N = 4;

interface Census { slots: number; canvases: number; doubled: string[]; orphans: number; outside: string[]; layout: string | null; focusViews: number }

/** Runs in the page: every clay canvas in the document against every character slot. */
function census(sel: string): Census {
  const slots = [...document.querySelectorAll<HTMLElement>(sel)];
  // every canvas in the document, not only the app's own: one anywhere outside a slot is an orphan
  const all = [...document.querySelectorAll<HTMLCanvasElement>('canvas')];
  const name = (e: HTMLElement) => e.id || `${e.className}[${e.dataset.key ?? ''}]`;
  const outside: string[] = [];
  for (const c of all) {
    const s = c.parentElement!;
    if (!s.matches(sel)) continue;
    const a = c.getBoundingClientRect(); const b = s.getBoundingClientRect();
    if (a.left < b.left - 0.5 || a.top < b.top - 0.5 || a.right > b.right + 0.5 || a.bottom > b.bottom + 0.5) outside.push(name(s));
  }
  return {
    slots: slots.length,
    canvases: all.length,
    doubled: slots.filter((s) => s.querySelectorAll('canvas').length > 1).map(name),
    orphans: all.filter((c) => !c.parentElement?.matches(sel)).length,
    outside,
    layout: document.querySelector<HTMLElement>('.list')?.dataset.layout ?? null,
    focusViews: document.querySelectorAll('.focus').length,
  };
}

describe.skipIf(!CHROMIUM)('characters through viewport resizes and full screen (real board)', () => {
  const web = mkdtempSync(join(tmpdir(), 'cc-resize-'));
  let browser: Browser;
  let close: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    await build({ configFile: join(ROOT, 'web', 'vite.config.ts'), build: { outDir: web, emptyOutDir: true }, logLevel: 'error' });
    // four sessions: strips down to 480 px high, the grid at 400 px
    const demo = createDemo({ scenario: 'board', sessions: N });
    const clayRoutes = createClayRoutes({ webRoot: web });
    const srv = await startServer({
      cfg: { ...demo.cfg, port: 0 }, collector: demo.collector as never, usage: demo.usage as never, webRoot: web, port: 0,
      handlers: [createActionRoutes(demo.api, { mode: 'demo', publicConfig: demo.publicConfig }), clayRoutes.handler],
    });
    demo.collector.start();
    url = `http://127.0.0.1:${srv.port}/`;
    close = async () => { demo.stop(); await clayRoutes.close(); await srv.close(); };
    browser = await launch();
  }, 180_000);
  afterAll(async () => { await browser?.close(); await close?.(); });

  const look = (p: Page) => p.evaluate(census, SLOTS);
  /** Never two in a slot, never one outside its slot, never one outside any slot. */
  const clean = (c: Census, at: string) => {
    expect(c.doubled, `doubled slots ${at}`).toEqual([]);
    expect(c.orphans, `orphan canvases ${at}`).toBe(0);
    expect(c.outside, `canvases outside their slot ${at}`).toEqual([]);
    expect(c.focusViews, `focus views open ${at}`).toBeLessThanOrEqual(1);
  };
  /** Settled: exactly one canvas in every slot. */
  const settled = async (p: Page, at: string) => {
    await p.waitForFunction((sel) => {
      const slots = [...document.querySelectorAll(sel)];
      return slots.length > 0 && slots.every((s) => s.querySelectorAll('canvas').length === 1)
        && document.querySelectorAll('canvas').length === slots.length;
    }, SLOTS, { timeout: 90_000, polling: 250 }).catch(() => {});
    const c = await look(p);
    clean(c, at);
    expect(c.canvases, `one canvas per slot ${at}`).toBe(c.slots);
    return c;
  };
  /** 10+ cycles through the sizes, checking after every step; then a storm of resizes and events with no waiting. */
  const shake = async (p: Page, what: string) => {
    const layouts = new Set<string>();
    for (let i = 0; i < CYCLES; i++) {
      for (const s of SIZES) {
        await p.setViewportSize(s);
        await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
        await p.waitForTimeout(60);
        const c = await look(p);
        clean(c, `${what}, cycle ${i} at ${s.width}x${s.height}`);
        if (c.layout) layouts.add(c.layout);
      }
    }
    for (let i = 0; i < 50; i++) {
      void p.setViewportSize(SIZES[i % SIZES.length]!);
      await p.evaluate(() => { window.dispatchEvent(new Event('resize')); document.dispatchEvent(new Event('fullscreenchange')); window.visualViewport?.dispatchEvent(new Event('resize')); });
    }
    await p.setViewportSize(SIZES[0]!);
    clean(await look(p), `${what}, right after the storm`);
    return layouts;
  };
  /** Full screen from a real double tap on the board's clock, and out again, several times. */
  const fullscreen = async (p: Page, what: string) => {
    for (let i = 0; i < 4; i++) {
      // the clock takes a double tap only on the board, not under an open sheet: then the page asks itself
      if (await p.isVisible('.clock') && !(await p.isVisible('.modal'))) await p.click('.clock', { clickCount: 2 });
      else await p.evaluate(() => document.documentElement.requestFullscreen().catch(() => {}));
      await p.waitForTimeout(150);
      clean(await look(p), `${what}, full screen ${i}`);
      await p.evaluate(() => document.fullscreenElement && document.exitFullscreen());
      await p.waitForTimeout(150);
      clean(await look(p), `${what}, left full screen ${i}`);
    }
  };

  it('the board, the focus view and the launcher keep one character per slot through resizes and full screen', async () => {
    const p = await browser.newPage({ viewport: SIZES[0]!, deviceScaleFactor: 1.5 });
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    try {
      await p.goto(url);
      await p.waitForSelector('.list .char[data-key]');
      await settled(p, 'board at load');

      // (b) the plain board: strips at 601 px high, the grid at 480 px, switching on every cycle
      const layouts = await shake(p, 'board');
      expect([...layouts].sort()).toEqual(['grid', 'strips']);
      await fullscreen(p, 'board');
      const board = await settled(p, 'board after the resizes');
      expect(board.slots).toBe(N);

      // (a) a session's focus view open: the large character and the small cards, over the board's own characters
      // the row's name, not its centre: a needs-you row's question bubble opens the answer sheet instead
      await p.click('.list .name');
      const opened = await p.waitForSelector('.focus #f-char, .sheet.answer').then((h) => h.evaluate((e) => (e.closest('.focus') ? 'focus view' : 'answer sheet')));
      expect(opened, 'clicking a row should open the focus view').toBe('focus view');
      await settled(p, 'focus view');
      await shake(p, 'focus view');
      await fullscreen(p, 'focus view');
      const focus = await settled(p, 'focus view after the resizes');
      expect(await p.evaluate(() => document.querySelectorAll('#f-char canvas.clay').length)).toBe(1);
      expect(await p.evaluate(() => document.querySelectorAll('.mini-char canvas.clay').length)).toBe(N - 1);
      expect(focus.slots).toBe(N + 1 + N - 1);

      // closed: its characters go, the board's stay
      await p.click('.focus [data-act="close"]');
      expect((await settled(p, 'focus view closed')).slots).toBe(N);

      // the launcher's account cards
      await p.click('[data-act="new"]');
      await p.waitForSelector('.launcher .acct-char');
      await settled(p, 'launcher');
      await shake(p, 'launcher');
      const launcher = await settled(p, 'launcher after the resizes');
      expect(launcher.slots).toBeGreaterThan(N);
      expect(errors).toEqual([]);
    } finally { await p.close(); }
  }, 600_000);
});

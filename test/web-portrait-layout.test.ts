// Task 37 (2026-10-13): in portrait and after rotating, parts of the board looked broken. On the tablet
// (Lenovo, 600x961 CSS in full screen, 602x795 in a Chrome tab; landscape 961x601 / 962x433) every surface was
// reviewed in both orientations, at rest and after a rotation. Two regions were broken:
//   1. the top bar's account rings wrapped onto a tall line of their own (64 px rings, the label and the figures
//      stacked under each), so the top bar was about twice its landscape height;
//   2. a strip row in portrait squeezed its name and its action into two narrow columns ("riv…", "e…", "Usage l…").
// This file holds the layout checks over the viewport matrix: the top bar stays compact in portrait with nothing
// overlapping; on the real board (production build, demo data) no surface overflows the viewport horizontally, the
// top bar's parts never overlap, strip rows keep readable cells, and after resizing from landscape to portrait and
// back every character slot holds exactly one canvas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import type { Browser, Page } from 'playwright-core';
import { topBarHtml, type BoardState } from '../web/src/board.js';
import { startServer } from '../src/server.js';
import { createDemo } from '../src/demo/index.js';
import { createActionRoutes } from '../src/actions/routes.js';
import { createClayRoutes } from '../src/clay/routes.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const LABELS = ['Studio', 'Personal', 'Consulting', 'Agency', 'Clients'];
const FIGS: Array<[number | null, number | null]> = [[100, 100], [7, 63], [null, 41], [88, 100], [41, 9]];
const state = (accounts: number): BoardState => ({
  sessions: ['needs-you', 'working', 'asleep', 'stopped'].flatMap((st, j) => Array.from({ length: 10 + j }, (_, i) => ({ key: `${st}${i}`, state: st }))) as any,
  usage: LABELS.slice(0, accounts).map((label, i) => ({ account: label.toLowerCase(), label, colour: '#e8b54a', fiveHour: FIGS[i]![0], weekly: FIGS[i]![1],
    fiveHourResetsAt: null, weeklyResetsAt: null, stale: i === 3, updatedAt: null })) as any,
  accounts: [], cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0,
});

/** Portrait sizes and the same device in landscape: this tablet in full screen and in a Chrome tab, and an 800x1280 one. */
const PAIRS: Array<[[number, number], [number, number]]> = [[[600, 961], [961, 601]], [[602, 795], [961, 601]], [[800, 1280], [1280, 800]]];

describe.skipIf(!CHROMIUM)('top bar in portrait', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser?.close(); });

  const bar = async (w: number, h: number, n: number, mode: 'rings' | 'bars') => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<style>${css}</style><div id="app"><header class="top">${topBarHtml(state(n), { meters: mode }, new Date(2026, 8, 30, 23, 59))}</header><main class="strips"></main></div>`);
    return page.evaluate(() => {
      const box = (e: Element) => { const r = e.getBoundingClientRect(); return { name: (e as HTMLElement).className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
      const top = document.querySelector('header.top')!;
      return { height: top.getBoundingClientRect().height, parts: [...top.children].map(box), meters: [...document.querySelectorAll('.meter')].map(box), vw: innerWidth };
    });
  };

  // Review note: the rings wrapped onto a line of their own and took too much vertical space. In portrait the
  // meters stay compact: one short line, the top bar at most 1.3 times its landscape height, nothing overlapping.
  it.each(PAIRS.flatMap(([p, l]) => (['rings', 'bars'] as const).flatMap((mode) => [1, 2, 3, 4, 5].map((n) => [p[0], p[1], mode, n, l] as const))))(
    'at %ix%i with %s and %i accounts the top bar stays compact and nothing overlaps', async (w, h, mode, n, l) => {
      const land = await bar(l[0], l[1], n, mode);
      const port = await bar(w, h, n, mode);
      expect(port.height, `portrait ${port.height}px vs landscape ${land.height}px`).toBeLessThanOrEqual(1.3 * land.height + 0.5);
      const hit = (a: typeof port.parts[0], b: typeof port.parts[0]) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      for (let i = 0; i < port.parts.length; i++) for (let j = i + 1; j < port.parts.length; j++) {
        expect(hit(port.parts[i]!, port.parts[j]!), `${port.parts[i]!.name} overlaps ${port.parts[j]!.name}`).toBe(false);
      }
      const counts = port.parts.find((p) => p.name === 'counts')!;
      for (const m of port.meters) {
        expect(hit(m, counts), 'a meter overlaps the counts').toBe(false);
        expect(m.right, 'a meter past the right edge').toBeLessThanOrEqual(port.vw + 0.5);
        expect(m.left).toBeGreaterThanOrEqual(-0.5);
      }
      // one short line of meters, never a stack
      expect(new Set(port.meters.map((m) => Math.round(m.top))).size, 'meters on more than one line').toBe(1);
    });
});

/** Every element the app mounts a character in (as test/web-resize-clay.test.ts). */
const SLOTS = '.char[data-key], #f-char, .mini-char, .acct-char';
const SIZES = { portrait: { width: 600, height: 961 }, chromePortrait: { width: 602, height: 795 }, large: { width: 800, height: 1280 },
  landscape: { width: 961, height: 601 }, chromeLandscape: { width: 962, height: 433 }, largeLandscape: { width: 1280, height: 800 } };
const SURFACES: Record<string, { layout: 'strips' | 'grid' | 'auto'; open?: string; ready?: string }> = {
  strips: { layout: 'strips' },
  grid: { layout: 'grid' },
  focus: { layout: 'auto', open: '.list .st-working .name', ready: '.focus #f-char' },
  launcher: { layout: 'auto', open: '[data-act="new"]', ready: '.launcher .acct-char' },
  answer: { layout: 'auto', open: '.qbubble', ready: '.sheet-head' },
  settings: { layout: 'auto', open: '.cog', ready: '.settings-panel' },
  account: { layout: 'auto', open: '.meter', ready: '.account-panel' },
};

interface Review { overflow: string[]; topOverlap: string[]; squeezed: string[]; doubled: string[]; orphans: number; outside: string[]; missing: string[] }

/** Runs in the page: a layout review of what is on screen. */
function review(sel: string): Review {
  const vw = innerWidth; const vh = innerHeight;
  const name = (e: Element) => (e.id ? `#${e.id}` : `${e.tagName.toLowerCase()}.${String((e as HTMLElement).className).trim().split(/\s+/).join('.')}`);
  /** The part of `e` that is visible: its box clipped by every ancestor that clips (scrolling lists, panels). */
  const visible = (e: Element) => {
    const r = e.getBoundingClientRect(); let { left, right, top, bottom } = r;
    for (let a = e.parentElement; a && a !== document.documentElement; a = a.parentElement) {
      const s = getComputedStyle(a); const q = a.getBoundingClientRect();
      if (s.overflowX !== 'visible') { left = Math.max(left, q.left); right = Math.min(right, q.right); }
      if (s.overflowY !== 'visible') { top = Math.max(top, q.top); bottom = Math.min(bottom, q.bottom); }
    }
    return { left, right, top, bottom, shown: right > left && bottom > top && r.width > 0 && r.height > 0 };
  };
  const overflow: string[] = [];
  for (const e of document.querySelectorAll('body *')) {
    if (getComputedStyle(e).visibility === 'hidden') continue;
    const v = visible(e);
    if (v.shown && (v.right > vw + 0.5 || v.left < -0.5)) overflow.push(`${name(e)} ${Math.round(v.left)}..${Math.round(v.right)} of ${vw}`);
  }
  const parts = [...document.querySelectorAll('header.top > *')].map((e) => ({ n: name(e), r: e.getBoundingClientRect() }));
  const topOverlap: string[] = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
    const a = parts[i]!.r; const b = parts[j]!.r;
    if (a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5) topOverlap.push(`${parts[i]!.n} x ${parts[j]!.n}`);
  }
  // A strip row's name and its action (the question or the current tool) need room to be read: at least 7.5 and 14
  // characters of their own font. On build, in portrait, they had 2 or 3 ("riv…", "Usage l…").
  const squeezed: string[] = [];
  for (const row of document.querySelectorAll<HTMLElement>('.list .row')) {
    for (const [cell, chars] of [['.name', 7.5], ['.action', 14]] as const) {
      const el = row.querySelector<HTMLElement>(cell); if (!el?.textContent?.trim()) continue;
      const em = parseFloat(getComputedStyle(el).fontSize);
      if (el.getBoundingClientRect().width < chars * em * 0.6) squeezed.push(`${row.dataset.key} ${cell} ${Math.round(el.getBoundingClientRect().width)}px`);
    }
  }
  const slots = [...document.querySelectorAll<HTMLElement>(sel)];
  const all = [...document.querySelectorAll('canvas')];
  const outside: string[] = [];
  for (const c of all) {
    const s = c.parentElement!; if (!s.matches(sel)) continue;
    const a = c.getBoundingClientRect(); const b = s.getBoundingClientRect();
    if (a.left < b.left - 0.5 || a.top < b.top - 0.5 || a.right > b.right + 0.5 || a.bottom > b.bottom + 0.5) outside.push(name(s));
  }
  // slots scrolled out of their list may draw nothing (only visible characters draw); every slot on screen draws one
  const onScreen = (s: Element) => { const v = visible(s); return v.shown && v.right > 0 && v.left < vw && v.bottom > 0 && v.top < vh; };
  const under = document.querySelector('#overlays > .modal');
  return {
    overflow, topOverlap, squeezed, outside,
    doubled: slots.filter((s) => s.querySelectorAll('canvas').length > 1).map(name),
    orphans: all.filter((c) => !c.parentElement?.matches(sel)).length,
    // a full-screen panel covers the board: only the characters of the top overlay (or the board with none) must show
    missing: slots.filter((s) => (!under || under.contains(s)) && onScreen(s) && s.querySelectorAll('canvas').length !== 1).map((s) => `${name(s)}[${s.dataset.key ?? ''}]`),
  };
}

describe.skipIf(!CHROMIUM)('every surface in portrait and landscape, at rest and after rotating (real board)', () => {
  const web = mkdtempSync(join(tmpdir(), 'cc-portrait-'));
  let browser: Browser;
  let page: Page;
  let close: () => Promise<void>;
  let url: string;

  beforeAll(async () => {
    await build({ configFile: join(ROOT, 'web', 'vite.config.ts'), build: { outDir: web, emptyOutDir: true }, logLevel: 'error' });
    const demo = createDemo({ scenario: 'board', sessions: 10 });
    const clayRoutes = createClayRoutes({ webRoot: web });
    const srv = await startServer({
      cfg: { ...demo.cfg, port: 0 }, collector: demo.collector as never, usage: demo.usage as never, webRoot: web, port: 0,
      handlers: [createActionRoutes(demo.api, { mode: 'demo', publicConfig: demo.publicConfig }), clayRoutes.handler],
    });
    demo.collector.start();
    url = `http://127.0.0.1:${srv.port}/`;
    close = async () => { demo.stop(); await clayRoutes.close(); await srv.close(); };
    browser = await launch();
    page = await browser.newPage({ viewport: SIZES.landscape, deviceScaleFactor: 1.33 });
    await page.addInitScript(`window.review = ${review.toString()}`);
  }, 180_000);
  afterAll(async () => { await browser?.close(); await close?.(); });

  const frames = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const check = async (at: string, layout: string) => {
    await frames();
    // characters draw a moment after a resize: wait for every on-screen slot to hold one (or let the review report it)
    await page.waitForFunction((sel) => (window as unknown as { review(s: string): Review }).review(sel).missing.length === 0, SLOTS, { timeout: 30_000, polling: 250 }).catch(() => {});
    const r = await page.evaluate(review, SLOTS);
    expect(r.overflow, `elements past the viewport's sides ${at}`).toEqual([]);
    expect(r.topOverlap, `top bar parts overlapping ${at}`).toEqual([]);
    if (layout === 'strips') expect(r.squeezed, `squeezed strip cells ${at}`).toEqual([]);
    expect(r.doubled, `slots with two canvases ${at}`).toEqual([]);
    expect(r.orphans, `canvases outside any slot ${at}`).toBe(0);
    expect(r.outside, `canvases outside their slot ${at}`).toEqual([]);
    expect(r.missing, `on-screen slots without exactly one canvas ${at}`).toEqual([]);
  };

  const matrix = [['portrait', 'landscape'], ['chromePortrait', 'chromeLandscape'], ['large', 'largeLandscape']] as const;
  it.each(Object.keys(SURFACES))('%s: portrait and landscape, at rest and after landscape → portrait → landscape', async (surface) => {
    const s = SURFACES[surface]!;
    const errors: string[] = [];
    const onError = (e: Error) => errors.push(e.message);
    page.on('pageerror', onError);
    try {
      for (const [p, l] of matrix) {
        for (const start of [l, p] as const) {
          // at rest: loaded in this orientation
          await page.setViewportSize(SIZES[start]);
          await page.goto(url);
          await page.evaluate((layout) => localStorage.setItem('clayclaude.prefs', JSON.stringify({ layout })), s.layout);
          await page.reload();
          await page.waitForSelector('.list [data-key]');
          if (s.layout !== 'auto') await page.waitForSelector(`.list[data-layout="${s.layout}"]`);
          if (s.open) { await page.click(s.open); await page.waitForSelector(s.ready!); }
          await check(`(${surface} at rest, ${start})`, s.layout);
          // rotate: to the other orientation and back, checking after each
          const other = start === l ? p : l;
          await page.setViewportSize(SIZES[other]);
          await check(`(${surface} after rotating ${start} → ${other})`, s.layout);
          await page.setViewportSize(SIZES[start]);
          await check(`(${surface} after rotating back to ${start})`, s.layout);
        }
      }
      expect(errors).toEqual([]);
    } finally { page.off('pageerror', onError); }
  }, 600_000);
});

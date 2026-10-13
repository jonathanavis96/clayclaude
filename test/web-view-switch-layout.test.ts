// Task 38 (Jonathan, 2026-10-13): "Move the settings cog a bit up and then add a button that swaps views". In a real
// browser over the tablet's sizes: the switch sits directly under the raised cog, takes a 48x48 CSS px tap on all of its
// box, overlaps nothing (the + New button, the counts, the meters, the board below), and the top bar is exactly as
// tall as it is without the cog and the switch, in landscape and in portrait (so Task 37's portrait bound still holds).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { topBarHtml, type BoardState } from '../web/src/board.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const LABELS = ['Studio', 'Personal', 'Garden', 'Agency', 'Clients'];
const FIGS: Array<[number | null, number | null]> = [[100, 100], [7, 63], [null, 41], [88, 100], [41, 9]];
const state = (accounts: number): BoardState => ({
  sessions: ['needs-you', 'working', 'asleep', 'stopped'].flatMap((st, j) => Array.from({ length: 10 + j }, (_, i) => ({ key: `${st}${i}`, state: st }))) as any,
  usage: LABELS.slice(0, accounts).map((label, i) => ({ account: label.toLowerCase(), label, colour: '#e8b54a', fiveHour: FIGS[i]![0], weekly: FIGS[i]![1],
    fiveHourResetsAt: null, weeklyResetsAt: null, stale: i === 3, updatedAt: null })) as any,
  accounts: [], cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0,
});

/** The sizes the task names, plus the tablet in a Chrome tab (962x433 landscape, 602x795 portrait), plus 800x601,
 *  where five accounts wrap the bar and + New and the cog's column sit alone on the short second line. */
const SIZES: Array<[number, number]> = [[961, 601], [961, 480], [800, 480], [800, 601], [600, 961], [962, 433], [602, 795]];

describe.skipIf(!CHROMIUM)('the view switch in the top bar', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser?.close(); });

  const cases = SIZES.flatMap(([w, h]) => (['rings', 'bars'] as const).flatMap((mode) => [0, 1, 3, 5].map((n) => [w, h, mode, n] as const)));
  it.each(cases)('at %ix%i with %s and %i accounts: 48x48, under the raised cog, nothing overlaps, the bar is no taller', async (w, h, mode, n) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(`<style>${css}</style><div id="app"><header class="top">${topBarHtml(n ? state(n) : null, { meters: mode, layout: 'strips' }, new Date(2026, 8, 30, 23, 59))}</header><main class="list strips"></main></div>`);
    const m = await page.evaluate(() => {
      const box = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
      const top = document.querySelector<HTMLElement>('header.top')!;
      const view = document.querySelector<HTMLElement>('button.view');
      // every point of the switch's box (on a 4 px grid, 2 px in from its edges) is a tap on the switch
      const misses: string[] = [];
      if (view) {
        const r = view.getBoundingClientRect();
        for (let x = r.left + 2; x <= r.right - 2; x += 4) for (let y = r.top + 2; y <= r.bottom - 2; y += 4) {
          const at = document.elementFromPoint(x, y);
          if (!at || !view.contains(at)) misses.push(`${Math.round(x)},${Math.round(y)}: ${at ? at.tagName + '.' + (at as HTMLElement).className : 'nothing'}`);
        }
      }
      // the cog's glyph (24 px) is a tap on the cog: its centre and 8 px above, below and to either side of it
      const cogEl = document.querySelector<HTMLElement>('button.cog');
      const cogMisses: string[] = [];
      if (cogEl) {
        const rg = document.createRange(); rg.selectNodeContents(cogEl); const g = rg.getBoundingClientRect();
        const cx = (g.left + g.right) / 2, cy = (g.top + g.bottom) / 2;
        for (const [x, y] of [[cx, cy], [cx, cy - 8], [cx, cy + 8], [cx - 8, cy], [cx + 8, cy]] as const) {
          const at = document.elementFromPoint(x, y);
          if (!at || !cogEl.contains(at)) cogMisses.push(`${Math.round(x)},${Math.round(y)}: ${at ? at.tagName + '.' + (at as HTMLElement).className : 'nothing'}`);
        }
      }
      const height = top.getBoundingClientRect().height;
      const res = {
        view: box(view), cog: box(document.querySelector('button.cog')), side: box(view?.parentElement ?? null),
        isNew: box(document.querySelector('button.new')), counts: box(document.querySelector('.counts')),
        meters: [...document.querySelectorAll('.meter')].map(box), main: box(document.querySelector('main')),
        clock: box(document.querySelector('.clock')), misses, cogMisses, height, vw: innerWidth, vh: innerHeight, without: 0,
      };
      // the same bar without the cog and the switch: the pair must not be what sets the bar's height
      (view?.parentElement ?? document.querySelector('button.cog'))?.remove();
      res.without = top.getBoundingClientRect().height;
      return res;
    });
    expect(m.view, 'no view switch').not.toBeNull();
    const v = m.view!; const c = m.cog!;
    expect(v.width, 'switch narrower than 48 px').toBeGreaterThanOrEqual(48);
    expect(v.height, 'switch shorter than 48 px').toBeGreaterThanOrEqual(48);
    expect(m.misses, 'parts of the switch do not take its taps').toEqual([]);
    // directly below the cog: centred under it, starting where it ends
    expect(Math.abs((v.left + v.right) / 2 - (c.left + c.right) / 2), 'switch not centred under the cog').toBeLessThanOrEqual(1);
    expect(v.top, 'switch overlaps the cog').toBeGreaterThanOrEqual(c.bottom - 0.5);
    expect(v.top - c.bottom, 'switch not directly under the cog').toBeLessThanOrEqual(4);
    // the cog is raised: its centre sits above + New's (it used to share + New's centre line), and it keeps a tap area
    expect((c.top + c.bottom) / 2, 'the cog is not raised').toBeLessThan((m.isNew!.top + m.isNew!.bottom) / 2 - 4);
    expect(c.height, 'the cog lost its tap area').toBeGreaterThanOrEqual(24);
    expect(c.width, 'the cog lost its tap area').toBeGreaterThanOrEqual(40);
    expect(m.cogMisses, 'parts of the cog glyph do not take its taps').toEqual([]);
    expect(c.top, 'the cog left the screen').toBeGreaterThanOrEqual(-0.5);
    // nothing overlaps + New, the counts, the meters, the clock or the board below
    const hit = (a: NonNullable<typeof v>, b: NonNullable<typeof v>) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    for (const [name, b] of [['+ New', m.isNew], ['counts', m.counts], ['clock', m.clock], ['board', m.main], ...m.meters.map((x, i) => [`meter ${i}`, x] as const)] as const) {
      if (!b || !b.width || !b.height) continue;
      expect(hit(v, b), `switch overlaps ${name}`).toBe(false);
      expect(hit(c, b), `cog overlaps ${name}`).toBe(false);
    }
    expect(v.right, 'switch past the right edge').toBeLessThanOrEqual(m.vw + 0.5);
    // the bar is as tall as without the pair, in landscape and in portrait. The one exception is a wrapped bar (+ New and
    // the pair on a line of their own below the clock): that line is only + New's height, too short for the 48 px switch
    // and a cog the size of its glyph, so the cog holds its 24 px floor and the line grows by what that needs, no more.
    const wrapped = m.side!.top > m.clock!.bottom;
    if (wrapped) {
      expect(c.height, 'a wrapped bar grew for more than the cog\'s floor').toBeLessThanOrEqual(24.5);
      expect(m.height - m.without, `wrapped top bar ${m.height}px, ${m.without}px without the cog and the switch`).toBeLessThanOrEqual(12);
    } else expect(m.height, `top bar ${m.height}px, ${m.without}px without the cog and the switch`).toBeLessThanOrEqual(m.without + 0.5);
  });
});

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { topBarHtml, type BoardState } from '../web/src/board.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const LABELS = ['Studio', 'Personal', 'Consulting', 'Agency', 'Clients'];
const FIGS: Array<[number | null, number | null]> = [[100, 100], [7, 63], [null, 41], [88, 100], [41, 9]];

const state = (accounts: number): BoardState => ({
  // two-digit counts in every state: the widest the counts get in practice
  sessions: ['needs-you', 'working', 'asleep', 'stopped'].flatMap((st, j) => Array.from({ length: 10 + j }, (_, i) => ({ key: `${st}${i}`, state: st }))) as any,
  usage: LABELS.slice(0, accounts).map((label, i) => ({ account: label.toLowerCase(), label, colour: '#e8b54a', fiveHour: FIGS[i]![0], weekly: FIGS[i]![1],
    fiveHourResetsAt: null, weeklyResetsAt: null, stale: i === 3, updatedAt: null })) as any,
  accounts: [], cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0,
});

describe.skipIf(!CHROMIUM)('top bar layout', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  const page = async (width: number, height: number, html: string) => {
    const p = await browser.newPage({ viewport: { width, height } });
    await p.setContent(`<style>${css}</style><div id="app"><header class="top">${html}</header><main class="strips"></main></div>`);
    return p;
  };

  // The date spans the clock's width (spec §5.1): the shortest and the longest dates, at the tablet's sizes.
  it.each([[961, 601], [961, 480], [800, 480], [1280, 800], [601, 961], [601, 800]])('the date is as wide as the clock (within 10%%) at %ix%i', async (w, h) => {
    for (const d of [new Date(2026, 9, 1, 9, 5), new Date(2026, 8, 30, 23, 59), new Date(2026, 4, 13, 0, 0)]) {
      const p = await page(w, h, topBarHtml(state(2), { meters: 'rings' }, d));
      try {
        const m = await p.evaluate(() => {
          const width = (el: Element) => { const r = document.createRange(); r.selectNodeContents(el); return r.getBoundingClientRect().width; };
          return { time: width(document.querySelector('.time')!), date: width(document.querySelector('.date')!), text: document.querySelector('.date')!.textContent };
        });
        expect(Math.abs(m.date - m.time) / m.time, `${m.text} at ${w}x${h}: ${m.date} vs ${m.time}`).toBeLessThanOrEqual(0.1);
      } finally { await p.close(); }
    }
  });

  // The meters' figures sit on one line, and the whole top bar fits the width, with one to five accounts, in landscape
  // and in the tablet's portrait (601 wide; about 800 tall with Chrome's bars).
  const cases = [[1280, 800], [961, 601], [961, 480], [800, 480], [800, 601], [601, 961], [601, 800]].flatMap(([w, h]) =>
    (['rings', 'bars'] as const).flatMap((mode) => [1, 2, 3, 4, 5].map((n) => [w!, h!, mode, n] as const)));
  it.each(cases)('at %ix%i with %s and %i accounts the figures never wrap or spill and nothing leaves the bar', async (w, h, mode, n) => {
    const p = await page(w, h, topBarHtml(state(n), { meters: mode, filter: 'working' }, new Date(2026, 8, 30, 23, 59)));
    try {
      const m = await p.evaluate(() => {
        const top = document.querySelector('header.top')!;
        const nums = [...document.querySelectorAll<HTMLElement>('.mnums')].map((el) => {
          const r = document.createRange(); r.selectNodeContents(el);
          return { lines: new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size, right: el.getBoundingClientRect().right, box: el.closest('.meter')!.getBoundingClientRect() };
        });
        const labels = [...document.querySelectorAll<HTMLElement>('.count span, .mlabel')].map((el) => el.getBoundingClientRect().height);
        return {
          nums, labels, vw: innerWidth,
          right: Math.max(...[...top.children].map((c) => c.getBoundingClientRect().right)),
          // left-to-right edges of the bar's parts (clock, counts, meters, buttons) and of the meters inside their room
          // in the order they appear (by line, then left to right; a line's parts share a centre line), not DOM order
          parts: [...top.children].map((c) => { const r = c.getBoundingClientRect(); return { name: c.className, left: r.left, right: r.right, top: r.top, bottom: r.bottom }; })
            .sort((a, b) => Math.round(a.top + a.bottom) - Math.round(b.top + b.bottom) || a.left - b.left),
          meterLeft: Math.min(...[...document.querySelectorAll('.meter')].map((el) => el.getBoundingClientRect().left)),
          roomLeft: document.querySelector('.meters')!.getBoundingClientRect().left,
          overflow: top.scrollWidth - top.clientWidth,
          figs: [...document.querySelectorAll<HTMLElement>('.fig')].map((el) => el.getBoundingClientRect().width),
          bars: [...document.querySelectorAll('svg.bars')].map((el) => el.getBoundingClientRect().width),
          // the meters sit at the right of the room they have; slack is what is left of it
          slack: document.querySelector('.meter')!.getBoundingClientRect().left - document.querySelector('.meters')!.getBoundingClientRect().left,
          room: document.querySelector('.meters')!.getBoundingClientRect().width,
          // one character of the meters' 10 px monospace
          ch: (() => { const s = document.createElement('span'); s.textContent = '0'.repeat(10); document.querySelector('.meters')!.append(s);
            const w = s.getBoundingClientRect().width / 10; s.remove(); return w; })(),
          gap: parseFloat(getComputedStyle(document.querySelector('.meters')!).columnGap),
          tight: [...document.querySelectorAll('.mnums .k')].some((el) => getComputedStyle(el).display === 'none'),
          bare: [...document.querySelectorAll('.mnums .k ~ .fig .pc')].some((el) => getComputedStyle(el).display === 'none'),
        };
      });
      expect(m.nums).toHaveLength(n);
      for (const x of m.nums) { expect(x.lines).toBe(1); expect(x.right).toBeLessThanOrEqual(x.box.right + 0.5); }
      for (const hgt of m.labels) expect(hgt).toBeLessThan(24);                       // one line each
      expect(new Set(m.figs.map((x) => Math.round(x))).size).toBe(1);                 // fixed-width figure columns
      expect(m.overflow).toBeLessThanOrEqual(0);
      // bars keep their 64 px and shorten only when the bar has no room left, never because the viewport is narrower
      expect(m.bars).toHaveLength(mode === 'bars' ? n : 0);
      if (m.bars.some((x) => x < 63.5)) expect(m.slack, `bars ${m.bars.join(',')} shortened with ${m.slack}px to spare`).toBeLessThan(1);
      // bars drop the "5h"/"wk" words (keeping both figures on one line) only when the full lines cannot all fit
      // and their % signs only when even "N% N%" lines cannot all fit
      const need = (chars: number) => n * chars * m.ch + (n - 1) * m.gap > m.room + 0.5;
      if (mode === 'rings') expect([m.tight, m.bare]).toEqual([false, false]);
      else expect([m.tight, m.bare], `room ${m.room}px for ${n} meters`).toEqual([need(17 + 10 / m.ch), need(9)]);
      expect(m.right).toBeLessThanOrEqual(m.vw);
      // nothing overlaps: on each line a part starts after the previous one ends, and no meter spills left out of its
      // room. When the meters cannot all fit beside the counts (portrait, or five accounts at 800 px) they move to a
      // second line with the buttons; at the tablet's landscape width (961) and wider the bar stays on one line.
      const sameLine = (a: typeof m.parts[0], b: typeof m.parts[0]) => a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
      for (let i = 1; i < m.parts.length; i++) {
        if (sameLine(m.parts[i]!, m.parts[i - 1]!)) expect(m.parts[i]!.left, `${m.parts[i]!.name} overlaps ${m.parts[i - 1]!.name}`).toBeGreaterThanOrEqual(m.parts[i - 1]!.right - 0.5);
        else expect(m.parts[i]!.top, `${m.parts[i]!.name} overlaps the line above`).toBeGreaterThanOrEqual(Math.max(...m.parts.slice(0, i).map((x) => x.bottom)) - 0.5);
      }
      if (w >= 961) expect(m.parts.every((x) => sameLine(x, m.parts[0]!)), 'the bar wraps in landscape').toBe(true);
      // a wrapped bar never strands a button: "+ New" and the cog (in its column with the view switch, Task 38) stay
      // together on one line
      const part = (name: string) => m.parts.find((x) => x.name === name)!;
      expect(sameLine(part('new'), part('side')), `the cog is alone on its line: ${JSON.stringify(m.parts)}`).toBe(true);
      expect(part('side').right, 'the buttons are not at the right').toBeGreaterThanOrEqual(Math.max(...m.parts.map((x) => x.right)) - 0.5);
      expect(part('side').left - part('new').right, 'the cog is not beside + New').toBeGreaterThan(4);
      // in portrait the meters have their own line under the clock, the counts and the buttons
      if (h > w) expect(part('meters').top, 'portrait meters share a line').toBeGreaterThanOrEqual(Math.max(part('clock').bottom, part('counts').bottom, part('side').bottom) - 0.5);
      expect(m.meterLeft, 'a meter spills left of the meters\' room').toBeGreaterThanOrEqual(m.roomLeft - 0.5);
    } finally { await p.close(); }
  });
});

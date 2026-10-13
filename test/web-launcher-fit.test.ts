// Spec §5.2 (2026-10-12): the launcher keeps its three columns side by side and fits the screen without scrolling.
// The real board in demo mode, in a real browser, at each landscape size × 1, 3 and 5 accounts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { createDemo } from '../src/demo/index.js';
import { createActionRoutes } from '../src/actions/routes.js';
import { startServer } from '../src/server.js';
import type { AccountUsage } from '../src/types.js';
import type { LaunchAccountOptions } from '../src/actions/types.js';
import { CHROMIUM, ROOT, launch, startWeb } from './helpers/browser.js';

// 961x431: the real tablet (Android Chrome, 1280x800 at 4/3) with Chrome's tab strip, toolbar and the nav bar showing
const SIZES: [number, number][] = [[1280, 800], [961, 601], [961, 480], [961, 431], [800, 480]];
const COUNTS = [1, 3, 5];
// portrait (spec §5.2 fallback): the steps stack, so only the no-scrolling and Start checks apply
const PORTRAIT: [number, number][] = [[601, 961], [480, 800]];
// LAUNCHER_SHOTS=<suffix> saves 961x601 and 961x480 (3 and 5 accounts) to $CLAYCLAUDE_QA_DIR/plan3/launcher-<size>-<n>acct-<suffix>.png
// (CLAYCLAUDE_QA_DIR defaults to qa/ in the repo, git-ignored)
const SHOTS = process.env.LAUNCHER_SHOTS;
const SHOT_DIR = join(process.env.CLAYCLAUDE_QA_DIR ?? join(ROOT, 'qa'), 'plan3');

const EXTRA = [{ id: 'research', label: 'Research', colour: '#5aa9ff' }, { id: 'night-shift', label: 'Night shift', colour: '#f472b6' }];

describe.skipIf(!CHROMIUM)('launcher fits the screen (demo mode, real browser)', () => {
  let n = 3;
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  let closeDaemon: () => Promise<void>;
  let stopDemo: () => void;

  beforeAll(async () => {
    const demo = createDemo();
    // The demo has three accounts; the board under test sees `n` of them (two made-up extras beyond three,
    // the fifth unreachable so its card carries the longest content).
    const accounts = async (): Promise<LaunchAccountOptions[]> => {
      const base = (await demo.api.launchOptions()).accounts;
      const extra = EXTRA.map((e) => ({ ...base[0]!, ...e, host: 'rack' }));
      return [...base, ...extra].slice(0, n).map((a, i) => (i === 4 ? { ...a, canLaunch: false, reason: 'ssh: connect to host rack port 22: Connection timed out' } : a));
    };
    const usage = new (class extends EventEmitter {
      usage(): AccountUsage[] {
        const base = demo.usage.usage();
        return [...base, ...EXTRA.map((e, i) => ({ ...base[0]!, account: e.id, label: e.label, colour: e.colour, fiveHour: 55 + i * 30, weekly: 20 }))].slice(0, n);
      }
      publicShape() { return {}; }
      isExhausted() { return false; }
      start() { /* static */ } stop() { /* static */ }
    })();
    const api = { ...demo.api, launchOptions: async () => ({ accounts: await accounts() }), repos: () => demo.api.repos('studio') };
    const s = await startServer({ cfg: demo.cfg, collector: demo.collector as never, usage: usage as never, webRoot: mkdtempSync(join(tmpdir(), 'cc-web-')), port: 0,
      handlers: [createActionRoutes(api, { mode: 'demo', publicConfig: demo.publicConfig })] });
    closeDaemon = s.close; stopDemo = demo.stop;
    web = await startWeb(`http://127.0.0.1:${s.port}`);
    browser = await launch();
    if (SHOTS) mkdirSync(SHOT_DIR, { recursive: true });
  }, 60_000);
  afterAll(async () => { await browser?.close(); await web?.close(); await closeDaemon?.(); stopDemo?.(); });

  /** The board, launcher open, first account and first repo picked (the fullest the launcher gets). */
  async function openLauncher(width: number, height: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width, height } });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(web.url);
    await page.locator('[data-act="new"]').click();
    await page.waitForFunction((k) => document.querySelectorAll('.launcher .acct').length === k, n);
    await page.locator('.launcher .acct').first().click();
    await page.locator('.launcher .repo').first().click();
    await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('.launcher .start')?.disabled);
    return page;
  }

  const measure = (p: Page) => p.evaluate(() => {
    const root = document.querySelector<HTMLElement>('.launcher')!;
    const scrolls: string[] = [];
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${typeof e.className === 'string' && e.className ? '.' + e.className.split(' ').join('.') : ''}`;
    // the launcher root and every ancestor
    for (let e: Element | null = root; e; e = e.parentElement) if (e.scrollHeight > e.clientHeight) scrolls.push(`${name(e)} ${e.scrollHeight}>${e.clientHeight}`);
    // inside it, only the repo results list may scroll (the accounts list scrolling was the bug)
    for (const e of root.querySelectorAll<HTMLElement>('*')) {
      if (e.id === 'l-repos' || e.closest('#l-repos')) continue;
      if (getComputedStyle(e).overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1) scrolls.push(`${name(e)} ${e.scrollHeight}>${e.clientHeight}`);
    }
    const box = (s: string) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right }; };
    return { scrolls, start: box('.launcher .start'), cols: [...document.querySelectorAll('.launcher .steps > section')].map((s) => { const r = s.getBoundingClientRect(); return { top: r.top, left: r.left, bottom: r.bottom, right: r.right }; }),
      vw: window.innerWidth, vh: window.innerHeight };
  });

  for (const count of COUNTS) {
    it.each(SIZES)(`${count} account(s) at %ix%i: three columns, no scrolling, Start fully on screen`, async (width, height) => {
      n = count;
      const p = await openLauncher(width, height);
      try {
        const m = await measure(p);
        // screenshots before the assertions, so a "before" run records the failing layout too
        if (SHOTS && width === 961 && count !== 1) {
          // let the clay characters draw first (they bake in a worker; a slow one is shown as it is)
          await p.waitForFunction((k) => document.querySelectorAll('.launcher .acct-char canvas').length >= k, count, { timeout: 30_000 }).catch(() => {});
          await p.waitForTimeout(500);
          await p.screenshot({ path: join(SHOT_DIR, `launcher-${width}x${height}-${count}acct-${SHOTS}.png`) });
        }
        expect(m.scrolls).toEqual([]);
        const s = m.start;
        expect(s.top >= 0 && s.left >= 0 && s.bottom <= m.vh && s.right <= m.vw, JSON.stringify(s)).toBe(true);
        // three columns side by side: left < middle < right, overlapping vertically
        const [l, mid, r] = m.cols;
        expect(m.cols).toHaveLength(3);
        expect(l!.right).toBeLessThanOrEqual(mid!.left);
        expect(mid!.right).toBeLessThanOrEqual(r!.left);
        expect(Math.max(l!.top, mid!.top, r!.top)).toBeLessThan(Math.min(l!.bottom, mid!.bottom, r!.bottom));
      } finally { await p.close(); }
    }, 60_000);
    it.each(PORTRAIT)(`${count} account(s) at %ix%i (portrait): no scrolling, Start fully on screen`, async (width, height) => {
      n = count;
      const p = await openLauncher(width, height);
      try {
        const m = await measure(p);
        expect(m.scrolls).toEqual([]);
        const s = m.start;
        expect(s.top >= 0 && s.left >= 0 && s.bottom <= m.vh && s.right <= m.vw, JSON.stringify(s)).toBe(true);
      } finally { await p.close(); }
    }, 60_000);
  }
});

// The focus view's characters in a real browser: each one stays inside its own slot, is drawn at the
// slot's device-pixel size, never piles up across updates and state changes, and is freed on close.
// (Tablet bug 2026-10-12 20:48: the focus character and every small card's character were drawn full
// screen, stacked on each other, and blurry.)
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { createDemo } from '../src/demo/index.js';
import { clayStateFor } from '../web/src/clay/index.js';
import { CHROMIUM, ROOT, launch, startWeb } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const NOW = Date.parse('2026-10-12T12:00:00Z');
const demo = createDemo({ scenario: 'gallery', now: () => NOW });
const SESSIONS = demo.collector.sessions();
demo.stop();
const ACCOUNTS = demo.cfg.accounts.map((a) => ({ id: a.id, label: a.label, colour: a.colour, host: 'desk' }));
// sessions whose characters differ, so swapping them under one key is a state change
const distinct = (() => {
  const seen = new Set<string>();
  return SESSIONS.filter((s) => { const id = clayStateFor(s, NOW, 60).id; if (seen.has(id)) return false; seen.add(id); return true; });
})();

/** Runs in the page: boots a real controller and the real focus view against an in-page board state. */
const BOOT = `
import { createClayController } from '/src/clay/index.ts';
import { openFocus } from '/src/focus.ts';
import { shellHtml as launcherShell } from '/src/launcher-view.ts';
import { initialLauncher } from '/src/launcher-model.ts';
import { overlayRoot, pushOverlay } from '/src/overlay.ts';
const { sessions, accounts, now } = window.__input;
const state = { sessions, usage: [], accounts, cacheTtlMinutes: 60, serverTime: now, clockSkew: now - Date.now() };
const clay = createClayController({ prefs: { mode: 'live', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' }, cacheTtlMinutes: 60 });
const board = document.createElement('div');
document.body.appendChild(board);
const t = window.__t = {
  state, clay,
  open(key) { t.close = openFocus({ sessionKey: key, getState: () => state, clay, ttlMinutes: () => 60, onAction() {}, onSwitch() {} }); },
  /** Replace the focused session's content with another session's (a state change), and push it like the websocket does. */
  become(key, other) {
    const src = state.sessions.find((s) => s.key === other);
    state.sessions = state.sessions.map((s) => (s.key === key ? { ...src, key, name: s.name } : s));
    clay.sync(board, state.sessions, Date.now() + state.clockSkew);
  },
  launcher(n) {
    const el = document.createElement('section');
    el.className = 'launcher modal';
    const opts = { accounts: accounts.slice(0, n).map((a) => ({ ...a, canLaunch: true, models: ['opus'], efforts: ['high'], remoteControl: true })) };
    el.innerHTML = launcherShell({ opts, repos: [], st: { ...initialLauncher(), account: accounts[0].id }, usage: [], busy: false });
    const stops = [];
    const close = pushOverlay(el, () => stops.forEach((f) => f()));
    el.querySelectorAll('.acct-char').forEach((c) => stops.push(clay.mountState(c, 'L1', { colour: '#e8b54a' })));
    t.close = close;
  },
  /** A slot whose stylesheet forgot position: relative, in a full-screen overlay. */
  bare() {
    const el = document.createElement('section');
    el.className = 'bare modal';
    el.innerHTML = '<div style="margin:40px;width:60px;height:60px"></div>';
    overlayRoot().appendChild(el);
    t.close = clay.mountState(el.firstElementChild, 'W3');
  },
  /** Every clay canvas under root: its backing store, its box, and its slot's box. */
  measure(sel) {
    const box = (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
    return [...document.querySelectorAll(sel + ' canvas.clay')].map((c) => ({
      slot: c.parentElement.id || c.parentElement.className, w: c.width, h: c.height, box: box(c), slotBox: box(c.parentElement),
    }));
  },
};
t.ready = true;
`;

describe.skipIf(!CHROMIUM)('focus view characters (real browser)', () => {
  let web: Awaited<ReturnType<typeof startWeb>>;
  let browser: Browser;
  beforeAll(async () => { web = await startWeb(); browser = await launch(); }, 60_000);
  afterAll(async () => { await browser?.close(); await web?.close(); });

  async function boot(dpr: number): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 961, height: 601 }, deviceScaleFactor: dpr });
    page.on('pageerror', (e) => console.error('page error:', e.message));
    await page.goto(`${web.url}/clay-bake.html`);
    await page.addStyleTag({ content: css });
    await page.evaluate((input) => { (window as any).__input = input; }, { sessions: SESSIONS, accounts: ACCOUNTS, now: NOW });
    await page.addScriptTag({ type: 'module', content: BOOT });
    await page.waitForFunction('window.__t?.ready === true');
    return page;
  }
  type M = { slot: string; w: number; h: number; box: { x: number; y: number; w: number; h: number }; slotBox: { x: number; y: number; w: number; h: number } };
  const measure = (p: Page, sel: string) => p.evaluate((s) => (window as any).__t.measure(s), sel) as Promise<M[]>;
  const inside = (m: M) => {
    const e = 0.5;
    expect(m.box.x, m.slot).toBeGreaterThanOrEqual(m.slotBox.x - e);
    expect(m.box.y, m.slot).toBeGreaterThanOrEqual(m.slotBox.y - e);
    expect(m.box.x + m.box.w, m.slot).toBeLessThanOrEqual(m.slotBox.x + m.slotBox.w + e);
    expect(m.box.y + m.box.h, m.slot).toBeLessThanOrEqual(m.slotBox.y + m.slotBox.h + e);
  };
  const overlap = (a: M['box'], b: M['box']) => Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

  it('every character stays inside its own slot, one per slot, none stacked, across updates and state changes', async () => {
    const p = await boot(2);
    try {
      const key = distinct[0]!.key;
      await p.evaluate((k) => (window as any).__t.open(k), key);
      const others = Math.min(8, SESSIONS.length - 1);
      await p.waitForFunction((n) => document.querySelectorAll('.focus canvas.clay').length === n, 1 + others, { timeout: 60_000 });
      for (let round = 0; round < 4; round++) {
        if (round > 0) {
          await p.evaluate(([k, o]) => (window as any).__t.become(k, o), [key, distinct[round % distinct.length]!.key]);
          await p.waitForTimeout(1300); // past one 1 s refresh of the focus view
        }
        const ms = await measure(p, '.focus');
        expect(ms.filter((m) => m.slot === 'f-char')).toHaveLength(1);
        expect(ms).toHaveLength(1 + others);
        expect(await p.evaluate(() => [...document.querySelectorAll('.focus .char-large, .focus .mini-char')].every((s) => s.querySelectorAll('canvas').length <= 1))).toBe(true);
        for (const m of ms) inside(m);
        for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) expect(overlap(ms[i]!.box, ms[j]!.box), `${ms[i]!.slot} over ${ms[j]!.slot}`).toBe(0);
      }
    } finally { await p.close(); }
  }, 120_000);

  it.each([1, 2])('the large character is drawn at its slot\'s device-pixel size (dpr %i), not upscaled', async (dpr) => {
    const p = await boot(dpr);
    try {
      await p.evaluate((k) => (window as any).__t.open(k), distinct[0]!.key);
      await p.waitForFunction(() => document.querySelector('#f-char canvas.clay'), undefined, { timeout: 60_000 });
      const [m] = (await measure(p, '#f-char')) as M[];
      expect(m!.w).toBeGreaterThanOrEqual(Math.round(m!.slotBox.w * dpr));
      expect(m!.h).toBeGreaterThanOrEqual(Math.round(m!.slotBox.h * dpr));
      expect(m!.box.w).toBeCloseTo(m!.slotBox.w, 0);
    } finally { await p.close(); }
  }, 120_000);

  it('closing the focus view removes every canvas and frees its backing store', async () => {
    const p = await boot(2);
    try {
      await p.evaluate((k) => (window as any).__t.open(k), distinct[0]!.key);
      await p.waitForFunction(() => document.querySelectorAll('.focus canvas.clay').length > 1, undefined, { timeout: 60_000 });
      await p.evaluate(() => { (window as any).__kept = [...document.querySelectorAll('canvas.clay')]; (window as any).__t.close(); });
      expect(await p.evaluate(() => document.querySelectorAll('canvas.clay').length)).toBe(0);
      expect(await p.evaluate(() => (window as any).__kept.every((c: HTMLCanvasElement) => !c.isConnected && c.width === 0 && c.height === 0))).toBe(true);
    } finally { await p.close(); }
  }, 120_000);

  it('a slot with no positioning of its own still holds its character', async () => {
    const p = await boot(2);
    try {
      await p.evaluate(() => (window as any).__t.bare());
      await p.waitForFunction(() => document.querySelector('.bare canvas.clay'), undefined, { timeout: 60_000 });
      const ms = await measure(p, '.bare');
      expect(ms).toHaveLength(1);
      inside(ms[0]!);
    } finally { await p.close(); }
  }, 120_000);

  // the board dims limit and stopped rows (.st-limit, .st-stopped); the focus panel shares those classes and
  // must not inherit the dimming, or the board shows through it (the tablet photo: riverbank-etl, a limit session)
  it.each(['limit', 'stopped'])('the focus panel of a %s session is opaque', async (state) => {
    const p = await boot(1);
    try {
      const s = SESSIONS.find((x) => x.state === state) ?? { ...SESSIONS[0]!, state };
      await p.evaluate((x) => { const t = (window as any).__t; t.state.sessions = [x, ...t.state.sessions.filter((o: any) => o.key !== x.key)]; t.open(x.key); }, s);
      await p.waitForSelector(`.focus-panel.st-${state}`);
      expect(await p.evaluate(() => getComputedStyle(document.querySelector('.focus-panel')!).opacity)).toBe('1');
    } finally { await p.close(); }
  }, 120_000);

  it('launcher account characters stay inside their cards', async () => {
    const p = await boot(2);
    try {
      const n = Math.min(3, ACCOUNTS.length);
      await p.evaluate((k) => (window as any).__t.launcher(k), n);
      await p.waitForFunction((k) => document.querySelectorAll('.launcher canvas.clay').length === k, n, { timeout: 60_000 });
      const ms = await measure(p, '.launcher');
      expect(ms).toHaveLength(n);
      for (const m of ms) inside(m);
    } finally { await p.close(); }
  }, 120_000);
});

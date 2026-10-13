import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { shellHtml, type LView } from '../web/src/launcher-view.js';
import { initialLauncher } from '../web/src/launcher-model.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

const view = (path: string): LView => ({
  opts: { accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true, models: ['opus'], efforts: ['high'], remoteControl: true }] } as LView['opts'],
  repos: [{ path, name: 'acme-client-portal-v2-staging', lastUsedMs: 0 }],
  st: { ...initialLauncher(), account: 'a', repo: path },
  usage: [], busy: false,
});

describe.skipIf(!CHROMIUM)('launcher layout', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  // a long repo path must ellipsize inside its column, never push Options (and Start) off the panel
  it.each([
    [800, 601, '/mnt/c/Users/alice.BUILD-BOX/source/repos/acme-client-portal-v2-staging'],
    [961, 601, '/mnt/c/Users/alice.BUILD-BOX/source/repos/clients/acme/archive/2025/acme-client-portal-v2-staging'],
  ])('keeps Start inside the panel at %ix%i with a long path', async (width, height, path) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<style>${css}</style><section class="launcher modal">${shellHtml(view(path))}</section>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        const repos = document.querySelector('#l-repos')!;
        return { panel: r('.launcher-panel').right, start: r('.start').right, opts: r('#l-opts').right, scroll: repos.scrollWidth, client: repos.clientWidth };
      });
      expect(m.start).toBeLessThanOrEqual(m.panel);
      expect(m.opts).toBeLessThanOrEqual(m.panel);
      expect(m.scroll).toBeLessThanOrEqual(m.client);
    } finally { await page.close(); }
  });

  // more accounts than the column holds: the list scrolls, cards keep their content height and never overlap
  const many = (n: number): LView => {
    const ids = ['a', 'b', 'c', 'd', 'e'].slice(0, n);
    return {
      opts: { accounts: ids.map((id, i) => ({ id, label: `Account ${id}`, colour: '#e8b54a', host: 'desk', canLaunch: i !== 1,
        ...(i === 1 ? { reason: 'ssh: connect to host rack port 22: Connection timed out' } : {}), models: ['opus'], efforts: ['high'], remoteControl: true })) } as LView['opts'],
      repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }],
      st: { ...initialLauncher(), account: 'a', repo: '/r' },
      usage: ids.map((id) => ({ account: id, label: id, colour: '#e8b54a', fiveHour: 40, weekly: 60, fiveHourResetsAt: null, weeklyResetsAt: null, stale: false, updatedAt: null })),
      busy: false,
    };
  };
  it.each([
    [961, 601, 4], [800, 601, 4], [800, 480, 3],
  ])('account cards do not squash or overlap at %ix%i with %i accounts', async (width, height, n) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<style>${css}</style><section class="launcher modal">${shellHtml(many(n))}</section>`);
      const m = await page.evaluate(() => {
        const cards = [...document.querySelectorAll<HTMLElement>('#l-accts .acct')];
        return {
          rects: cards.map((c) => { const r = c.getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; }),
          // the lowest painted descendant of each card must sit inside that card
          spill: cards.map((c) => Math.max(...[...c.querySelectorAll('*')].map((e) => e.getBoundingClientRect().bottom)) - c.getBoundingClientRect().bottom),
        };
      });
      expect(m.rects).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(m.rects[i]!.top).toBeGreaterThanOrEqual(m.rects[i - 1]!.bottom);
      for (const s of m.spill) expect(s).toBeLessThanOrEqual(0.5);
    } finally { await page.close(); }
  });
  // Found on the tablet (Task 23): in a Chrome tab the on-screen keyboard leaves about 160 CSS px above it. Typing in the
  // repo search hid both the list and Start. In a short visual viewport the overlay root gets `short` and the launcher
  // keeps the search box, the first matches and Start on screen.
  it.each([[961, 160], [961, 280], [800, 160]])('keeps search, a match and Start visible above the keyboard at %ix%i', async (width, short) => {
    const page = await browser.newPage({ viewport: { width, height: 601 } });
    try {
      const v = { ...view('/home/demo/code/mossgarden-infra'), repos: ['mossgarden-infra', 'moss-notes', 'mosaic'].map((n) => ({ path: `/home/demo/code/${n}`, name: n, lastUsedMs: 0 })) };
      v.st = { ...v.st, repo: null as unknown as string, query: 'mos' };
      await page.setContent(`<style>${css}</style><div id="overlays" class="short kb" style="--vvh:${short}px"><section class="launcher modal">${shellHtml(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
        return { q: r('#repo-q'), repo: r('#l-repos .repo'), start: r('.start'), root: r('#overlays') };
      });
      expect(m.root.h).toBe(short);
      for (const k of ['q', 'repo', 'start'] as const) {
        expect(m[k].top, k).toBeGreaterThanOrEqual(0);
        expect(m[k].bottom, k).toBeLessThanOrEqual(short + 0.5);
        expect(m[k].h, k).toBeGreaterThan(20);
      }
    } finally { await page.close(); }
  });
  // The compact layout must never leave the launcher without a way to pick an account: with the keyboard up before an
  // account is chosen, or in a window that is merely short (a phone in landscape, a split screen) with no keyboard,
  // the account column stays visible and its cards can be tapped.
  it.each([
    ['keyboard up, no account picked', 'short kb', 160, false],
    ['short window, no keyboard, no account picked', 'short', 340, false],
    ['short window, no keyboard, account picked', 'short', 340, true],
  ])('keeps the account column in the compact layout: %s', async (_name, cls, short, picked) => {
    const page = await browser.newPage({ viewport: { width: 961, height: 601 } });
    try {
      const v = view('/home/demo/code/mossgarden-infra');
      v.repos = null;
      v.st = { ...v.st, account: picked ? 'a' : undefined, repo: undefined } as LView['st'];
      await page.setContent(`<style>${css}</style><div id="overlays" class="${cls}" style="--vvh:${short}px"><section class="launcher modal">${shellHtml(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height, w: b.width }; };
        const hit = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height, 20) / 2)?.closest(s) != null; };
        return { acct: r('.acct'), q: r('#repo-q'), tappable: hit('.acct') };
      });
      expect(m.acct.w).toBeGreaterThan(40);
      expect(m.acct.top).toBeGreaterThanOrEqual(0);
      expect(m.acct.top).toBeLessThan(short - 20);
      expect(m.tappable).toBe(true);
      expect(m.q.bottom).toBeLessThanOrEqual(short + 0.5);
    } finally { await page.close(); }
  });
  // final tablet pass: an option's checkbox sits beside its words, not at the far side of the column from them
  it.each([[961, 601], [600, 961]])('option checkboxes sit next to their labels at %ix%i', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<style>${css}</style><section class="launcher modal">${shellHtml(view('/r'))}</section>`);
      const gaps = await page.evaluate(() => [...document.querySelectorAll('#l-opts label.check')].map((l) => {
        const box = l.querySelector('input')!.getBoundingClientRect();
        const range = document.createRange(); range.selectNodeContents(l);
        const text = [...range.getClientRects()].filter((r) => r.left >= box.right - 1).reduce((a, r) => Math.min(a, r.left), Infinity);
        return Math.round(text - box.right);
      }));
      expect(gaps.length).toBeGreaterThan(0);
      for (const g of gaps) expect(g).toBeLessThanOrEqual(24);
    } finally { await page.close(); }
  });
  // final tablet pass: portrait Chrome tab, keyboard up for the repo search (the visual viewport is 517 of 795 CSS px,
  // too tall for the compact layout): the account cards squeezed the repo step to nothing, so its title and search box
  // were drawn over Options. The search, a match and Start stay visible and the search never overlaps Options.
  it('keeps search, a match and Start clear of each other above the keyboard in a portrait tab', async () => {
    const page = await browser.newPage({ viewport: { width: 602, height: 795 } });
    try {
      const v = { ...view('/home/demo/code/orchard-api'), repos: ['orchard-api', 'harbor-notes', 'atlas-importer'].map((n) => ({ path: `/home/demo/code/${n}`, name: n, lastUsedMs: 0 })) };
      v.opts = { accounts: ['a', 'b', 'c'].map((id) => ({ id, label: `Account ${id}`, colour: '#e8b54a', host: 'desk', canLaunch: true, models: ['opus'], efforts: ['high'], remoteControl: true })) } as LView['opts'];
      v.st = { ...v.st, repo: null as unknown as string, query: 'or' };
      await page.setContent(`<style>${css}</style><div id="overlays" class="kb" style="--vvh:517px"><section class="launcher modal">${shellHtml(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, h: b.height }; };
        return { q: r('#repo-q'), repo: r('#l-repos .repo'), start: r('.start'), opts: r('#l-opts') };
      });
      for (const k of ['q', 'repo', 'start'] as const) {
        expect(m[k].top, k).toBeGreaterThanOrEqual(0);
        expect(m[k].bottom, k).toBeLessThanOrEqual(517.5);
        expect(m[k].h, k).toBeGreaterThan(20);
      }
      expect(m.q.bottom).toBeLessThanOrEqual(m.opts.top);
      expect(m.repo.bottom).toBeLessThanOrEqual(m.opts.top);
    } finally { await page.close(); }
  });
  // Task 42a: the optional Name in Options. With the keyboard up for it (a landscape tab leaves 160 px, landscape full
  // screen about 281 px, a portrait tab about 517 px) the field and Start are both on screen and clear of each other.
  it.each([
    [961, 601, 'short kb', 160], [961, 602, 'short kb', 281], [602, 795, 'kb', 517], [961, 601, '', 601], [602, 961, '', 961],
  ])('at %ix%i (%s, %i px visible) the Name field and Start are on screen and apart', async (width, height, cls, vvh) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      const v = view('/home/demo/code/orchard-api');
      v.st = { ...v.st, name: 'a fairly long session name here' };
      await page.setContent(`<style>${css}</style><div id="overlays" class="${cls}" style="--vvh:${vvh}px"><section class="launcher modal">${shellHtml(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => { const b = document.querySelector(s)!.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height, w: b.width }; };
        return { name: r('#l-name'), start: r('.start'), panel: r('.launcher-panel'), value: (document.querySelector('#l-name') as HTMLTextAreaElement).value };
      });
      expect(m.value).toBe('a fairly long session name here');
      for (const k of ['name', 'start'] as const) {
        expect(m[k].top, k).toBeGreaterThanOrEqual(0);
        expect(m[k].bottom, k).toBeLessThanOrEqual(vvh + 0.5);
        expect(m[k].h, k).toBeGreaterThanOrEqual(36);
        expect(m[k].right, k).toBeLessThanOrEqual(m.panel.right + 0.5);
      }
      expect(m.name.w).toBeGreaterThan(140);
      // apart: one above the other, or (portrait) side by side on one line
      const apart = Math.min(m.name.bottom, m.start.bottom) - Math.max(m.name.top, m.start.top) <= 0.5 || Math.min(m.name.right, m.start.right) - Math.max(m.name.left, m.start.left) <= 0.5;
      expect(apart, `Name and Start overlap: ${JSON.stringify(m)}`).toBe(true);
    } finally { await page.close(); }
  });
});

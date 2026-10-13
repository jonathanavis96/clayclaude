import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { settingsHtml, type SettingsView } from '../web/src/settings-view.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/**
 * Task 34 (seen on the tablet): the settings panel's right side was cropped. Every control, label and the close
 * button must lie inside the viewport horizontally and be reachable by scrolling, on this tablet (961x600 CSS) and a
 * larger one (1280x800), in both orientations, in full screen and in a Chrome tab (about 120 CSS px of bars).
 *
 * `.sgrid` is the panel's scroll container. Chrome on Android paints an overlay scrollbar over the rightmost pixels
 * of a scroll container without reserving room for it (measured on the tablet: 5 device px, about 4 CSS px, over the
 * right edge of every right-column control). So nothing may sit in the last SCROLLBAR px of `.sgrid` either.
 */
const SCROLLBAR = 6;
const BARS = 120;
const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

const view: SettingsView = {
  prefs: DEFAULT_PREFS, clay: DEFAULT_CLAY_PREFS,
  config: {
    demo: true,
    hosts: [{ id: 'desk', ssh: null, tmuxSession: 'claude', repoRoots: [] }, { id: 'rack', ssh: 'rack', tmuxSession: 'claude', repoRoots: [] }],
    accounts: [
      { id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', configDir: '~/.claude', usage: 'none', open: 'app' },
      { id: 'b', label: 'Lab', colour: '#4ad0c0', host: 'rack', configDir: '~/.claude-lab', usage: 'none', open: 'chrome' },
      { id: 'c', label: 'Side', colour: '#a78bfa', host: 'desk', configDir: '~/.claude-side', usage: 'none', open: 'tmux' },
    ],
    ui: { quickReplies: ['yes', 'no', 'continue'], confirmBeforeSend: false }, stoppedRetentionMs: 3 * 3_600_000, lan: { enabled: false },
  },
  clayStatus: { mode: 'bake', reason: 'live ran at 20.4 fps, worst frame 100 ms; a test bake took 1672 ms', baked: 26, total: 26 },
  effective: { quickReplies: ['yes', 'no', 'continue'], confirmBeforeSend: false, stoppedRetentionMs: 3 * 3_600_000 },
};

const sizes: [number, number][] = [[961, 600], [600, 961], [1280, 800], [800, 1280]];
const matrix = sizes.flatMap(([w, h]) => [[w, h, 'full screen'], [w, h - BARS, 'Chrome tab']] as [number, number, string][]);

describe.skipIf(!CHROMIUM)('settings panel layout', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each(matrix)('every control is inside the viewport and reachable at %ix%i (%s)', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<style>${css}</style><div id="overlays"><section class="settings modal">${settingsHtml(view)}</section></div>`);
      const m = await page.evaluate(() => {
        const box = (e: Element) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom }; };
        const name = (e: Element) => (e as HTMLElement).dataset.pref ?? (e.matches('.x') ? 'close' : `${e.tagName.toLowerCase()} "${(e.textContent ?? '').trim().slice(0, 30)}"`);
        const sg = document.querySelector<HTMLElement>('.sgrid')!;
        const items = [...document.querySelectorAll('.settings-panel .x, .sgrid [data-pref]'), ...document.querySelectorAll('.sgrid h3, .srow > span, .sgrid p, .sgrid table')];
        return {
          vw: innerWidth, vh: innerHeight,
          panel: box(document.querySelector('.settings-panel')!),
          sgrid: { ...box(sg), scrollWidth: sg.scrollWidth, clientWidth: sg.clientWidth },
          // Task 45: a long label must not squeeze its checkbox smaller than the others.
          checks: [...document.querySelectorAll<HTMLElement>('.srow input[type=checkbox]')].map((e) => ({ name: e.dataset.pref, w: e.getBoundingClientRect().width })),
          items: items.map((e) => {
            e.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // reachable: scrolled into view, it is on screen
            return { name: name(e), control: e.matches('[data-pref]'), ...box(e) };
          }),
        };
      });
      expect(m.panel.left).toBeGreaterThanOrEqual(0);
      expect(m.panel.right).toBeLessThanOrEqual(m.vw);
      expect(m.sgrid.scrollWidth, 'the settings grid scrolls sideways').toBeLessThanOrEqual(m.sgrid.clientWidth);
      expect(m.items.filter((i) => i.control)).toHaveLength(15);   // Task 45 added Show background sessions
      for (const c of m.checks) expect(c.w, `${c.name} checkbox width`).toBeGreaterThanOrEqual(26);
      for (const i of m.items) {
        expect(i.left, i.name).toBeGreaterThanOrEqual(0);
        expect(i.right, i.name).toBeLessThanOrEqual(m.vw);
        expect(i.top, i.name).toBeGreaterThanOrEqual(0);
        expect(i.bottom, i.name).toBeLessThanOrEqual(m.vh);
        if (i.name !== 'close') expect(i.right, `${i.name} under the scrollbar`).toBeLessThanOrEqual(m.sgrid.right - SCROLLBAR);
      }
    } finally { await page.close(); }
  });
});

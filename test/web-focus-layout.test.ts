import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { shellHtml } from '../web/src/focus-view.js';
import type { FocusVM } from '../web/src/focus-model.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

const vm: FocusVM = {
  key: 'k', name: 'lantern-docs', meta: 'Lab · rack · agents', state: 'needs-you', word: 'NEEDS YOU',
  ctxPct: 38, model: 'sonnet-4-5', effort: 'medium', context: '182.4k of 1M', toolCount: 43, running: '1h 35m',
  feed: [{ time: '02:03:18', tool: 'Write', target: 'src/lib/backoff.ts' }],
  lastPrompt: 'Document the new export flags', lastReply: 'The flag reference is written.', files: ['src/lib/backoff.ts'],
  canAnswer: true, canMessage: false, canOpen: true, canAttach: true, offline: false,
};

// The tablet in portrait (Task 32 layout review): Chrome 602x795, full screen 602x962. The focus view's header (the
// large character, the name, the ring and stats, and the close ×) must stay inside the panel, so × is reachable and
// no stat is cut off. Landscape sizes must keep fitting too.
describe.skipIf(!CHROMIUM)('focus view layout', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([[602, 795], [602, 962], [601, 800], [961, 601], [961, 480], [800, 480], [1280, 800]])(
    'at %ix%i the header, its stats and the close button stay inside the panel', async (width, height) => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(`<style>${css}</style><div id="overlays"><section class="focus modal">${shellHtml(vm)}</section></div>`);
        const m = await page.evaluate(() => {
          const r = (e: Element) => e.getBoundingClientRect();
          const panel = r(document.querySelector('.focus-panel')!);
          const parts = ['#f-char', '.who', '#f-stats', '.stats', '.x'].map((s) => ({ s, ...r(document.querySelector(s)!).toJSON() }));
          const dds = [...document.querySelectorAll('.stats dd')].map((e) => ({ s: e.textContent, ...r(e).toJSON() }));
          return { panel: panel.toJSON(), parts, dds, vw: innerWidth };
        });
        for (const p of [...m.parts, ...m.dds]) {
          expect(p.right, `${p.s} right edge at ${width}x${height}`).toBeLessThanOrEqual(m.panel.right + 0.5);
          expect(p.left, `${p.s} left edge at ${width}x${height}`).toBeGreaterThanOrEqual(m.panel.left - 0.5);
          expect(p.bottom, `${p.s} bottom at ${width}x${height}`).toBeLessThanOrEqual(m.panel.bottom + 0.5);
        }
        expect(m.panel.right).toBeLessThanOrEqual(m.vw);
      } finally { await page.close(); }
    });
});

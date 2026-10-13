// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/**
 * Task 32 layout review on the tablet in portrait (Chrome 602x795, full screen 602x962): a grid card's state line
 * ("NEEDS YOU 38%", "COMPACTING 88%") stayed on one line and ran past the card's right edge. The word and the
 * context figure must stay inside the card and never overlap, in portrait and in landscape.
 */
const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const base = { host: 'desk', account: 'a', cwd: '/', live: true, overContext: false, hostOnline: true, lastSeen: 0, stateSince: Date.now() - 4 * 60_000 };
const sessions = [
  { name: 'lantern-docs', state: 'needs-you', question: 'Should I also update the changelog?', tmux: 'desk:@1.%1', contextPct: 38 },
  { name: 'tidepool-ui', state: 'needs-you', question: 'Allow Bash: npm run build?', tmux: 'desk:@2.%2', contextPct: 100 },
  { name: 'ember-sync', state: 'compacting', contextPct: 88 },
  { name: 'orchard-api', state: 'working', currentAction: 'Bash: npm test', contextPct: 46 },
  { name: 'pebble-cli', state: 'asleep', contextPct: 22 },
  { name: 'riverbank-etl', state: 'limit', contextPct: 57 },
  { name: 'old-prototype', state: 'stopped', contextPct: 31 },
].map((s, i) => ({ ...base, key: `desk:a:s${i}`, sessionId: `s${i}`, pid: i + 1, ...s }));
const board = { sessions, usage: [], accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk' }], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0 } as unknown as BoardState;

function html(): string {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  renderBoard(root, board, { meters: 'rings', layout: 'grid' });
  return root.outerHTML;
}

describe.skipIf(!CHROMIUM)('grid card state line', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  it.each([[602, 795], [602, 962], [601, 800], [961, 601], [961, 480], [800, 480], [1280, 800]])(
    'at %ix%i the status word and the context figure stay inside every card and apart', async (width, height) => {
      const page = await browser.newPage({ viewport: { width, height } });
      try {
        await page.setContent(`<style>${css}</style>${html()}`);
        const cards = await page.evaluate(() => [...document.querySelectorAll('.gcard')].map((c) => {
          const r = (e: Element) => e.getBoundingClientRect().toJSON() as DOMRect;
          return { key: (c as HTMLElement).dataset.key, card: r(c), word: r(c.querySelector('.gstate .word')!), ctx: r(c.querySelector('.gctx')!) };
        }));
        expect(cards.length).toBe(sessions.length);
        for (const c of cards) {
          for (const [n, b] of [['word', c.word], ['figure', c.ctx]] as const) {
            expect(b.right, `${c.key} ${n} right edge at ${width}x${height}`).toBeLessThanOrEqual(c.card.right + 0.5);
            expect(b.bottom, `${c.key} ${n} bottom at ${width}x${height}`).toBeLessThanOrEqual(c.card.bottom + 0.5);
          }
          const apart = c.word.right <= c.ctx.left + 0.5 || c.word.bottom <= c.ctx.top + 0.5;
          expect(apart, `${c.key} word and figure overlap at ${width}x${height}`).toBe(true);
        }
      } finally { await page.close(); }
    });
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { rowActionsHtml } from '../web/src/row-actions.js';
import { COUNT_FILTERS, type CountFilter } from '../web/src/filter.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/** Spec §5.1 (UI round 4): each stopped row and card has Clear; the stopped filter has Clear all stopped. */
const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
const base = { host: 'desk', account: 'a', cwd: '/', live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, stateSince: Date.now() - 4 * 60_000 };
const sessions = [
  { name: 'needs', state: 'needs-you', question: 'Allow Bash: npm run build?', tmux: 'desk:@2.%2' },
  { name: 'working', state: 'working', currentAction: 'Bash: npm test' },
  { name: 'asleep', state: 'asleep' },
  { name: 'compacting', state: 'compacting' },
  { name: 'limit', state: 'limit' },
  { name: 'stopped-one', state: 'stopped', live: false },
  { name: 'stopped-two', state: 'stopped', live: false, hostOnline: false },
].map((s, i) => ({ ...base, key: `desk:a:s${i}`, sessionId: `s${i}`, pid: i + 1, ...s }));
const board = { sessions, usage: [], accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk' }], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0 } as unknown as BoardState;

function draw(layout: 'strips' | 'grid', filter: CountFilter | null = null): HTMLElement {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  renderBoard(root, board, { meters: 'rings', layout, filter });
  return root;
}

describe('Clear buttons', () => {
  it('rowActionsHtml gives Clear to stopped sessions only (offline too: hiding is the daemon\'s own)', () => {
    for (const s of sessions) {
      const h = rowActionsHtml(s as any);
      expect(h.includes('data-act="clear"'), s.name).toBe(s.state === 'stopped');
    }
    expect(rowActionsHtml(sessions[5] as any)).toContain(`data-key="${sessions[5].key}"`);
  });
  for (const layout of ['strips', 'grid'] as const) {
    it(`${layout}: Clear sits on stopped items only`, () => {
      const root = draw(layout);
      const items = [...root.querySelectorAll<HTMLElement>(layout === 'grid' ? '.gcard' : '.row')];
      expect(items).toHaveLength(sessions.length);
      for (const el of items) expect(!!el.querySelector('[data-act="clear"]'), el.className).toBe(el.classList.contains('st-stopped'));
    });
    it(`${layout}: Clear all stopped shows only under the stopped filter, and not when it is empty`, () => {
      for (const f of [null, ...COUNT_FILTERS]) {
        const root = draw(layout, f);
        expect(root.querySelectorAll('[data-act="clear-stopped"]').length, String(f)).toBe(f === 'stopped' ? 1 : 0);
      }
      const empty = { ...board, sessions: sessions.filter((s) => s.state !== 'stopped') } as unknown as BoardState;
      document.body.innerHTML = '<div id="app"></div>';
      const root = document.getElementById('app')!;
      renderBoard(root, empty, { meters: 'rings', layout, filter: 'stopped' });
      expect(root.querySelector('[data-act="clear-stopped"]')).toBeNull();
      expect(root.querySelector('.empty')?.textContent).toBe('No sessions stopped');
    });
  }
  it('the Clear all bar survives a re-render and leaves when the filter does', () => {
    const root = draw('strips', 'stopped');
    renderBoard(root, board, { meters: 'rings', layout: 'strips', filter: 'stopped' });
    expect(root.querySelectorAll('[data-act="clear-stopped"]').length).toBe(1);
    expect(root.querySelector('main.list')!.firstElementChild!.querySelector('[data-act="clear-stopped"]')).not.toBeNull();
    renderBoard(root, board, { meters: 'rings', layout: 'strips', filter: null });
    expect(root.querySelector('[data-act="clear-stopped"]')).toBeNull();
  });
});

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;
const inside = (p: Box, o: Box) => p.x >= o.x - 0.5 && p.y >= o.y - 0.5 && p.x + p.w <= o.x + o.w + 0.5 && p.y + p.h <= o.y + o.h + 0.5;

describe.skipIf(!CHROMIUM)('Clear layout (real CSS in Chromium)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  for (const layout of ['strips', 'grid'] as const) {
    it.each([[961, 601], [961, 480], [800, 480], [601, 961]])(`${layout}: Clear fits its stopped item without touching the other cells at %ix%i`, async (w, h) => {
      const page = await browser.newPage({ viewport: { width: w, height: h } });
      try {
        await page.setContent(`<style>${css}</style>${draw(layout, 'stopped').outerHTML}`);
        const r = await page.evaluate((sel) => {
          const box = (e: Element | null) => { if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
          return {
            all: box(document.querySelector('[data-act="clear-stopped"]')),
            list: box(document.querySelector('main.list')),
            items: [...document.querySelectorAll(sel)].map((el) => ({
              item: box(el)!, btn: box(el.querySelector('[data-act="clear"]'))!,
              others: [...el.querySelectorAll(':scope .char, :scope .name, :scope .action, :scope .ctx, :scope .age, :scope .word, :scope .gctx')].map(box),
            })),
          };
        }, layout === 'grid' ? '.gcard' : '.row');
        expect(r.items).toHaveLength(2);
        expect(r.all, 'Clear all stopped').not.toBeNull();
        expect(r.all!.h, 'Clear all is a 44 px tap target').toBeGreaterThanOrEqual(44);
        expect(inside(r.all!, r.list!), 'Clear all inside the list').toBe(true);
        for (const i of r.items) {
          expect(inside(i.btn, i.item), 'Clear inside its item').toBe(true);
          expect(i.btn.h, 'Clear tap target').toBeGreaterThanOrEqual(40);
          for (const o of i.others) expect(overlap(o!, i.btn), 'Clear overlaps a cell').toBe(false);
          expect(overlap(r.all!, i.item), 'Clear all overlaps a row').toBe(false);
        }
      } finally { await page.close(); }
    });
  }
});

// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/**
 * Spec §5.1, UI round 4: every row's character is the same size whatever the state (a needs-you row is taller, its
 * character is not bigger), and the needs-you row lays out its question, Open button and status word cleanly.
 * Task 36: the question bubble is the answer control (no separate Answer button), with a hit box of at least 48×48.
 * The board is drawn here (happy-dom) and measured in a real Chromium with the real CSS.
 */
const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

const LONG = 'Should I also update the changelog and the migration notes for the 2.0 release, or leave both for the release PR that Sam is preparing next week? The notes are already half written.';
const base = { host: 'desk', account: 'a', cwd: '/', live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, stateSince: Date.now() - 4 * 60_000 };
const sessions = [
  { name: 'long-q', state: 'needs-you', question: LONG, tmux: 'desk:@1.%1' },
  { name: 'short-q', state: 'needs-you', question: 'Allow Bash: npm run build?', tmux: 'desk:@2.%2' },
  { name: 'no-tmux', state: 'needs-you', question: 'Which database should the importer write to?', bridgeSessionId: 'session_x' },
  { name: 'working', state: 'working', currentAction: 'Bash: npm test' },
  { name: 'asleep', state: 'asleep' },
  { name: 'compacting', state: 'compacting' },
  { name: 'limit', state: 'limit' },
  { name: 'stopped', state: 'stopped' },
].map((s, i) => ({ ...base, key: `desk:a:s${i}`, sessionId: `s${i}`, pid: i + 1, ...s }));
const board = { sessions, usage: [], accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk' }], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0 } as unknown as BoardState;

function html(layout: 'strips' | 'grid'): string {
  document.body.innerHTML = '<div id="app"></div>';
  const root = document.getElementById('app')!;
  renderBoard(root, board, { meters: 'rings', layout });
  return root.outerHTML;
}

type Box = { x: number; y: number; w: number; h: number };
const overlap = (a: Box, b: Box) => Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) > 0.5 && Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) > 0.5;

describe.skipIf(!CHROMIUM)('rows and cards (spec §5.1, UI round 4)', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  const measure = async (layout: 'strips' | 'grid', width: number, height: number) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      await page.setContent(`<style>${css}</style>${html(layout)}`);
      return await page.evaluate((sel) => {
        const box = (e: Element | null) => { if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; };
        return [...document.querySelectorAll(sel)].map((el) => ({
          state: [...el.classList].find((c) => c.startsWith('st-'))!,
          item: box(el)!,
          char: box(el.querySelector('.char'))!,
          question: box(el.querySelector('.action')),
          button: box(el.querySelector('.answer-btn')),
          tmux: el.dataset.key !== 'desk:a:s2',
          bubble: box(el.querySelector('button.action[data-act="answer"]')),
          word: box(el.querySelector('.word')),
          // the status word's text itself, so an element that also holds the button cannot hide an overlap
          wordText: (() => { const w = el.querySelector('.word'); const t = w && [...w.childNodes].find((n) => n.nodeType === 3 && n.textContent!.trim()); if (!t) return null; const rg = document.createRange(); rg.selectNodeContents(t); const r = rg.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })(),
          name: box(el.querySelector('.name')),
          questionAlign: el.querySelector('.action') ? getComputedStyle(el.querySelector('.action')!).textAlign : '',
        }));
      }, layout === 'grid' ? '.gcard' : '.row');
    } finally { await page.close(); }
  };

  for (const layout of ['strips', 'grid'] as const) {
    it(`${layout}: every character box is the same size and square, whatever the state`, async () => {
      for (const [w, h] of [[961, 601], [800, 480]]) {
        const items = await measure(layout, w, h);
        expect(items).toHaveLength(sessions.length);
        const ref = items.find((i) => i.state === 'st-working')!.char;
        expect(ref.w).toBeGreaterThan(20);
        for (const i of items) {
          expect(Math.abs(i.char.w - ref.w), `${i.state} width at ${w}x${h}`).toBeLessThanOrEqual(1);
          expect(Math.abs(i.char.h - ref.h), `${i.state} height at ${w}x${h}`).toBeLessThanOrEqual(1);
          expect(Math.abs(i.char.w - i.char.h), `${i.state} square at ${w}x${h}`).toBeLessThanOrEqual(1);
        }
      }
    });

    it.each([[961, 601], [961, 480], [800, 480]])(`${layout}: a needs-you item's question, button and status word never overlap at %ix%i`, async (w, h) => {
      const items = (await measure(layout, w, h)).filter((i) => i.state === 'st-needs-you');
      expect(items).toHaveLength(3);
      for (const i of items) {
        // a session in tmux answers through its question bubble; one without tmux keeps its Open button
        const parts: Record<string, Box> = i.tmux ? { question: i.question!, word: i.wordText ?? i.word! } : { question: i.question!, button: i.button!, word: i.wordText ?? i.word! };
        if (i.tmux) expect(i.button, 'no separate Answer button').toBeNull(); else expect(i.button, 'Open button').not.toBeNull();
        if (i.wordText) expect(i.word!.h, 'the status word box holds only the word').toBeLessThanOrEqual(i.wordText.h + 4);
        const names = Object.keys(parts);
        for (let a = 0; a < names.length; a++) for (let b = a + 1; b < names.length; b++)
          expect(overlap(parts[names[a]], parts[names[b]]), `${names[a]} overlaps ${names[b]}`).toBe(false);
        // the word box holding the button counts as crammed too
        if (i.button) expect(overlap(i.word!, i.button), 'word box overlaps button').toBe(false);
        if (i.tmux) expect(overlap(i.word!, i.question!), 'word box overlaps the bubble').toBe(false);
        for (const [n, p] of Object.entries(parts)) {
          expect(p.x, `${n} inside the item`).toBeGreaterThanOrEqual(i.item.x - 0.5);
          expect(p.x + p.w, `${n} inside the item`).toBeLessThanOrEqual(i.item.x + i.item.w + 0.5);
          expect(p.y, `${n} inside the item`).toBeGreaterThanOrEqual(i.item.y - 0.5);
          expect(p.y + p.h, `${n} inside the item`).toBeLessThanOrEqual(i.item.y + i.item.h + 0.5);
        }
        // the question is centred and uses the text area's full width: from the name's left edge, past the middle
        expect(i.questionAlign).toBe('center');
        expect(Math.abs(i.question!.x - i.name!.x), 'question starts where the name does').toBeLessThanOrEqual(2);
        if (layout === 'strips') expect(i.question!.w, 'question spans the text area').toBeGreaterThan(i.item.w * 0.55);
      }
    });

    it.each([[961, 601], [601, 961], [961, 480], [800, 480], [480, 800]])(`${layout}: the question bubble is the answer button, at least 48×48 CSS px, at %ix%i`, async (w, h) => {
      const items = (await measure(layout, w, h)).filter((i) => i.state === 'st-needs-you' && i.tmux);
      expect(items).toHaveLength(2);
      for (const i of items) {
        expect(i.bubble, 'the bubble is a button').not.toBeNull();
        expect(i.bubble!.w, 'hit box width').toBeGreaterThanOrEqual(48);
        expect(i.bubble!.h, 'hit box height').toBeGreaterThanOrEqual(48);
        expect(i.bubble!.y + i.bubble!.h, 'bubble inside the item').toBeLessThanOrEqual(i.item.y + i.item.h + 0.5);
      }
    });
  }
});

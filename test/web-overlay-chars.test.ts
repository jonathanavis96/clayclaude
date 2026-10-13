import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { shellHtml as focusShell, minisHtml } from '../web/src/focus-view.js';
import { focusModel } from '../web/src/focus-model.js';
import { shellHtml as launcherShell, type LView } from '../web/src/launcher-view.js';
import { initialLauncher } from '../web/src/launcher-model.js';
import type { Session } from '../src/types.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');
// the inline style the clay sprite gives its canvas (absolutely positioned, filling its slot)
const canvasCss = /this\.canvas\.style\.cssText = '([^']+)'/.exec(readFileSync(join(ROOT, 'web', 'src', 'clay', 'sprite.ts'), 'utf8'))?.[1] ?? '';

const session = { key: 'local:a:s', host: 'local', account: 'a', sessionId: 's', pid: 1, name: 'riverbank-etl', state: 'limit', hostOnline: true } as unknown as Session;
const launcher: LView = {
  opts: { accounts: ['a', 'b', 'c'].map((id) => ({ id, label: id, colour: '#e8b54a', host: 'desk', canLaunch: true, models: ['opus'], efforts: ['high'], remoteControl: true })) } as LView['opts'],
  repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }], st: { ...initialLauncher(), account: 'a' }, usage: [], busy: false,
};

describe.skipIf(!CHROMIUM)('overlay character slots', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  it('reads the sprite canvas style', () => { expect(canvasCss).toContain('position:absolute'); });

  // Found on the tablet (Task 23): the focus view's large character filled the whole modal, because its slot
  // was not a containing block for the absolutely positioned canvas. Every overlay slot must contain its canvas.
  it.each([
    ['focus view', `<section class="focus modal">${focusShell(focusModel(session, null, 0, 'A'))}</section>`, '#f-char', '#f-minis', minisHtml([{ key: 'k', name: 'n', state: 'working' }])],
    ['launcher', `<section class="launcher modal">${launcherShell(launcher)}</section>`, '.acct-char', null, ''],
  ])('the %s keeps every character canvas inside its slot', async (_name, html, slotSel, minisSel, minis) => {
    const page = await browser.newPage({ viewport: { width: 961, height: 601 } });
    try {
      await page.setContent(`<style>${css}</style><div id="overlays" style="position:fixed;inset:0">${html}</div>`);
      const rects = await page.evaluate(({ slotSel, minisSel, minis, canvasCss }) => {
        if (minisSel) document.querySelector(minisSel)!.innerHTML = minis;
        const slots = [...document.querySelectorAll<HTMLElement>(`${slotSel}, .mini-char`)];
        return slots.map((slot) => {
          const c = document.createElement('canvas');
          c.style.cssText = canvasCss;
          slot.appendChild(c);
          const a = slot.getBoundingClientRect(), b = c.getBoundingClientRect();
          return { cls: slot.className, slot: [a.left, a.top, a.width, a.height].map(Math.round), canvas: [b.left, b.top, b.width, b.height].map(Math.round) };
        });
      }, { slotSel, minisSel, minis, canvasCss });
      expect(rects.length).toBeGreaterThan(0);
      for (const r of rects) {
        expect(r.slot[2]).toBeGreaterThan(0);
        expect(r.canvas, r.cls).toEqual(r.slot);
      }
    } finally { await page.close(); }
  });

  // Also found on the tablet: the board's row dimming (.st-limit, .st-stopped) leaked onto the focus panel, so the
  // board showed through a limited or stopped session's focus view. Row state styles belong to rows only.
  it.each(['limit', 'stopped', 'needs-you'])('a %s focus panel is opaque and keeps its own size', async (state) => {
    const page = await browser.newPage({ viewport: { width: 961, height: 601 } });
    try {
      const v = focusModel({ ...session, state } as Session, null, 0, 'A');
      await page.setContent(`<style>${css}</style><div id="overlays" style="position:fixed;inset:0"><section class="focus modal">${focusShell(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const p = document.querySelector('.focus-panel')!;
        const cs = getComputedStyle(p);
        return { opacity: cs.opacity, height: Math.round(p.getBoundingClientRect().height), modal: Math.round(document.querySelector('.modal')!.getBoundingClientRect().height) };
      });
      expect(m.opacity).toBe('1');
      expect(m.height).toBeGreaterThan(m.modal * 0.85);
    } finally { await page.close(); }
  });

  // Found on the tablet in a Chrome tab (about 961x480 CSS px under the address bar): Open and Attach sat below a long
  // summary and needed a scroll inside the card. The buttons stay in view; the summary scrolls instead.
  it.each([[961, 480], [961, 601], [800, 480]])('keeps the focus buttons in view at %ix%i', async (width, height) => {
    const page = await browser.newPage({ viewport: { width, height } });
    try {
      const long = 'Move the staging config into modules and check the plan shows no drift before applying anything to production. '.repeat(3);
      const sum = { lastPrompt: long, lastAssistantText: long, files: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'], tools: [], toolCount: 0, tokensIn: 0, tokensOut: 0 };
      const v = focusModel({ ...session, state: 'working', tmux: 'w:@1.%1', bridgeSessionId: 'session_x' } as Session, sum, 0, 'A');
      await page.setContent(`<style>${css}</style><div id="overlays" style="position:fixed;inset:0"><section class="focus modal">${focusShell(v)}</section></div>`);
      const m = await page.evaluate(() => {
        const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
        return { card: r('.focus-panel .card').bottom, btns: r('#f-btns').bottom, n: document.querySelectorAll('#f-btns button').length };
      });
      expect(m.n).toBe(2);
      expect(m.btns).toBeLessThanOrEqual(m.card + 0.5);
    } finally { await page.close(); }
  });
});

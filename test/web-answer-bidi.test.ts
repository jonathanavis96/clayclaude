import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Browser } from 'playwright-core';
import { renderSheet } from '../web/src/answer-view.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

/*
 * The answer sheet shows text from the session's screen as the terminal shows it. A terminal (tmux) has no bidi: it
 * draws every character in the order it was written, and an invisible format character (U+202E RIGHT-TO-LEFT OVERRIDE,
 * an isolate, a mark) draws nothing. A browser applies the Unicode bidi algorithm, so the same characters would reorder
 * the text around them: "cat notes.txt <U+202E>; rm -rf ~ #" could read on the tablet as a harmless line while the PC shows
 * "; rm -rf ~". So the sheet shows every invisible format character as a visible marker, and lays text out left to right
 * in the order it was written, never reordered.
 */
const RLO = '\u202E', LRI = '\u2066', PDI = '\u2069', RLM = '\u200F', ALM = '\u061C';
const SPOOF = `cat notes.txt ${RLO}; rm -rf ~ #`;
const HEBREW = 'שלום ; rm -rf ~ # עולם';
const session = { key: 'k', name: 'orchard', account: 'studio', host: 'desk' } as any;
const perm = { kind: 'permission', hash: 'h', title: '', quickReplies: [],
  detail: `────────────────────────\n Bash command\n\n   ${SPOOF}\n   ${HEBREW}\n   a${LRI}b${PDI}c${RLM}d${ALM}e\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No`,
  options: [{ key: 'yes', label: 'Yes', selected: false }, { key: 'no', label: 'No', selected: false }] } as any;
const menu = { kind: 'menu', hash: 'm', title: `Pick ${RLO}eno`, detail: `Context ${RLO}txet`, quickReplies: [],
  options: [{ key: '1', label: `Keep ${RLO}ti`, selected: true, description: `Safe ${RLO}yas` }, { key: '2', label: 'Drop', selected: false }] } as any;
const BIDI = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

describe('answer sheet: invisible format characters are shown, never applied', () => {
  it('a permission prompt shows each one as a visible marker where it sits', () => {
    const h = renderSheet({ phase: 'ready', prompt: perm, context: { question: `Claude needs your permission ${RLO}` } }, session, [], '');
    expect(h).not.toMatch(BIDI);
    expect(h).toContain('cat notes.txt ⟨U+202E⟩; rm -rf ~ #');
    expect(h).toContain('a⟨U+2066⟩b⟨U+2069⟩c⟨U+200F⟩d⟨U+061C⟩e');
    expect(h).toContain(HEBREW);
  });
  it('so does a menu: its title, context, labels and descriptions, and the label confirmed before sending', () => {
    const h = renderSheet({ phase: 'ready', prompt: menu, context: { lastAssistantText: `Note ${RLO}eton` } }, session, [], '');
    expect(h).not.toMatch(BIDI);
    for (const s of ['Pick ⟨U+202E⟩eno', 'Context ⟨U+202E⟩txet', 'Keep ⟨U+202E⟩ti', 'Safe ⟨U+202E⟩yas', 'Note ⟨U+202E⟩eton']) expect(h).toContain(s);
    const c = renderSheet({ phase: 'confirm', prompt: menu, context: {}, pending: { choice: '1', label: `Keep ${RLO}ti` } }, session, [], '');
    expect(c).not.toMatch(BIDI);
    expect(c).toContain('Keep ⟨U+202E⟩ti');
  });
  it('the keys sent are untouched', () => {
    const h = renderSheet({ phase: 'ready', prompt: menu, context: {} }, session, [], '');
    expect([...h.matchAll(/data-key="([^"]*)"/g)].map((m) => m[1])).toEqual(['1', '2']);
  });
});

const css = ['style.css', 'overlay.css'].map((f) => readFileSync(join(ROOT, 'web', 'src', f), 'utf8')).join('\n');

describe.skipIf(!CHROMIUM)('answer sheet in a browser: text is laid out in the order it was written, as a terminal does', () => {
  let browser: Browser;
  beforeAll(async () => { browser = await launch(); });
  afterAll(async () => { await browser?.close(); });

  /** For each needle, whether every place it appears in the selected elements draws its characters left to right in written order. */
  async function order(html: string, sel: string, needles: string[]): Promise<Record<string, boolean>> {
    const page = await browser.newPage({ viewport: { width: 961, height: 601 } });
    try {
      await page.setContent(`<style>${css}</style><div id="overlays" style="position:fixed;inset:0"><section class="modal"><div class="sheet">${html}</div></section></div>`);
      return await page.evaluate(({ sel, needles }) => {
        const out: Record<string, boolean> = {};
        for (const el of document.querySelectorAll(sel)) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            const t = n.textContent ?? '';
            for (const needle of needles) {
              const at = t.indexOf(needle);
              if (at < 0) continue;
              const xs: number[] = [];
              for (let i = at; i < at + needle.length; i++) {
                if (/\s/.test(t[i])) continue;
                const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + 1);
                xs.push(r.getBoundingClientRect().left);
              }
              out[needle] = (out[needle] ?? true) && xs.length > 1 && xs.every((x, k) => k === 0 || x > xs[k - 1]);
            }
          }
        }
        return out;
      }, { sel, needles });
    } finally { await page.close(); }
  }

  it('a permission prompt: a spoofed override and right-to-left letters never reorder the command', async () => {
    // With a raw U+202E left in, Chromium draws "; rm -rf ~ #" reversed after "cat notes.txt", and the Hebrew line
    // starts at its right-hand word. The terminal draws both in written order.
    const h = renderSheet({ phase: 'ready', prompt: perm, context: {} }, session, [], '');
    const got = await order(h, 'pre.verbatim', ['cat notes.txt ⟨U+202E⟩; rm -rf ~ #', HEBREW]);
    expect(got).toEqual({ 'cat notes.txt ⟨U+202E⟩; rm -rf ~ #': true, [HEBREW]: true });
  });
  it('a menu label and its description, and the context above it, are laid out the same way', async () => {
    const rtl = { ...menu, title: HEBREW, detail: HEBREW, options: [{ key: '1', label: HEBREW, selected: true, description: HEBREW }] };
    const h = renderSheet({ phase: 'ready', prompt: rtl, context: { lastAssistantText: HEBREW } }, session, [], '');
    for (const sel of ['.ask', 'pre.detail', '.choice span', '.choice small', 'blockquote.last']) {
      expect(await order(h, sel, [HEBREW]), sel).toEqual({ [HEBREW]: true });
    }
  });
});

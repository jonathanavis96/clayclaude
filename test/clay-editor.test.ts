import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import type { Browser } from 'playwright-core';
import { POSE_KEYS } from '../web/src/clay/pose.js';
import { CHROMIUM, ROOT, launch, startWeb } from './helpers/browser.js';

const files = (dir: string): string[] => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : [p];
});

describe('pose editor (spec §7.4.7)', () => {
  it('is absent from the production build: no editor module, no Save endpoint (grep the bundle)', async () => {
    const out = mkdtempSync(join(tmpdir(), 'cc-webdist-'));
    await build({ configFile: join(ROOT, 'web', 'vite.config.ts'), build: { outDir: out, emptyOutDir: true }, logLevel: 'error' });
    const all = files(out).filter((f) => /\.(js|html|css)$/.test(f));
    expect(all.some((f) => f.endsWith('clay-lab.html'))).toBe(true);
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      expect(text.includes('clayclaude-pose-editor'), f).toBe(false);
      expect(text.includes('__clay/overrides'), f).toBe(false);
      expect(text.includes('mountEditor'), f).toBe(false);
    }
    expect(files(out).some((f) => /editor/i.test(f))).toBe(false);
  }, 180_000);

  describe.skipIf(!CHROMIUM)('in the dev server', () => {
    let web: Awaited<ReturnType<typeof startWeb>>;
    let browser: Browser;
    beforeAll(async () => { web = await startWeb(); browser = await launch(); }, 60_000);
    afterAll(async () => { await browser?.close(); await web?.close(); });

    it('the dev server mounts the Save endpoint, which refuses a bad body', async () => {
      const r = await fetch(`${web.url}/__clay/overrides`, { method: 'POST', body: JSON.stringify({ W9: {} }) });
      expect(r.status).toBe(400);
      expect((await fetch(`${web.url}/__clay/overrides`)).status).toBe(405);
    });

    it('previews a state live, edits a pose key and Saves the draft as JSON', async () => {
      const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      let posted: unknown;
      // never touch the real overrides.json from a test: answer the Save here
      await page.route('**/__clay/overrides', async (r) => { posted = JSON.parse(r.request().postData() ?? 'null'); await r.fulfill({ status: 200, body: '{"ok":true}' }); });
      await page.goto(`${web.url}/clay-lab.html?view=editor`);
      await page.waitForFunction('!!window.__editor', undefined, { timeout: 60_000 });
      expect(await page.evaluate(() => document.querySelectorAll('#clayclaude-pose-editor input[type=range]').length)).toBe(POSE_KEYS.length + 1); // + the scrubber
      const pixels = () => page.evaluate(() => {
        const c = document.querySelectorAll<HTMLCanvasElement>('#clayclaude-pose-editor canvas')[0];
        return Array.from(c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data).join(',');
      });
      await page.evaluate(() => { const e = (window as any).__editor; e.select('N1'); e.frame(0); });
      const before = await pixels();
      expect(before.split(',').some((v, i) => i % 4 === 3 && Number(v) > 0)).toBe(true);
      // drag handles for the props and glyphs on show (N1: the "?" bubble and its glyph)
      expect(await page.evaluate(() => document.querySelectorAll('#clayclaude-pose-editor div[title^="prop qbubble"], #clayclaude-pose-editor div[title^="glyph q"]').length)).toBe(2);
      await page.evaluate(() => (window as any).__editor.setDraft({ N1: { pose: { aRz: 0.15 } } }));
      expect(await pixels()).not.toBe(before);
      expect(await page.evaluate(() => (window as any).__editor.save())).toBe(200);
      expect(posted).toEqual({ N1: { pose: { aRz: 0.15 } } });
      expect(errors).toEqual([]);
      await page.close();
    }, 90_000);
  });
});

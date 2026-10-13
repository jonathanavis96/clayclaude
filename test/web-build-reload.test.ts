// Task 32, in a real browser against the real daemon server and a real production build: an open board tab whose
// daemon starts serving another build reloads itself once (not over an open sheet), and never loops when the reload
// still gets the old code. This is what kept the fixed focus-view bug on the tablet: tabs left running an old bundle.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import type { Browser } from 'playwright-core';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { CHROMIUM, ROOT, launch } from './helpers/browser.js';

const cfg = parseConfig('hosts: [{id: local}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]\n');
const fakes = () => ({ collector: Object.assign(new EventEmitter(), { sessions: () => [] }) as any,
  usage: Object.assign(new EventEmitter(), { usage: () => [], publicShape: () => ({}) }) as any });

describe.skipIf(!CHROMIUM)('an open tab and a new build', () => {
  const web = mkdtempSync(join(tmpdir(), 'cc-reload-'));
  let browser: Browser;
  beforeAll(async () => {
    await build({ configFile: join(ROOT, 'web', 'vite.config.ts'), build: { outDir: web, emptyOutDir: true }, logLevel: 'error' });
    browser = await launch();
  }, 120_000);
  afterAll(async () => { await browser?.close(); });

  it('reloads once when the daemon serves another build, waits while a sheet is open, and does not loop', async () => {
    let srv = await startServer({ cfg, ...fakes(), webRoot: web, port: 0 });
    const port = srv.port;
    try {
      const page = await browser.newPage({ viewport: { width: 961, height: 601 } });
      const logs: string[] = [];
      page.on('console', (m) => logs.push(m.text()));
      let loads = 0;
      page.on('load', () => { loads++; });
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForSelector('.cog');
      const stamp = JSON.parse(readFileSync(join(web, 'build.json'), 'utf8'));
      expect(logs.some((l) => l.includes(`clayclaude v${stamp.version} · ${stamp.commit}`))).toBe(true);   // logged at load
      expect(loads).toBe(1);

      // The settings sheet shows the page's build.
      await page.click('.cog');
      await page.waitForSelector('.settings .build');
      expect(await page.textContent('.settings .build')).toContain(stamp.commit);

      // The daemon is upgraded under the open tab: new build.json, restart on the same port.
      writeFileSync(join(web, 'build.json'), JSON.stringify({ ...stamp, builtAt: '2099-01-01T00:00:00.000Z' }));
      await srv.close();
      srv = await startServer({ cfg, ...fakes(), webRoot: web, port });
      await page.waitForTimeout(6000);                 // the board reconnects within 3 s and asks /api/version
      expect(loads).toBe(1);                           // the settings sheet is open: no reload under it
      await page.click('.settings [data-act="close"]');
      await page.waitForTimeout(3000);
      expect(loads).toBe(2);                           // closed: reloaded once
      // This reload still got the old JS (only build.json changed), so the page stays stale: it says so, no loop.
      await page.waitForTimeout(4000);
      expect(loads).toBe(2);
      expect(logs.some((l) => l.includes('the daemon serves v'))).toBe(true);
    } finally { await srv.close(); }
  }, 60_000);
});

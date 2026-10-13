import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { build } from 'vite';
import { createClayRoutes, playwrightLauncher, type ClayRoutes } from '../src/clay/routes.js';
import { RENDERER_VERSION } from '../web/src/clay/version.js';
import { CHROMIUM, ROOT } from './helpers/browser.js';

/** Spec §7.3 "Baked by PC", end to end: the real web build, the real routes, a real headless Chromium. */
describe.skipIf(!CHROMIUM)('PC baking end to end', () => {
  let srv: Server;
  let routes: ClayRoutes;
  let base: string;
  beforeAll(async () => {
    const webRoot = mkdtempSync(join(tmpdir(), 'cc-webdist-'));
    await build({ configFile: join(ROOT, 'web', 'vite.config.ts'), build: { outDir: webRoot, emptyOutDir: true }, logLevel: 'error' });
    routes = createClayRoutes({ webRoot, cacheDir: mkdtempSync(join(tmpdir(), 'cc-sheets-')), launcher: playwrightLauncher(CHROMIUM!), unavailable: async () => null });
    srv = createServer(async (req, res) => { if (!(await routes.handler(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  }, 120_000);
  afterAll(async () => { await routes?.close(); await new Promise((r) => srv?.close(r)); });

  it('serves a W2 sheet whose first frame matches the committed snapshot', async () => {
    const q = new URLSearchParams({ state: 'W2', puffed: '0', size: '96', shadows: '1', colour: 'e07a4f', v: RENDERER_VERSION });
    const res = await fetch(`${base}/clay/sheet?${q}`);
    expect(res.status).toBe(200);
    expect([res.headers.get('x-clay-frames'), res.headers.get('x-clay-cols')]).toEqual(['48', '8']);
    const sheet = PNG.sync.read(Buffer.from(await res.arrayBuffer()));
    expect([sheet.width, sheet.height]).toEqual([8 * 96, 6 * 96]);
    const f0 = new PNG({ width: 96, height: 96 });
    PNG.bitblt(sheet, f0, 0, 0, 96, 96, 0, 0);
    const want = PNG.sync.read(readFileSync(join(ROOT, 'test', 'snapshots', 'clay', 'W2-f0.png')));
    expect(pixelmatch(f0.data, want.data, null, 96, 96, { threshold: 0.1 })).toBeLessThanOrEqual(46);
  }, 120_000);

  it('refuses a sheet for another renderer version with 409', async () => {
    const q = new URLSearchParams({ state: 'W2', puffed: '0', size: '96', shadows: '1', colour: 'e07a4f', v: 'not-this-one' });
    expect((await fetch(`${base}/clay/sheet?${q}`)).status).toBe(409);
  }, 60_000);
});

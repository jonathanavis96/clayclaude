import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClayRoutes, type BakePage } from '../src/clay/routes.js';

// The PC baker's headless page closes after `idleCloseMs` without work. The idle timer an earlier request armed must
// not close the page under a bake that is still running (a slow sheet on a busy PC), which would fail that request.
describe('PC baker idle close', () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  it('never closes the page while a bake is running, and still closes it once idle', async () => {
    let baking = 0, closedWhileBaking = false, closes = 0;
    const page: BakePage = {
      version: 'v1',
      async sheet(k) {
        baking++;
        await new Promise((r) => setTimeout(r, k.state === 'W3' ? 250 : 0));
        baking--;
        return { png: Buffer.from('PNG'), frames: 48, cols: 8 };
      },
      async close() { closes++; if (baking) closedWhileBaking = true; },
    };
    const routes = createClayRoutes({ webRoot: '/nowhere', cacheDir: mkdtempSync(join(tmpdir(), 'cc-idle-')), launcher: async () => page, unavailable: async () => null, idleCloseMs: 80 });
    srv = createServer(async (req, res) => { if (!(await routes.handler(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(418); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}/clay/sheet?puffed=0&size=96&shadows=1&colour=e07a4f&v=v1&state=`;
    expect((await fetch(base + 'W2')).status).toBe(200);          // arms the idle timer (80 ms)
    expect((await fetch(base + 'W3')).status).toBe(200);          // a 250 ms bake: outlives that timer
    expect(closedWhileBaking).toBe(false);
    await new Promise((r) => setTimeout(r, 200));
    expect(closes).toBe(1);                                       // idle after the last bake: closed once
    await routes.close();
  });
});

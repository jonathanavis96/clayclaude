// Release QA round 2, security track: written before its fix.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClayRoutes, type BakePage } from '../src/clay/routes.js';

describe('/clay/sheet: bounded work and disk', () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? (srv.closeAllConnections(), srv.close(() => r())) : r())));
  const q = (colour: string) => `/clay/sheet?state=W2&puffed=0&size=96&shadows=1&colour=${colour}&v=abc123`;

  async function boot(page: BakePage, o: { maxCachedSheets?: number; maxQueued?: number }) {
    const cacheDir = mkdtempSync(join(tmpdir(), 'cc-sheets-'));
    const routes = createClayRoutes({ webRoot: '/nowhere', cacheDir, launcher: async () => page, unavailable: async () => null, ...o });
    srv = createServer(async (req, res) => {
      if (!(await routes.handler(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(418); res.end(); }
    });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    return { base: `http://127.0.0.1:${(srv.address() as { port: number }).port}`, cacheDir, routes };
  }

  // Any 6-digit colour is a valid key, so without a bound a client (or the colour picker) fills the disk one sheet at a time.
  it('keeps at most maxCachedSheets sheets on disk, dropping the oldest', async () => {
    let bakes = 0;
    const page: BakePage = { version: 'abc123', async sheet() { bakes++; return { png: Buffer.from('PNG'), frames: 48, cols: 8 }; }, async close() {} };
    const { base, cacheDir, routes } = await boot(page, { maxCachedSheets: 3 });
    for (const c of ['000001', '000002', '000003', '000004', '000005']) expect((await fetch(base + q(c))).status).toBe(200);
    const pngs = readdirSync(cacheDir).filter((f) => f.endsWith('.png'));
    expect(pngs.length).toBe(3);
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length).toBe(3);
    expect(pngs.some((f) => f.includes('000005'))).toBe(true);
    const before = bakes;
    expect((await fetch(base + q('000005'))).status).toBe(200);
    expect(bakes).toBe(before); // the newest is still served from disk
    await routes.close();
  });

  it('refuses new bakes past maxQueued instead of queueing without end', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const page: BakePage = { version: 'abc123', async sheet() { await gate; return { png: Buffer.from('PNG'), frames: 48, cols: 8 }; }, async close() {} };
    const { base, routes } = await boot(page, { maxQueued: 2 });
    const a = fetch(base + q('00000a')), b = fetch(base + q('00000b'));
    await new Promise((r) => setTimeout(r, 50));
    const c = await fetch(base + q('00000c'));
    expect(c.status).toBe(503);
    const again = fetch(base + q('00000a')); // the same sheet joins its job, never refused
    release();
    expect((await a).status).toBe(200);
    expect((await b).status).toBe(200);
    expect((await again).status).toBe(200);
    await routes.close();
  });
});

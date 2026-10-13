import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PC_SIZES, PC_STATES, createClayRoutes, parseSheetQuery, type BakePage, type PcKey } from '../src/clay/routes.js';
import { CLAY_STATES } from '../web/src/clay/states.js';
import { SIZE_BUCKETS } from '../web/src/clay/sheet.js';

const q = (o: Record<string, string>) => new URLSearchParams({ state: 'W2', puffed: '0', size: '96', shadows: '1', colour: 'e07a4f', v: 'abc123', ...o });

describe('parseSheetQuery', () => {
  it('accepts a valid key', () => {
    expect(parseSheetQuery(q({}))).toEqual({ state: 'W2', puffed: false, size: 96, shadows: true, colour: '#e07a4f', version: 'abc123' });
  });
  it('refuses anything else before it reaches a file name or the browser', () => {
    expect(parseSheetQuery(q({ state: 'W9' }))).toBe('unknown state');
    expect(parseSheetQuery(q({ size: '97' }))).toBe('unsupported size');
    expect(parseSheetQuery(q({ colour: '../../x' }))).toBe('colour must be 6 hex digits');
    expect(parseSheetQuery(q({ puffed: 'yes' }))).toBe('puffed and shadows must be 0 or 1');
    expect(parseSheetQuery(q({ v: '../etc' }))).toBe('bad version');
  });
  it('the daemon lists match the renderer lists', () => {
    expect([...PC_STATES]).toEqual([...CLAY_STATES]);
    expect([...PC_SIZES]).toEqual([...SIZE_BUCKETS]);
  });
});

describe('/clay routes', () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  async function boot(o: { unavailable?: string | null; version?: string } = {}) {
    const calls: PcKey[] = [];
    let launches = 0;
    const page: BakePage = {
      version: o.version ?? 'abc123',
      async sheet(k) { calls.push(k); return { png: Buffer.from('PNGDATA'), frames: 48, cols: 8 }; },
      async close() {},
    };
    const routes = createClayRoutes({
      webRoot: '/nowhere', cacheDir: mkdtempSync(join(tmpdir(), 'cc-sheets-')),
      launcher: async () => { launches++; return page; },
      unavailable: async () => o.unavailable ?? null,
    });
    srv = createServer(async (req, res) => {
      const url = new URL(req.url!, 'http://x');
      if (!(await routes.handler(req, res, url))) { res.writeHead(418); res.end(); }
    });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    return { base, calls, launches: () => launches, routes };
  }

  it('reports whether this PC can bake', async () => {
    expect(await (await fetch((await boot()).base + '/clay/status')).json()).toEqual({ pc: true });
    srv!.close(); srv = undefined;
    expect(await (await fetch((await boot({ unavailable: 'playwright-core is not installed' })).base + '/clay/status')).json())
      .toEqual({ pc: false, reason: 'playwright-core is not installed' });
  });

  it('bakes a sheet once, then serves it from the disk cache', async () => {
    const b = await boot();
    const r1 = await fetch(`${b.base}/clay/sheet?${q({})}`);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('content-type')).toBe('image/png');
    expect([r1.headers.get('x-clay-frames'), r1.headers.get('x-clay-cols')]).toEqual(['48', '8']);
    expect(Buffer.from(await r1.arrayBuffer()).toString()).toBe('PNGDATA');
    const r2 = await fetch(`${b.base}/clay/sheet?${q({})}`);
    expect(r2.status).toBe(200);
    expect(b.calls).toHaveLength(1);
    expect(b.launches()).toBe(1);
    await b.routes.close();
  });

  it('answers 400 for a bad query, 404 when it cannot bake, 409 for another renderer version', async () => {
    const b = await boot();
    expect((await fetch(`${b.base}/clay/sheet?${q({ state: 'nope' })}`)).status).toBe(400);
    expect((await fetch(`${b.base}/clay/sheet?${q({ v: 'other1' })}`)).status).toBe(409);
    expect((await fetch(`${b.base}/clay/nothing`)).status).toBe(404);
    expect((await fetch(`${b.base}/api/state`)).status).toBe(418); // not ours: falls through
    const g = await fetch(`${b.base}/gallery`, { redirect: 'manual' });  // spec §7.4.6
    expect([g.status, g.headers.get('location')]).toEqual([302, '/clay-lab.html?view=gallery']);
    srv!.close(); srv = undefined;
    const u = await boot({ unavailable: 'no Chromium or Chrome found (set CLAYCLAUDE_CHROMIUM)' });
    const r = await fetch(`${u.base}/clay/sheet?${q({})}`);
    expect(r.status).toBe(404);
    expect((await r.json()).error).toContain('no Chromium');
  });

  it('a bake that fails or hangs closes its page, and the next request launches a fresh one', async () => {
    let launches = 0;
    let closed = 0;
    const modes = ['throw', 'hang', 'ok'];
    const routes = createClayRoutes({
      webRoot: '/nowhere', cacheDir: mkdtempSync(join(tmpdir(), 'cc-sheets-')), bakeTimeoutMs: 50,
      unavailable: async () => null,
      launcher: async () => {
        const mode = modes[launches++];
        return {
          version: 'abc123',
          async sheet() {
            if (mode === 'throw') throw new Error('context lost');
            if (mode === 'hang') return new Promise<never>(() => {});
            return { png: Buffer.from('PNGDATA'), frames: 48, cols: 8 };
          },
          async close() { closed++; },
        } satisfies BakePage;
      },
    });
    srv = createServer(async (req, res) => { if (!(await routes.handler(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(418); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    expect((await fetch(`${base}/clay/sheet?${q({})}`)).status).toBe(404);
    expect((await fetch(`${base}/clay/sheet?${q({})}`)).status).toBe(404);
    expect((await fetch(`${base}/clay/sheet?${q({})}`)).status).toBe(200);
    expect([launches, closed]).toEqual([3, 2]);
    await routes.close();
    expect(closed).toBe(3);
  });

  it('answers 405 to anything but GET, and never bakes for it', async () => {
    const b = await boot();
    expect((await fetch(`${b.base}/clay/sheet?${q({})}`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${b.base}/clay/status`, { method: 'DELETE' })).status).toBe(405);
    expect(b.calls).toHaveLength(0);
  });
});

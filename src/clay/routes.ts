import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import type { RouteHandler } from '../server.js';
import { CHROMIUM_ARGS, findChromium } from './chromium.js';

/** Kept equal to web/src/clay/states.ts and sheet.ts by test/clay-routes.test.ts (the daemon cannot import web code). */
export const PC_STATES = [
  'W1', 'W2', 'W3', 'W4', 'W5', 'W6', 'W7',
  'N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7',
  'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7',
  'X1', 'X2', 'X3', 'X4',
  'L1',
] as const;
export const PC_SIZES = [48, 64, 80, 96, 112, 128, 144, 160, 192, 224, 256, 320] as const;

export interface PcKey { state: string; puffed: boolean; size: number; shadows: boolean; colour: string; version: string }
export interface BakedPng { png: Buffer; frames: number; cols: number }

/** Validates GET /clay/sheet's query. Returns the key, or the reason it is refused. Pure. */
export function parseSheetQuery(q: URLSearchParams): PcKey | string {
  const state = q.get('state') ?? '';
  const size = Number(q.get('size'));
  const colour = (q.get('colour') ?? '').toLowerCase();
  const version = q.get('v') ?? '';
  if (!(PC_STATES as readonly string[]).includes(state)) return 'unknown state';
  if (!(PC_SIZES as readonly number[]).includes(size)) return 'unsupported size';
  if (!/^[0-9a-f]{6}$/.test(colour)) return 'colour must be 6 hex digits';
  if (!['0', '1'].includes(q.get('puffed') ?? '') || !['0', '1'].includes(q.get('shadows') ?? '')) return 'puffed and shadows must be 0 or 1';
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(version)) return 'bad version';
  return { state, puffed: q.get('puffed') === '1', size, shadows: q.get('shadows') === '1', colour: `#${colour}`, version };
}

export const cacheName = (k: PcKey) => `${k.state}-${k.puffed ? 'p' : 'n'}-${k.size}-${k.shadows ? 's' : 'f'}-${k.colour.slice(1)}-${k.version}`;

/** A headless page running web/clay-bake.html. */
export interface BakePage { version: string; sheet(k: PcKey): Promise<BakedPng>; close(): Promise<void> }
export type PageLauncher = (webRoot: string) => Promise<BakePage>;

const ORIGIN = 'http://clayclaude.bake';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

type Pw = { chromium: { launch(o: object): Promise<PwBrowser> } };
interface PwBrowser { newPage(): Promise<PwPage>; close(): Promise<void> }
interface PwPage {
  route(url: string, fn: (r: { request(): { url(): string }; fulfill(o: object): Promise<void> }) => Promise<void>): Promise<void>;
  goto(url: string): Promise<unknown>;
  waitForFunction(fn: string, arg?: unknown, o?: object): Promise<unknown>;
  evaluate<R, A>(fn: (a: A) => R | Promise<R>, a: A): Promise<R>;
}

/** Why the PC baker cannot run here, or null when it can (playwright-core installed and a Chromium found). */
export async function pcUnavailable(chromium?: string): Promise<string | null> {
  try { await import('playwright-core' as string); } catch { return 'playwright-core is not installed'; }
  return findChromium(chromium) ? null : 'no Chromium or Chrome found (set CLAYCLAUDE_CHROMIUM)';
}

/** Real launcher: playwright-core drives an installed Chromium; the page's files are served from webRoot by request interception. */
export const playwrightLauncher = (chromium?: string): PageLauncher => async (webRoot) => {
  const pw = (await import('playwright-core' as string)) as Pw;
  const exe = findChromium(chromium);
  if (!exe) throw new Error('no Chromium or Chrome found (set CLAYCLAUDE_CHROMIUM)');
  const browser = await pw.chromium.launch({ executablePath: exe, headless: true, args: CHROMIUM_ARGS });
  try {
    const page = await browser.newPage();
    const root = normalize(webRoot);
    await page.route(`${ORIGIN}/**`, async (r) => {
      const file = normalize(join(root, new URL(r.request().url()).pathname));
      if (!file.startsWith(root.endsWith(sep) ? root : root + sep)) return r.fulfill({ status: 404, body: '' });
      try { await r.fulfill({ status: 200, contentType: TYPES[extname(file)] ?? 'application/octet-stream', body: await readFile(file) }); }
      catch { await r.fulfill({ status: 404, body: '' }); }
    });
    await page.goto(`${ORIGIN}/clay-bake.html`);
    await page.waitForFunction('window.__clayReady === true', undefined, { timeout: 30_000 });
    const version = await page.evaluate(() => (window as unknown as { __clay: { version: string } }).__clay.version, null);
    return {
      version,
      async sheet(k) {
        const r = await page.evaluate((key) => (window as unknown as { __clay: { sheet(k: unknown): Promise<{ png: string; frames: number; cols: number }> } }).__clay.sheet(key), k);
        return { png: Buffer.from(r.png, 'base64'), frames: r.frames, cols: r.cols };
      },
      close: () => browser.close(),
    };
  } catch (e) { await browser.close(); throw e; }
};

export interface ClayRoutes { handler: RouteHandler; close(): Promise<void> }

/**
 * `/clay/*` routes (spec §7.3 "Baked by PC"), and `/gallery` (spec §7.4.6, a redirect to the lab's gallery):
 *   GET /clay/status  -> {pc: boolean, reason?}
 *   GET /clay/sheet?state&puffed&size&shadows&colour&v -> image/png with x-clay-frames and x-clay-cols;
 *     400 bad query, 404 when this PC cannot bake, 409 when `v` is not this build's renderer version.
 * Sheets are cached on disk per renderer version; one headless page bakes one sheet at a time and
 * closes after `idleCloseMs` without work. Any 6-digit colour is a valid key, so both are bounded: at most
 * `maxCachedSheets` sheets stay on disk (the least recently baked go first), and at most `maxQueued` different
 * sheets wait to be baked (past that, 503; a request for a sheet already waiting joins it).
 */
export function createClayRoutes(o: { webRoot: string; cacheDir?: string; chromium?: string; launcher?: PageLauncher; unavailable?: () => Promise<string | null>; idleCloseMs?: number; bakeTimeoutMs?: number; maxCachedSheets?: number; maxQueued?: number }): ClayRoutes {
  const cacheDir = o.cacheDir ?? join(homedir(), '.cache', 'clayclaude', 'sheets');
  const launcher = o.launcher ?? playwrightLauncher(o.chromium);
  const unavailable = o.unavailable ?? (() => pcUnavailable(o.chromium));
  const idleMs = o.idleCloseMs ?? 120_000;
  const bakeTimeoutMs = o.bakeTimeoutMs ?? 180_000;
  // A board needs 26 states per size, colour and shadow setting: room for a dozen such sets.
  const maxCached = o.maxCachedSheets ?? 2000;
  const maxQueued = o.maxQueued ?? 256;
  let page: Promise<BakePage> | null = null;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let pruned = false;
  const inflight = new Map<string, Promise<BakedPng>>();

  const getPage = () => {
    page ??= launcher(o.webRoot).catch((e) => { page = null; throw e; });
    return page;
  };
  /** Close and forget the page (a failed or hung bake may have left it unusable); the next bake launches a new one. */
  const drop = () => { const p = page; page = null; void p?.then((x) => x.close()).catch(() => {}); };
  /** Bakes running now. The idle timer an earlier request armed must not close the page under one of them. */
  let active = 0;
  /** Re-arms the idle close. Every request calls it when it ends, so the last bake to finish arms the final one. */
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => { if (!active) drop(); }, idleMs);
    idle.unref?.();
  };

  async function readCached(name: string): Promise<BakedPng | null> {
    try {
      const meta = JSON.parse(await readFile(join(cacheDir, `${name}.json`), 'utf8')) as { frames: number; cols: number };
      return { png: await readFile(join(cacheDir, `${name}.png`)), frames: meta.frames, cols: meta.cols };
    } catch { return null; }
  }

  async function bake(k: PcKey): Promise<BakedPng> {
    active++;
    try { return await bakeOnPage(k); } finally { active--; }
  }

  async function bakeOnPage(k: PcKey): Promise<BakedPng> {
    const p = await getPage();
    if (p.version !== k.version) throw Object.assign(new Error(`renderer version ${k.version} is not this build's ${p.version}`), { status: 409 });
    if (!pruned) { pruned = true; await prune(p.version); }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let r: BakedPng;
    try {
      r = await Promise.race([
        p.sheet(k),
        new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error(`baking ${cacheName(k)} took over ${bakeTimeoutMs} ms`)), bakeTimeoutMs); }),
      ]);
    } catch (e) { drop(); throw e; } finally { clearTimeout(timer); }
    await mkdir(cacheDir, { recursive: true });
    const name = cacheName(k);
    await writeFile(join(cacheDir, `${name}.png.tmp`), r.png);
    await rename(join(cacheDir, `${name}.png.tmp`), join(cacheDir, `${name}.png`));
    await writeFile(join(cacheDir, `${name}.json`), JSON.stringify({ frames: r.frames, cols: r.cols }));
    await trim();
    return r;
  }

  /** Keep at most `maxCached` sheets: drop the oldest (by mtime) beyond that, png and json together. */
  async function trim() {
    try {
      const pngs = (await readdir(cacheDir)).filter((f) => f.endsWith('.png'));
      if (pngs.length <= maxCached) return;
      const aged = await Promise.all(pngs.map(async (f) => ({ f, t: await stat(join(cacheDir, f)).then((x) => x.mtimeMs, () => 0) })));
      aged.sort((a, b) => a.t - b.t);
      for (const { f } of aged.slice(0, pngs.length - maxCached)) {
        await rm(join(cacheDir, f), { force: true });
        await rm(join(cacheDir, f.replace(/\.png$/, '.json')), { force: true });
      }
    } catch { /* best effort: a full cache only costs disk */ }
  }

  /** Drop cached sheets of other renderer versions. */
  async function prune(version: string) {
    try { for (const f of await readdir(cacheDir)) if (!f.includes(`-${version}.`)) await rm(join(cacheDir, f), { force: true }); } catch { /* no cache yet */ }
  }

  const send = (res: Parameters<RouteHandler>[1], code: number, body: unknown) => {
    res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  const handler: RouteHandler = async (req, res, url) => {
    // Spec §7.4.6: the gallery of all 26 states at board size, for the visual review
    if (url.pathname === '/gallery' && req.method === 'GET') { res.writeHead(302, { location: '/clay-lab.html?view=gallery' }); res.end(); return true; }
    if (!url.pathname.startsWith('/clay/')) return false;
    if (req.method !== 'GET') { send(res, 405, { error: 'GET only' }); return true; }
    if (url.pathname === '/clay/status') {
      const why = await unavailable();
      send(res, 200, why ? { pc: false, reason: why } : { pc: true });
      return true;
    }
    if (url.pathname !== '/clay/sheet') { send(res, 404, { error: 'not found' }); return true; }
    const k = parseSheetQuery(url.searchParams);
    if (typeof k === 'string') { send(res, 400, { error: k }); return true; }
    const name = cacheName(k);
    let r = await readCached(name);
    if (!r) {
      const why = await unavailable();
      if (why) { send(res, 404, { error: why }); return true; }
      try {
        let job = inflight.get(name);
        if (!job && inflight.size >= maxQueued) { send(res, 503, { error: 'too many sheets waiting to be baked; try again shortly' }); return true; }
        if (!job) {
          job = chain.then(() => bake(k));
          chain = job.catch(() => {});
          inflight.set(name, job);
          void job.catch(() => {}).finally(() => inflight.delete(name));
        }
        r = await job;
      } catch (e) {
        const status = (e as { status?: number }).status ?? 404;
        send(res, status, { error: String((e as Error).message ?? e) });
        return true;
      } finally { touch(); }
    }
    res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store', 'x-clay-frames': String(r.frames), 'x-clay-cols': String(r.cols) });
    res.end(r.png);
    return true;
  };

  return {
    handler,
    async close() { clearTimeout(idle); const p = page; page = null; await p?.then((x) => x.close()).catch(() => {}); },
  };
}

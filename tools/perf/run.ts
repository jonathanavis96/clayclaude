/**
 * Runs the renderer perf page and collects its result.
 *
 *   tools/sem.sh npx tsx tools/perf/run.ts --tablet [--query 'counts=5,10,20&seconds=10&modes=bake,live'] [--out file.json]
 *   tools/sem.sh npx tsx tools/perf/run.ts --local  (headless Chromium on this PC, SwiftShader: a smoke test, not a measurement)
 *
 * --tablet: builds the page, serves it on 127.0.0.1:8435 (8430–8499: Windows reserves 7125–7624, so an adb reverse there fails), applies `adb reverse` and opens it in the
 * tablet's Chrome through tools/tablet.sh (which holds the device lock), records Chrome's memory with
 * `dumpsys meminfo` whenever the page asks, and prints the table when the page posts its result.
 * Afterwards it closes the tab it opened and removes the reverse, so the tablet is left as it was.
 * Without --out the result goes to $CLAYCLAUDE_QA_DIR/perf/ (default: qa/perf/ in the repo, git-ignored).
 */
import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, normalize, sep } from 'node:path';
import { build } from 'vite';
import { createClayRoutes } from '../../src/clay/routes.js';

const here = import.meta.dirname;
const repo = join(here, '..', '..');
const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const tablet = args.includes('--tablet');
const port = Number(flag('--port') ?? 8435);
const query = flag('--query') ?? 'counts=5,10,20&seconds=10&modes=bake,live,live-noshadow,pc';
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outFile = flag('--out') ?? join(process.env.CLAYCLAUDE_QA_DIR ?? join(repo, 'qa'), 'perf', `perf-${tablet ? 'tablet' : 'local'}-${stamp}.json`);
const TABLET = process.env.TABLET_SH ?? join(repo, 'tools', 'tablet.sh');

const sh = (file: string, a: string[], timeout = 60_000) =>
  new Promise<string>((res, rej) => execFile(file, a, { timeout, maxBuffer: 16 << 20 }, (e, so, se) => (e ? rej(new Error(`${file} ${a.join(' ')}: ${se || e.message}`)) : res(so))));

/** Chrome's CPU use (%, summed over its processes) from one batch of `top` on the tablet. */
async function chromeCpu(): Promise<number> {
  const txt = await sh(TABLET, ['top']);
  let cpu = 0;
  for (const line of txt.split('\n')) {
    if (!/com\.android\.chrome|chrome_zygote|chromium/.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const i = cols.findIndex((c) => /^[RSDZT]$/.test(c)); // toybox top: ... S[%CPU] %MEM TIME+ ARGS
    if (i >= 0 && Number.isFinite(Number(cols[i + 1]))) cpu += Number(cols[i + 1]);
  }
  return Math.round(cpu * 10) / 10;
}

/** Chrome's processes and their PSS in MB, from `dumpsys meminfo` on the tablet. */
async function chromeMemory(): Promise<Record<string, number>> {
  const txt = await sh(TABLET, ['shell', 'dumpsys', 'meminfo']);
  const mem: Record<string, number> = {};
  for (const m of txt.matchAll(/^\s*([\d,]+)K: (com\.android\.chrome[^\s]*) \(pid (\d+)/gm)) mem[`${m[2]}#${m[3]}`] = Math.round(Number(m[1].replace(/,/g, '')) / 1024);
  return mem;
}

/** Close the tablet tabs this run opened (matched by its `run=` id) and remove the reverse if this run added it. Best effort. */
async function tabletCleanup(runId: string, addedReverse: boolean) {
  try {
    const tabs = JSON.parse(await sh(TABLET, ['tabs'])) as Array<{ id: string; url: string }>;
    for (const t of tabs) if (t.url.includes(`localhost:${port}/`) && t.url.includes(`run=${runId}`)) await sh(TABLET, ['close-tab', t.id]);
  } catch (e) { console.error('could not close the perf tab:', String(e)); }
  if (addedReverse) await sh(TABLET, ['unreverse', String(port)]).catch((e) => console.error('could not remove the reverse:', String(e)));
}

const body = (req: IncomingMessage) => new Promise<string>((r) => { let s = ''; req.on('data', (c) => (s += c)); req.on('end', () => r(s)); });
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

async function main() {
  await build({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn' });
  // the board's own build, so the PC baker (/clay/*) can load web/dist/clay-bake.html for `modes=pc`
  await build({ configFile: join(repo, 'web', 'vite.config.ts'), logLevel: 'warn' });
  const clay = createClayRoutes({ webRoot: join(repo, 'web', 'dist'), cacheDir: join(repo, 'tools', 'perf', 'dist', 'pc-sheets') });
  const dist = join(here, 'dist');
  let resolve!: (v: unknown) => void;
  const result = new Promise((r) => (resolve = r));
  const marks: Record<string, unknown> = {};
  let pcSheetRequests = 0; // proves modes=pc reached the PC baker rather than playing sheets already in IndexedDB
  const srv = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/clay/sheet') pcSheetRequests++;
    if (await clay.handler(req, res, url)) return;
    if (req.method === 'POST' && url.pathname === '/mark') {
      const { name } = JSON.parse(await body(req));
      const mem = tablet ? { cpuPct: await chromeCpu().catch(() => null), memMB: await chromeMemory().catch((e) => ({ error: String(e) })) } : null;
      marks[name] = mem;
      console.log(`mark ${name}`, mem);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(mem));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/result') {
      resolve(JSON.parse(await body(req)));
      res.writeHead(200); res.end('{}');
      return;
    }
    const file = normalize(join(dist, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(dist + sep)) { res.writeHead(404); res.end(); return; }
    try { const b = readFileSync(file); res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  });
  await new Promise<void>((r) => srv.listen(port, '127.0.0.1', r));
  const runId = String(Date.now());
  const url = `http://localhost:${port}/?${query}&run=${runId}`;
  let browser: { close(): Promise<void> } | null = null;
  let r: Record<string, unknown>;
  let addedReverse = false;
  try {
    if (tablet) {
      await sh(TABLET, ['unlock']);
      addedReverse = !(await sh(TABLET, ['reverse-list'])).split('\n').some((l) => l.includes(`tcp:${port} `));
      await sh(TABLET, ['reverse', String(port)]);
      await sh(TABLET, ['open-url-as', url, 'clayclaude-perf']); // one reused tab per lane, so repeated runs do not pile up tabs
      console.log(`opened ${url} on the tablet`);
    } else {
      const { chromium } = await import('playwright-core');
      const { CHROMIUM_ARGS, findChromium } = await import('../../src/clay/chromium.js');
      const exe = findChromium();
      if (!exe) throw new Error('no Chromium found');
      const b = await chromium.launch({ executablePath: exe, args: CHROMIUM_ARGS });
      browser = b;
      const page = await b.newPage({ viewport: { width: 961, height: 601 } });
      page.on('console', (m) => console.log('page:', m.text()));
      page.on('response', (r) => { if (r.status() >= 400) console.log('http', r.status(), r.url()); });
      page.on('pageerror', (e) => console.log('pageerror:', e.message));
      await page.goto(url);
    }
    const timer = setTimeout(() => resolve({ error: 'timed out after 20 min' }), 20 * 60_000);
    r = (await result) as Record<string, unknown>;
    clearTimeout(timer);
  } finally {
    await browser?.close().catch(() => {});
    if (tablet) await tabletCleanup(runId, addedReverse);
    await clay.close();
    srv.close();
  }
  r.marks = marks;
  r.pcSheetRequests = pcSheetRequests;
  const modes = (new URLSearchParams(query).get('modes') ?? 'bake,live').split(',');
  if (modes.includes('pc') && pcSheetRequests === 0 && !r.error) r.error = 'modes=pc never asked the PC baker for a sheet (/clay/sheet): the pc rows played sheets already in IndexedDB';
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, JSON.stringify(r, null, 2));
  console.log(`\nresult: ${outFile}`);
  const pb = (r.playback ?? {}) as Record<string, { fps: number; worstMs: number; stutters: number; readyMs: number }>;
  console.log('\nmode                         fps   worst  stutters  first-frame');
  for (const [k, v] of Object.entries(pb)) console.log(`${k.padEnd(26)} ${String(v.fps).padStart(6)} ${String(v.worstMs).padStart(6)} ${String(v.stutters).padStart(9)} ${String(v.readyMs).padStart(11)}`);
  for (const k of ['playbackWhileBaking', 'playbackWhileIdleBaking']) {
    const v = r[k] as { fps: number; worstMs: number; stutters: number } | undefined;
    if (v) console.log(`${k.padEnd(26)} ${String(v.fps).padStart(6)} ${String(v.worstMs).padStart(6)} ${String(v.stutters).padStart(9)}`);
  }
  console.log('\nbake:', JSON.stringify(r.bake));
  console.log('all states:', JSON.stringify(r.allStates));
  console.log('first launch, auto:', JSON.stringify(r.firstLaunchAuto));
  console.log('first launch, bake:', JSON.stringify(r.firstLaunchBake));
  if (r.error) { console.error('page error:', r.error); process.exitCode = 1; }
}

main().catch((e) => { console.error(e); process.exit(1); });

/**
 * clayclaude renderer perf page (spec §13). Reports fps, worst frame, stutters (> 50 ms) and bake
 * time for 5/10/20 characters in each mode. Opened on the tablet by tools/perf/run.ts, which
 * receives the result as JSON. Query: ?counts=5,10,20&seconds=10&modes=bake,live,live-noshadow,pc
 * (live-noshadow: live 3D with shadows off). Characters are drawn at the kiosk board's own size.
 */
import { Baker, MainBackend, WorkerBackend, type BakeBackend } from '../../web/src/clay/baker.js';
import { createClayController, type ClayController } from '../../web/src/clay/controller.js';
import { measureFrames, summariseFrames, type FrameStats } from '../../web/src/clay/measure.js';
import { DEFAULT_CLAY_PREFS, type AnimMode } from '../../web/src/clay/prefs.js';
import { allStatesBytes, bucketFor, layoutFor, type SheetKey } from '../../web/src/clay/sheet.js';
import { CLAY_STATES } from '../../web/src/clay/states.js';
import type { Stage } from '../../web/src/clay/stage.js';
import { RENDERER_VERSION } from '../../web/src/clay/version.js';
import type { Session } from '../../src/types.js';

const q = new URLSearchParams(location.search);
const counts = (q.get('counts') ?? '5,10,20').split(',').map(Number);
const seconds = Number(q.get('seconds') ?? 10);
type PerfMode = Exclude<AnimMode, 'auto'> | 'live-noshadow';
const modes = (q.get('modes') ?? 'bake,live').split(',') as PerfMode[];
const stageEl = document.getElementById('stage')!;
const logEl = document.getElementById('log')!;
const out: Record<string, unknown> = { version: RENDERER_VERSION, startedAt: new Date().toISOString() };
const log = (s: string) => { logEl.textContent += s + '\n'; logEl.scrollTop = 1e9; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const post = async (path: string, body: unknown) => {
  try { const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.ok ? r.json().catch(() => null) : null; } catch { return null; }
};
/** Asks the runner to record device memory now (adb dumpsys meminfo); null when not run by the runner. */
const mark = (name: string) => post('/mark', { name });

/**
 * The kiosk board's character slot in CSS px, full screen in each orientation (web/src/style.css:
 * `--row: clamp(72px, 15vh, 120px)`, `.char { width: calc(var(--cs) * .8) }`), rounded as clientWidth rounds it.
 */
function boardCss(orientation: 'landscape' | 'portrait'): number {
  const h = orientation === 'landscape' ? Math.min(screen.width, screen.height) : Math.max(screen.width, screen.height);
  return Math.round(0.8 * Math.min(120, Math.max(72, 0.15 * h)));
}
const boardPx = (o: 'landscape' | 'portrait') => Math.round(boardCss(o) * devicePixelRatio);

function slots(n: number, cssPx = boardCss('landscape')): HTMLElement[] {
  stageEl.innerHTML = '';
  return Array.from({ length: n }, () => {
    const d = document.createElement('div');
    d.className = 'char';
    d.style.height = `${cssPx}px`;
    stageEl.appendChild(d);
    return d;
  });
}
const devicePx = () => boardPx('landscape');

function info() {
  const gl = document.createElement('canvas').getContext('webgl2');
  const ext = gl?.getExtension('WEBGL_debug_renderer_info');
  return {
    ua: navigator.userAgent, dpr: devicePixelRatio, viewport: `${innerWidth}x${innerHeight}`,
    cores: navigator.hardwareConcurrency, memoryGb: (navigator as { deviceMemory?: number }).deviceMemory ?? null,
    gl: gl && ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl ? 'webgl2' : 'none',
    screen: `${screen.width}x${screen.height}`,
    board: { landscape: { css: boardCss('landscape'), px: boardPx('landscape'), bucket: bucketFor(boardPx('landscape')) }, portrait: { css: boardCss('portrait'), px: boardPx('portrait'), bucket: bucketFor(boardPx('portrait')) } },
    slotPx: devicePx(), bucket: bucketFor(devicePx()),
  };
}

async function bakeTrials(size: number) {
  const key = (state: SheetKey['state']): SheetKey => ({ state, puffed: false, size, shadows: true, colour: '#e07a4f', version: RENDERER_VERSION });
  const res: Record<string, unknown> = {};
  // one main-thread stage (one WebGL context) for every main-thread bake, as the controller shares its own
  let stage: Promise<Stage> | null = null;
  const mainStage = () => (stage ??= import('../../web/src/clay/stage.js').then(({ Stage }) => new Stage(document.createElement('canvas'))));
  const makers: Array<[string, () => BakeBackend]> = [['worker', () => new WorkerBackend()], ['main', () => new MainBackend(mainStage)]];
  for (const [name, make] of makers) {
    let b: BakeBackend;
    try { b = make(); } catch (e) { res[name] = { error: String(e) }; continue; }
    try {
      // cold: the first bake on a fresh backend (worker start, three.js load, shader compile), as a first launch sees it
      const tc = performance.now();
      const cold = await b.bake(key('W2'), { frames: 24 });
      await cold.png;
      res[`${name}24cold`] = { totalMs: Math.round(performance.now() - tc), renderMs: Math.round(cold.renderMs) };
      log(`bake ${name} 24 frames cold @${size}px: ${Math.round(performance.now() - tc)} ms`);
      cold.bitmap.close();
      for (const frames of [24, 48]) {
        const t = performance.now();
        const r = await b.bake(key('W2'), { frames });
        const shown = performance.now() - t;
        const png = await r.png;
        const total = performance.now() - t;
        res[`${name}${frames}`] = { renderMs: Math.round(r.renderMs), firstPaintMs: Math.round(shown), totalMs: Math.round(total), pngKB: Math.round(png.size / 1024) };
        log(`bake ${name} ${frames} frames @${size}px: render ${Math.round(r.renderMs)} ms, shown ${Math.round(shown)} ms, with PNG ${Math.round(total)} ms (${Math.round(png.size / 1024)} KB)`);
        r.bitmap.close();
      }
    } catch (e) { res[name] = { error: String(e) }; log(`bake ${name} failed: ${e}`); }
    b.dispose();
  }
  return res;
}

async function allStates(size: number) {
  const baker = new Baker([() => new WorkerBackend()]);
  const t = performance.now();
  let render = 0, bytes = 0;
  const pngs: Blob[] = [];
  for (const state of CLAY_STATES) {
    const r = await baker.bake({ state, puffed: false, size, shadows: true, colour: '#e07a4f', version: RENDERER_VERSION }, true);
    render += r.renderMs;
    const png = await r.png;
    bytes += png.size;
    pngs.push(png);
    r.bitmap.close();
  }
  const totalMs = Math.round(performance.now() - t);
  baker.dispose();
  const t2 = performance.now();
  const bitmaps = await Promise.all(pngs.map((p) => createImageBitmap(p)));
  const decodeMs = Math.round(performance.now() - t2);
  const memAfterDecode = await mark(`decoded-all-${size}`);
  bitmaps.forEach((b) => b.close());
  const r = { size, totalMs, renderMs: Math.round(render), pngKB: Math.round(bytes / 1024), decodedMB: +(allStatesBytes(size) / 1048576).toFixed(1), decodeAllMs: decodeMs, frames: CLAY_STATES.reduce((n, s) => n + layoutFor({ state: s, size }).frames, 0), memAfterDecode };
  log(`all ${CLAY_STATES.length} states @${size}px: ${totalMs} ms (render ${r.renderMs} ms), ${r.frames} frames, PNG ${r.pngKB} KB, decoded ${r.decodedMB} MB, decode all ${decodeMs} ms`);
  return r;
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = performance.now() + ms;
  while (performance.now() < end) { if (cond()) return true; await sleep(100); }
  return cond();
}

/** A working session for the focus view's large character (mountLarge follows a session, not a fixed state). */
const perfSession = (): Session => ({
  key: 'perf:perf:perf', host: 'perf', account: 'perf', sessionId: 'perf', pid: 1, name: 'perf', cwd: '/', state: 'working',
  stateSince: Date.now() - 2 * 60_000, live: true, overContext: false, hostOnline: true, lastSeen: Date.now(),
});

async function playback(mode: Exclude<AnimMode, 'auto'>, n: number, opts: { shadows?: boolean; px?: number; large?: boolean } = {}): Promise<FrameStats & { readyMs: number; allBakedMs: number | null; mode: string; device: unknown }> {
  const els = slots(n, opts.px ? opts.px / devicePixelRatio : undefined);
  const t = performance.now();
  const clay: ClayController = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode, shadows: opts.shadows ?? true }, cacheTtlMinutes: 60 });
  const stops = opts.large ? els.map((el) => clay.mountLarge(el, perfSession())) : els.map((el, i) => clay.mountState(el, CLAY_STATES[i % CLAY_STATES.length]));
  await waitFor(() => els.every((e) => e.querySelector('canvas.clay')), 120_000);
  const readyMs = Math.round(performance.now() - t);
  let allBakedMs: number | null = null;
  if (mode === 'bake' || mode === 'pc') { // measure without background baking
    await waitFor(() => clay.status().baked === clay.status().total, 300_000);
    allBakedMs = Math.round(performance.now() - t);
  }
  await sleep(500);
  const measuring = measureFrames(seconds * 1000, () => {});
  await sleep(seconds * 500);
  const device = await mark(`${mode}-${n}${opts.px ? `-${opts.px}px` : ''}${opts.shadows === false ? '-noshadow' : ''}`); // CPU and memory mid-run (tablet only)
  const stats = await measuring;
  stops.forEach((s) => s());
  clay.dispose();
  return { ...stats, readyMs, allBakedMs, mode, device };
}

/** Frame stats from now until `done()` (checked every frame) or `maxMs`. */
function measureUntil(done: () => boolean, maxMs: number): Promise<FrameStats & { ms: number; finished: boolean }> {
  return new Promise((resolve) => {
    const gaps: number[] = [];
    let start = 0, last = 0;
    const step = (now: number) => {
      if (!start) { start = last = now; requestAnimationFrame(step); return; }
      gaps.push(now - last);
      last = now;
      const finished = done();
      if (!finished && now - start < maxMs) requestAnimationFrame(step);
      else resolve({ ...summariseFrames(gaps, now - start), ms: Math.round(now - start), finished });
    };
    requestAnimationFrame(step);
  });
}

/** Mount `els` as the board does (sync with sessions), so the controller's prefetch size follows the slots. */
function boardSync(clay: ClayController, els: HTMLElement[]) {
  const now = Date.now();
  const states: Session['state'][] = ['working', 'needs-you', 'asleep', 'working', 'stopped'];
  const sessions = els.map((el, i) => {
    el.dataset.key = `perf:${i}`;
    return { ...perfSession(), key: `perf:${i}`, state: states[i % states.length], stateSince: now - (i + 1) * 60_000 };
  });
  clay.sync(stageEl, sessions, now);
}

/**
 * A fresh first launch, run first on an empty store: the board's controller in Auto with `n` characters at the
 * board's size. Records what Auto picked and how long it took to decide.
 */
async function firstLaunchAuto(n: number) {
  await clearStore();
  const els = slots(n);
  const t = performance.now();
  const clay = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS }, cacheTtlMinutes: 60 });
  boardSync(clay, els);
  const decided = await waitFor(() => clay.status().reason !== 'Measuring this device', 120_000);
  const decideMs = Math.round(performance.now() - t);
  const st = clay.status();
  clay.dispose();
  return { decided, decideMs, mode: st.mode, reason: st.reason, characters: n, size: bucketFor(devicePx()) };
}

/**
 * First launch in bake mode on an empty store: `n` characters at the board's size on screen while the controller
 * bakes every state in the background. Time until all states are stored, and the frame rate meanwhile.
 */
async function firstLaunchBake(n: number) {
  await clearStore();
  const els = slots(n);
  const t = performance.now();
  const clay = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode: 'bake' }, cacheTtlMinutes: 60 });
  boardSync(clay, els);
  await waitFor(() => els.every((e) => e.querySelector('canvas.clay')), 120_000);
  const readyMs = Math.round(performance.now() - t);
  const during = await measureUntil(() => clay.status().baked === clay.status().total, 300_000);
  const allBakedMs = Math.round(performance.now() - t);
  const device = await mark(`first-launch-bake-${n}-done`);
  const total = clay.status().total;
  clay.dispose();
  return { characters: n, size: bucketFor(devicePx()), states: total, readyMs, allBakedMs, finished: during.finished, whileBaking: { fps: during.fps, worstMs: during.worstMs, stutters: during.stutters, frames: during.frames }, device };
}

/**
 * First launch as the board sees it: `n` characters on screen while the rest bake in the background.
 * `urgent` bakes everything at full speed (no pacing); otherwise the controller's own idle prefetch runs.
 */
async function playbackWhileBaking(n: number, urgent: boolean) {
  const els = slots(n);
  const colour = urgent ? '#4fd1c5' : '#5aa9ff'; // a colour nothing was baked in yet
  const clay = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode: 'bake', bodyColour: colour }, cacheTtlMinutes: 60 });
  const stops = els.map((el, i) => clay.mountState(el, CLAY_STATES[i % CLAY_STATES.length]));
  await waitFor(() => els.every((e) => e.querySelector('canvas.clay')), 120_000);
  const baker = new Baker([() => new WorkerBackend()]);
  let busy = urgent;
  if (urgent) void (async () => {
    for (const state of CLAY_STATES) { if (!busy) break; const r = await baker.bake({ state, puffed: false, size: 96, shadows: true, colour, version: RENDERER_VERSION }, true); r.bitmap.close(); }
  })().catch(() => {});
  const before = clay.status().baked;
  const stats = await measureFrames(seconds * 1000, () => {});
  const bakedDuring = clay.status().baked - before;
  busy = false;
  baker.dispose();
  stops.forEach((s) => s());
  clay.dispose();
  return { ...stats, bakedDuring };
}

const row = (label: string, s: FrameStats & { readyMs?: number }) => log(`${label.padEnd(26)} ${String(s.fps).padStart(5)} fps  worst ${String(s.worstMs).padStart(4)} ms  stutters ${String(s.stutters).padStart(3)}${s.readyMs !== undefined ? `  first frame ${s.readyMs} ms` : ''}`);

/** Empty the board's sheet store, so the next controller finds nothing stored and must make every sheet itself. */
const clearStore = () => new Promise<void>((r) => { const d = indexedDB.deleteDatabase('clayclaude-clay'); d.onsuccess = d.onerror = d.onblocked = () => r(); });

async function main() {
  await clearStore();
  out.info = info();
  log(JSON.stringify(out.info));
  out.memStart = await mark('start');
  // first, while nothing is warm: what Auto picks on a fresh first launch
  out.firstLaunchAuto = await firstLaunchAuto(10);
  log(`auto on first launch: ${JSON.stringify(out.firstLaunchAuto)}`);
  const size = bucketFor(devicePx());
  out.bake = await bakeTrials(size);
  const sizes = [...new Set([size, bucketFor(boardPx('portrait'))])];
  out.allStates = [];
  for (const s of sizes) (out.allStates as unknown[]).push(await allStates(s));
  out.firstLaunchBake = await firstLaunchBake(10);
  log(`first launch, bake mode, 10 on screen: ${JSON.stringify(out.firstLaunchBake)}`);
  out.playback = {};
  for (const mode of modes) for (const [i, n] of counts.entries()) {
    // each sheet mode starts from an empty store: otherwise the pc rows would play the sheets the bake rows
    // stored (and the reverse) and never ask the PC baker, measuring the wrong path
    if (i === 0 && (mode === 'bake' || mode === 'pc')) await clearStore();
    const s = mode === 'live-noshadow' ? await playback('live', n, { shadows: false }) : await playback(mode, n);
    (out.playback as Record<string, unknown>)[`${mode}-${n}`] = s;
    row(`${mode} x${n}`, s);
    if (mode === 'bake' && n === Math.max(...counts)) out.memBake = await mark(`bake-${n}-playing`);
  }
  if (modes.includes('live')) {
    // the focus view: one large character, live in every mode, at its largest (MAX_LARGE_LIVE_PX)
    const l = await playback('live', 1, { px: 480, large: true });
    (out.playback as Record<string, unknown>)['live-1-focus-480px'] = l;
    row('live x1 focus 480px', l);
  }
  const wb = await playbackWhileBaking(10, true);
  out.playbackWhileBaking = wb;
  row('bake x10, unpaced bakes', wb);
  const wi = await playbackWhileBaking(10, false);
  out.playbackWhileIdleBaking = wi;
  row(`bake x10, idle prefetch (${wi.bakedDuring} baked)`, wi);
  out.memEnd = await mark('end');
  out.finishedAt = new Date().toISOString();
  log('done');
  await post('/result', out);
  (window as unknown as { __perfResult: unknown }).__perfResult = out;
}

main().catch((e) => { log('FAILED ' + (e?.stack ?? e)); void post('/result', { ...out, error: String(e?.stack ?? e) }); });

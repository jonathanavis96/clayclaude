// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { BakeBackend } from '../web/src/clay/baker.js';
import { createClayController, type ClayController, type ClayDeps } from '../web/src/clay/controller.js';
import { DEFAULT_CLAY_PREFS, type AnimMode } from '../web/src/clay/prefs.js';
import { layoutFor, type SheetKey } from '../web/src/clay/sheet.js';
import { Sprite, type SpriteEnv } from '../web/src/clay/sprite.js';
import { MemoryStore } from '../web/src/clay/store.js';
import { RENDERER_VERSION } from '../web/src/clay/version.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
async function until(cond: () => boolean, ms = 3000) { const end = Date.now() + ms; while (!cond()) { if (Date.now() > end) throw new Error('timed out'); await sleep(10); } }

// happy-dom has no 2D canvas: give every canvas a stub context that records draws
const draws: string[] = [];
let closedDraws = 0;
beforeEach(() => {
  draws.length = 0;
  closedDraws = 0;
  (window as any).devicePixelRatio = 4 / 3; // the tablet's: a 72 px slot is a 96 px sheet
  // drawing a closed ImageBitmap throws in a browser; here it is counted
  (HTMLCanvasElement.prototype as any).getContext = function () {
    return { clearRect() {}, drawImage: (b: any) => { if (b?.closed) { closedDraws++; throw new DOMException('closed', 'InvalidStateError'); } draws.push('draw'); } };
  };
});

const handedOut: Array<{ closed: boolean }> = [];
const bitmap = () => { const b = { closed: false, close() { this.closed = true; }, width: 1, height: 1 }; handedOut.push(b); return b as unknown as ImageBitmap; };
/** A fake PNG says its size ("640x480"), and decodes to a bitmap of that size, as a real sheet does. */
const pngOf = (key: Pick<SheetKey, 'state' | 'size'>) => { const l = layoutFor(key); return new Blob([`${l.width}x${l.height}`]); };
const sized = async (b: Blob) => { const [w, h] = (await b.text()).split('x').map(Number); return Object.assign(bitmap(), { width: w, height: h }); };

function fakes(o: { bake?: 'ok' | 'fail'; live?: { fps: number; worstMs: number } | 'broken'; pc?: boolean; bakeMs?: number; pngMs?: number } = {}) {
  const log = { bakes: [] as string[], stages: 0, renders: 0, trials: 0, fetches: [] as string[] };
  const backend = (name: string): BakeBackend => ({
    name,
    async bake(key) { log.bakes.push(`${name}:${key.state}:${key.size}`); if (o.bakeMs) await sleep(o.bakeMs); if (o.bake === 'fail') throw new Error(`${name} broke`); return { bitmap: bitmap(), png: o.pngMs ? sleep(o.pngMs).then(() => pngOf(key)) : Promise.resolve(pngOf(key)), renderMs: 5 }; },
    dispose() {},
  });
  const store = new MemoryStore();
  const deps: Partial<ClayDeps> = {
    openStore: async () => store,
    backends: () => [() => backend('worker'), () => backend('main')],
    makeStage: async () => {
      if (o.live === 'broken') throw new Error('no webgl');
      log.stages++;
      return { canvas: document.createElement('canvas'), setSize() {}, render() { log.renders++; }, lost: () => false, dispose() {} } as any;
    },
    decode: sized,
    liveTrial: async () => { log.trials++; const l = o.live === 'broken' || !o.live ? { fps: 31.6, worstMs: 50 } : o.live; return { ...l, stutters: 0, frames: 60 }; },
    idle: () => sleep(1),
    fetch: (async (url: string) => {
      log.fetches.push(url);
      if (url === '/clay/status') return new Response(JSON.stringify(o.pc ? { pc: true } : { pc: false, reason: 'none' }));
      const q = new URL(url, 'http://x').searchParams;
      const key = { state: q.get('state') as any, size: Number(q.get('size')) };
      return new Response(pngOf(key), { headers: { 'x-clay-frames': String(layoutFor(key).frames) } });
    }) as typeof fetch,
  };
  return { log, store, deps };
}

function slot(key?: string, cssPx = 72): HTMLElement {
  const el = document.createElement('div');
  el.className = 'char';
  if (key) el.dataset.key = key;
  el.innerHTML = '<div class="ph"></div>';
  Object.defineProperty(el, 'clientWidth', { value: cssPx });
  Object.defineProperty(el, 'clientHeight', { value: cssPx });
  document.body.appendChild(el);
  return el;
}
const shown = (el: HTMLElement) => !!el.querySelector('canvas.clay') && !el.querySelector('.ph');
const MIN = 60_000;
const session = (key: string, state: string, ageMin: number, now = Date.now()) =>
  ({ key, state, stateSince: now - ageMin * MIN, overContext: false, host: 'h', account: 'a', sessionId: key, pid: 1, name: key, cwd: '/', live: true, hostOnline: true, lastSeen: now }) as any;

let clay: ClayController | undefined;
const make = (mode: AnimMode, deps: Partial<ClayDeps>) => (clay = createClayController({ prefs: { ...DEFAULT_CLAY_PREFS, mode }, cacheTtlMinutes: 60, deps }));
afterEach(() => { clay?.dispose(); clay = undefined; document.body.innerHTML = ''; });

describe('clay controller', () => {
  it('Auto measures once, picks bake on a slow device, says why, and stores the choice per renderer version', async () => {
    const f = fakes({ live: { fps: 31.6, worstMs: 50 } });
    const c = make('auto', f.deps);
    await until(() => c.status().reason !== 'Measuring this device');
    expect(c.status().mode).toBe('bake');
    expect(c.status().reason).toMatch(/^live ran at 31.6 fps, worst frame 50 ms; a test bake took \d+ ms/);
    expect(await f.store.getRecord('auto')).toMatchObject({ version: RENDERER_VERSION, mode: 'bake' });
    c.dispose();
    const again = make('auto', f.deps);
    await until(() => again.status().reason !== 'Measuring this device');
    expect(f.log.trials).toBe(1); // reused, not re-measured
  });

  it('the Auto trial bake is kept under the size it was baked at, even when the board slot changes size during it', async () => {
    // Live board, 2026-10-13: the trial baked W2 at one size, the board measured a new size meanwhile, and the sheet
    // was stored and drawn under the new size's key, so every W2 tile showed a strip of several frames, then nothing.
    const f = fakes({ live: { fps: 31.6, worstMs: 50 } });
    const backend = (name: string): BakeBackend => ({
      name,
      async bake(key) { f.log.bakes.push(`${name}:${key.state}:${key.size}`); await sleep(60); return { bitmap: bitmap(), png: Promise.resolve(new Blob([String(key.size)])), renderMs: 5 }; },
      dispose() {},
    });
    const c = make('auto', { ...f.deps, backends: () => [() => backend('worker'), () => backend('main')], idle: () => sleep(10_000) });
    await until(() => f.log.bakes.length >= 1);     // the trial is baking W2 at the default 96
    expect(f.log.bakes[0]).toBe('worker:W2:96');
    const root = document.createElement('main');
    document.body.appendChild(root);
    const now = Date.now();
    root.append(slot('row', 60));                    // 80 device px: the board measures its real size mid-trial
    c.sync(root, [session('row', 'asleep', 3, now)], now);
    await until(() => c.status().reason !== 'Measuring this device');
    await sleep(50);
    const keys = await f.store.keys();
    expect(keys.some((k) => k.startsWith('W2|'))).toBe(true);
    for (const k of keys) {
      const size = k.split('|')[2];
      expect(`${k} holds a sheet baked at ${await (await f.store.get(k))!.text()}`).toBe(`${k} holds a sheet baked at ${size}`);
    }
  });

  it('Auto picks live on a strong device', async () => {
    const c = make('auto', fakes({ live: { fps: 59, worstMs: 22 } }).deps);
    await until(() => c.status().reason !== 'Measuring this device');
    expect(c.status().mode).toBe('live');
  });

  it('bake mode bakes the on-screen state first, shows it, and never builds a 3D stage on the page', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const el = slot();
    c.mountState(el, 'N4');
    await until(() => shown(el));
    expect(f.log.bakes[0]).toBe('worker:N4:96');
    expect(f.log.stages).toBe(0);
    const before = draws.length;
    await sleep(300);
    expect(draws.length).toBeGreaterThan(before); // frames keep changing: plain drawImage, no 3D
    expect(f.log.renders).toBe(0);
  });

  it('a sheet already in storage is decoded, not baked again (even when asked for at once)', async () => {
    const f = fakes();
    await f.store.put(`N4|n|96|s|e07a4f|${RENDERER_VERSION}`, pngOf({ state: 'N4', size: 96 }), RENDERER_VERSION);
    // IndexedDB lists its keys slowly on a real device: the first frame must not race ahead and bake
    const slow = Object.assign(Object.create(f.store), { keys: async () => { await sleep(100); return f.store.keys(); } });
    const c = make('bake', { ...f.deps, openStore: async () => slow });
    const el = slot();
    c.mountState(el, 'N4');
    await until(() => shown(el));
    expect(f.log.bakes).not.toContain('worker:N4:96');
  });

  it('a stored sheet that will not decode is baked again, once, with no unhandled rejection', async () => {
    const f = fakes();
    await f.store.put(`N4|n|96|s|e07a4f|${RENDERER_VERSION}`, new Blob(['corrupt']), RENDERER_VERSION);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => unhandled.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      let decodes = 0;
      // a corrupt or unreadable IndexedDB blob (Chrome: NotReadableError)
      const c = make('bake', { ...f.deps, decode: async () => { decodes++; throw new DOMException('unreadable', 'NotReadableError'); } });
      const el = slot();
      c.mountState(el, 'N4');
      await until(() => shown(el));
      await sleep(200);
      expect(decodes).toBe(1);
      expect(f.log.bakes.filter((b) => b === 'worker:N4:96')).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally { process.off('unhandledRejection', onUnhandled); }
  });

  it('a stored sheet whose size does not match its key (kept under the wrong size) is baked again, not drawn as a strip', async () => {
    const f = fakes();
    // what the live board's tablet held: a 64 px W2 sheet (512x384) stored under the 80 px key (640x480)
    await f.store.put(`W2|n|80|s|e07a4f|${RENDERER_VERSION}`, new Blob(['512x384']), RENDERER_VERSION);
    const c = make('bake', f.deps);
    const el = slot(undefined, 60);
    c.mountState(el, 'W2');
    await until(() => f.log.bakes.includes('worker:W2:80'));
  });

  it('a sheet baked once for two callers (idle prefetch and an on-screen character) is never closed under the character', async () => {
    const f = fakes({ bakeMs: 40 });
    const c = make('bake', f.deps);
    const el = slot();
    c.mountState(el, 'W1');                       // the prefetch starts with W1 too, so both ask for W1 at 96 px
    await until(() => c.status().baked >= 4, 5000);
    const before = draws.length;
    await sleep(300);
    expect(closedDraws).toBe(0);
    expect(draws.length).toBeGreaterThan(before);
  });

  it('a character asking for a sheet the idle prefetch is still storing waits for it instead of baking it again', async () => {
    const f = fakes({ bakeMs: 40, pngMs: 150 });   // PNG encoding (and so storing) lags the bitmap, as on the tablet
    const c = make('bake', f.deps);
    await until(() => f.log.bakes.length >= 1);     // the prefetch has started on W1 (the first state)
    const el = slot();
    c.mountState(el, 'W1');
    await until(() => shown(el), 5000);
    await until(() => c.status().baked === 26, 10_000);
    expect(f.log.bakes.filter((b) => b === 'worker:W1:96')).toHaveLength(1);
  });

  it('idle prefetch bakes at the board row size, not at the taller needs-you row size', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const root = document.createElement('main');
    document.body.appendChild(root);
    const now = Date.now();
    root.append(slot('row', 72), slot('ask', 108));  // 96 and 144 device px
    c.sync(root, [session('row', 'working', 3, now), session('ask', 'needs-you', 3, now)], now);
    await until(() => c.status().baked === 26, 10_000);
    expect(f.log.bakes.filter((b) => b.endsWith(':144'))).toEqual(['worker:N2:144']); // only the on-screen needs-you sheet
  });

  it('idle prefetch follows the board size when the first row arrives after the prefetch started', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    await until(() => f.log.bakes.length >= 1);      // the prefetch is already baking at the default 96
    const root = document.createElement('main');
    document.body.appendChild(root);
    const now = Date.now();
    root.append(slot('row', 48));                    // 64 device px: the tablet's non-fullscreen rows are not 96 either
    const at96 = f.log.bakes.filter((b) => b.endsWith(':96')).length;
    c.sync(root, [session('row', 'working', 3, now)], now);
    await until(() => c.status().baked === 26, 10_000);
    expect(f.log.bakes.filter((b) => b.endsWith(':64'))).toHaveLength(26);
    expect(f.log.bakes.filter((b) => b.endsWith(':96')).length).toBeLessThanOrEqual(at96 + 1); // at most the bake already under way
  });

  it('idle prefetch bakes again at the board size when the board slot changes bucket after it finished', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    await until(() => c.status().baked === 26, 10_000); // everything at 96
    const root = document.createElement('main');
    document.body.appendChild(root);
    const now = Date.now();
    root.append(slot('row', 48));
    c.sync(root, [session('row', 'working', 3, now)], now);
    await until(() => c.status().baked === 26, 10_000);
    expect(f.log.bakes.filter((b) => b.endsWith(':64'))).toHaveLength(26);
  });

  it('a sheet whose bitmap was lost is reloaded, and one broken character never stops the others', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const a = slot(), b = slot();
    c.mountState(a, 'N4');
    c.mountState(b, 'S2');
    await until(() => shown(a) && shown(b));
    await until(() => c.status().baked === 26, 5000);
    handedOut.forEach((x) => (x.closed = true));    // e.g. GPU memory reclaimed under pressure
    const before = draws.length;
    await until(() => draws.length > before + 4, 3000); // both draw again, from fresh decodes
    expect(closedDraws).toBeGreaterThan(0);
  });

  it('when the bake worker dies, sheets it made are decoded again from storage', async () => {
    const f = fakes();
    let calls = 0;
    const flaky = (name: string): BakeBackend => ({ name, async bake(key) { calls++; if (calls === 3) throw new Error('worker died'); f.log.bakes.push(`${name}:${key.state}`); return { bitmap: bitmap(), png: Promise.resolve(pngOf(key)), renderMs: 1 }; }, dispose() {} });
    const c = make('bake', { ...f.deps, backends: () => [() => flaky('worker'), () => flaky('main')], decode: async (png) => { decodes++; return sized(png); } });
    let decodes = 0;
    const el = slot();
    c.mountState(el, 'N4');
    await until(() => shown(el));
    await until(() => decodes > 0, 3000);          // N4 was re-decoded after the worker was lost
  });

  it('then bakes every other state at the board size while idle', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    c.mountState(slot(), 'W2');
    await until(() => c.status().baked === 26, 5000);
    expect(c.status()).toMatchObject({ mode: 'bake', baked: 26, total: 26 });
  });

  it('a bake failure falls back to baked by PC for that state (spec §12)', async () => {
    const f = fakes({ bake: 'fail', pc: true });
    const c = make('bake', f.deps);
    const el = slot();
    c.mountState(el, 'S3');
    await until(() => shown(el));
    expect(f.log.bakes.slice(0, 2)).toEqual(['worker:S3:96', 'main:S3:96']);
    expect(f.log.fetches[1]).toMatch(/^\/clay\/sheet\?state=S3&puffed=0&size=96&shadows=1&colour=e07a4f&v=/);
    expect(c.status().reason).toMatch(/^Chosen in settings · bake failed for S3[^(]* \(main broke\), using pc$/);
  });

  it('when the PC cannot bake either, the state goes live', async () => {
    const f = fakes({ bake: 'fail', pc: false });
    const c = make('bake', f.deps);
    const el = slot();
    c.mountState(el, 'X4');
    await until(() => shown(el));
    expect(f.log.renders).toBeGreaterThan(0);
    expect(c.status().reason).toMatch(/pc failed for X4.*using live/);
  });

  it('when every mode fails the placeholder stays', async () => {
    const f = fakes({ bake: 'fail', pc: false, live: 'broken' });
    const c = make('bake', f.deps);
    const el = slot();
    c.mountState(el, 'X3');
    await until(() => c.status().reason.includes('showing the placeholder'));
    expect(el.querySelector('.ph')).not.toBeNull();
  });

  it('sync mounts characters in .char[data-key] slots and unmounts ones whose row went', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const root = document.createElement('main');
    document.body.appendChild(root);
    const a = slot('k1'), b = slot('k2');
    root.append(a, b);
    const now = Date.now();
    c.sync(root, [session('k1', 'working', 3, now), session('k2', 'asleep', 40, now)], now); // S5: 30 to TTL-5 min (spec §7.2 v2)
    await until(() => shown(a) && shown(b));
    expect(f.log.bakes.slice(0, 2).sort()).toEqual(['worker:S5:96', 'worker:W2:96']);
    b.remove();
    c.sync(root, [session('k1', 'working', 3, now)], now);
    expect(b.querySelector('canvas')).toBeNull();
    expect(a.querySelector('canvas')).not.toBeNull();
  });

  it('W1 loops for its whole bracket (round 3: no "plays once" states): a W1 seen 30 s in shows W1, baked first', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const root = document.createElement('main');
    document.body.appendChild(root);
    const late = slot('late');
    root.append(late);
    const now = Date.now();
    c.sync(root, [session('late', 'working', 0.5, now)], now);   // clayStateFor says W1 (0-1 min)
    await until(() => shown(late));
    expect(f.log.bakes[0]).toBe('worker:W1:96'); // round 2 showed (and baked first) W2 here
  });

  it('W1 and S1 sprites keep showing W1 and S1, on the board and in a gallery, and ask for no other sheet (round 3)', () => {
    const asked: string[] = [];
    const env: SpriteEnv = {
      modeFor: () => 'bake', sheet: (k) => { asked.push(k.state); return null; }, pin() {}, unpin() {}, drop() {},
      shadows: () => true, version: RENDERER_VERSION, live: () => false,
    };
    for (const id of ['W1', 'S1'] as const) {
      const sp = new Sprite(slot(), env);
      sp.setDevicePx(96);
      sp.setTarget(id, false, '#e07a4f', 45_000, 0); // 45 s into its bracket
      asked.length = 0;
      for (const t of [1000, 2500, 6000, 9999, 59_000]) sp.tick(t);
      expect(sp.state).toBe(id);
      expect([...new Set(asked)]).toEqual([id]);
      sp.setTarget(id, false, '#e07a4f', 0, 12_000); // re-asked later (new prefs): still itself
      sp.tick(12_500);
      expect(sp.state).toBe(id);
    }
  });

  it('the frame-rate cap and shadows apply through setPrefs; new shadows mean new sheets', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    c.mountState(slot(), 'N2');
    await until(() => f.log.bakes.includes('worker:N2:96'));
    const n = f.log.bakes.filter((b) => b === 'worker:N2:96').length;
    c.setPrefs({ ...DEFAULT_CLAY_PREFS, mode: 'bake', shadows: false, fpsCap: 15 });
    await until(() => f.log.bakes.filter((b) => b === 'worker:N2:96').length > n); // re-baked: the key holds `shadows`
  });

  it('mountLarge draws live and follows the session through later syncs', async () => {
    const f = fakes();
    const c = make('bake', f.deps);
    const now = Date.now();
    const big = slot();
    const stop = c.mountLarge(big, session('k9', 'working', 3, now));
    await until(() => shown(big));
    expect(f.log.stages).toBe(1);
    expect(f.log.renders).toBeGreaterThan(0);
    stop();
    expect(big.querySelector('canvas')).toBeNull();
  });

  it('changing the mode in prefs re-decides', async () => {
    const f = fakes({ live: { fps: 20, worstMs: 80 } });
    const c = make('bake', f.deps);
    await until(() => c.status().reason === 'Chosen in settings');
    c.setPrefs({ ...DEFAULT_CLAY_PREFS, mode: 'live' });
    await until(() => c.status().mode === 'live');
  });
});

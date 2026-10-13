import { bakeSheet, encodeSheet } from './bake.js';
import type { BakeIn, BakeOut } from './bake-worker.js';
import { keyString, type SheetKey } from './sheet.js';
import type { Stage } from './stage.js';

export interface BakeResult { bitmap: ImageBitmap; png: Promise<Blob>; renderMs: number }

export interface BakeBackend {
  readonly name: string;
  bake(key: SheetKey, opts?: { frames?: number; paceMs?: number }): Promise<BakeResult>;
  dispose(): void;
}

/** Rest between frames of an idle (background) bake, so on-screen playback keeps its frames (measured: tools/perf). */
export const IDLE_PACE_MS = 30;

/** Bakes in a Web Worker on an OffscreenCanvas, so the page's own frames never wait for it. */
export class WorkerBackend implements BakeBackend {
  readonly name = 'worker';
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, { bitmap: (r: BakeResult) => void; png: (b: Blob) => void; fail: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  constructor() {
    if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined') throw new Error('no Worker or OffscreenCanvas');
    this.worker = new Worker(new URL('./bake-worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<BakeOut>) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.kind === 'bitmap') {
        let resolvePng!: (b: Blob) => void, rejectPng!: (e: Error) => void;
        const png = new Promise<Blob>((res, rej) => { resolvePng = res; rejectPng = rej; });
        png.catch(() => {});
        p.png = resolvePng;
        p.fail = rejectPng;
        p.bitmap({ bitmap: m.bitmap, png, renderMs: m.renderMs });
      } else if (m.kind === 'png') {
        clearTimeout(p.timer); this.pending.delete(m.id); p.png(m.png);
      } else {
        clearTimeout(p.timer); this.pending.delete(m.id); p.fail(new Error(m.error));
      }
    };
    this.worker.onerror = (e) => this.failAll(new Error(e.message || 'bake worker crashed'));
  }

  bake(key: SheetKey, opts: { frames?: number; paceMs?: number } = {}): Promise<BakeResult> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      // after the bitmap arrives `fail` rejects the PNG instead, so a stuck encode never leaves a caller waiting forever
      const timer = setTimeout(() => { const p = this.pending.get(id); this.pending.delete(id); p?.fail(new Error('bake timed out')); }, 60_000);
      this.pending.set(id, { bitmap: resolve, png: () => {}, fail: reject, timer });
      this.worker.postMessage({ id, key, frames: opts.frames, paceMs: opts.paceMs } satisfies BakeIn);
    });
  }

  private failAll(err: Error) {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.fail(err); }
    this.pending.clear();
  }

  dispose() { this.failAll(new Error('disposed')); this.worker.terminate(); }
}

/** Bakes on the page's Stage, yielding between frames. Used when workers cannot do WebGL. */
export class MainBackend implements BakeBackend {
  readonly name = 'main';
  constructor(private stage: () => Promise<Stage>) {}
  async bake(key: SheetKey, opts: { frames?: number; paceMs?: number } = {}): Promise<BakeResult> {
    const sheet = await bakeSheet(await this.stage(), key, { yieldEvery: 2, ...opts });
    const bitmap = await createImageBitmap(sheet.canvas);
    const png = encodeSheet(sheet.canvas);
    png.catch(() => {});
    return { bitmap, png, renderMs: sheet.renderMs };
  }
  dispose() { /* the stage belongs to the controller */ }
}

interface Job { id: string; key: SheetKey; urgent: boolean; waiters: Array<{ res: (r: BakeResult) => void; rej: (e: Error) => void }> }

/**
 * One bake at a time; urgent (on-screen) jobs before idle ones. When a backend fails, the next one
 * (in the order given) retries the job and stays in use. When the last one fails, the job is
 * rejected: the controller treats that as a bake failure for the state (spec §12).
 */
export class Baker {
  private queue: Job[] = [];
  /** The job being baked; a request for its key joins it rather than queueing a second bake. */
  private active: Job | null = null;
  private running = false;
  private idx = 0;
  private backend: BakeBackend | null = null;
  private disposed = false;
  /**
   * `onLost` runs when a backend is disposed after a failure. Bitmaps a worker made can go blank when that
   * worker is terminated (seen on the tablet: Chrome 131, PowerVR), so the caller re-decodes what it holds.
   * For the same reason a healthy backend is never disposed for being idle.
   */
  constructor(private makers: Array<() => BakeBackend>, private idlePaceMs = IDLE_PACE_MS, private onLost: () => void = () => {}) {}

  bake(key: SheetKey, urgent: boolean): Promise<BakeResult> {
    const id = keyString(key);
    if (this.disposed) return Promise.reject(new Error('disposed'));
    return new Promise((res, rej) => {
      // an in-flight bake keeps the pace it started with: restarting it to go faster would waste the frames already baked
      const hit = this.active?.id === id ? this.active : this.queue.find((j) => j.id === id);
      if (hit) { hit.urgent ||= urgent; hit.waiters.push({ res, rej }); }
      else this.queue.push({ id, key, urgent, waiters: [{ res, rej }] });
      void this.pump();
    });
  }

  /** Jobs waiting or running. */
  get pending(): number { return this.queue.length + (this.running ? 1 : 0); }
  get backendName(): string | null { return this.backend?.name ?? null; }

  private current(): BakeBackend | null {
    if (this.disposed) return null;
    while (!this.backend && this.idx < this.makers.length) {
      try { this.backend = this.makers[this.idx](); } catch { this.idx++; }
    }
    return this.backend;
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.disposed) {
        const i = this.queue.findIndex((j) => j.urgent);
        const job = this.queue.splice(i >= 0 ? i : 0, 1)[0];
        if (!job) return;
        this.active = job;
        try { const r = await this.run(job.key, job.urgent ? 0 : this.idlePaceMs); this.active = null; job.waiters.forEach((w) => w.res(r)); }
        catch (e) { this.active = null; job.waiters.forEach((w) => w.rej(e as Error)); }
      }
    } finally { this.running = false; this.active = null; }
  }

  /** A failing backend hands over to the next one for good; a failure on the last one fails only this job. */
  private async run(key: SheetKey, paceMs: number): Promise<BakeResult> {
    for (;;) {
      if (this.disposed) throw new Error('disposed');
      const b = this.current();
      if (!b) throw new Error('no bake backend available');
      try {
        const r = await b.bake(key, { paceMs });
        if (this.disposed) { r.bitmap.close(); throw new Error('disposed'); }
        return r;
      } catch (e) {
        // torn down mid-bake: the rejection is ours, not the backend's, so no retry, no onLost, no new backend
        if (this.disposed) throw new Error('disposed');
        b.dispose();
        this.backend = null;
        this.onLost();
        if (this.idx >= this.makers.length - 1) throw e;
        this.idx++;
      }
    }
  }

  /** Final: the running job and every queued one reject with 'disposed', and no backend is built again. */
  dispose(): void { this.disposed = true; this.backend?.dispose(); this.backend = null; this.queue.forEach((j) => j.waiters.forEach((w) => w.rej(new Error('disposed')))); this.queue = []; }
}

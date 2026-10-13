import type { Session } from '../../../src/types.js';
import { AUTO_RECORD, chooseMode, nextMode, validAuto, type ConcreteMode } from './auto.js';
import { Baker, MainBackend, WorkerBackend, type BakeBackend } from './baker.js';
import { DECODED_BUDGET, DecodedCache } from './budget.js';
import { measureFrames, type FrameStats } from './measure.js';
import { normaliseClayPrefs, type AnimMode, type ClayPrefs } from './prefs.js';
import { bucketFor, keyString, layoutFor, sheetBytes, type SheetKey } from './sheet.js';
import { MAX_LARGE_LIVE_PX, Sprite, type DecodedSheet, type DrawMode, type SpriteEnv } from './sprite.js';
import type { RenderSpec, Stage } from './stage.js';
import { CLAY_STATES, clayStateFor, type ClayStateId } from './states.js';
import { Ticker } from './ticker.js';
import { RENDERER_VERSION } from './version.js';
import { MemoryStore, openStore, type SheetStore } from './store.js';

export interface ClayStatus { mode: Exclude<AnimMode, 'auto'>; reason: string; baked: number; total: number }

export interface ClayController {
  /** Mount/update a character in every `.char[data-key]` under root; unmount ones gone. */
  sync(root: HTMLElement, sessions: Session[], now: number): void;
  /** One large character (focus view). Follows the session through later sync() calls. Live 3D unless live has failed. */
  mountLarge(el: HTMLElement, session: Session): () => void;
  /** A fixed state, e.g. 'L1' for launcher account cards, or any state for a gallery. Every state loops (round 3). */
  mountState(el: HTMLElement, id: ClayStateId, opts?: { puffed?: boolean; colour?: string }): () => void;
  setPrefs(p: ClayPrefs): void;
  /** What Auto picked and why, for the settings panel. */
  status(): ClayStatus;
  dispose(): void;
}

/** Seams for tests. Every field has a real default. */
export interface ClayDeps {
  openStore(): Promise<SheetStore>;
  backends(stage: () => Promise<Stage>): Array<() => BakeBackend>;
  makeStage(): Promise<Stage>;
  decode(png: Blob): Promise<ImageBitmap>;
  fetch: typeof fetch;
  /** `n` live characters at `px` for `ms`: the Auto trial. */
  liveTrial(stage: Stage, n: number, px: number, shadows: boolean, ms: number): Promise<FrameStats>;
  idle(): Promise<void>;
}

const defaultDeps = (): ClayDeps => ({
  openStore,
  backends: (stage) => [() => new WorkerBackend(), () => new MainBackend(stage)],
  makeStage: async () => { const { Stage } = await import('./stage.js'); return new Stage(document.createElement('canvas')); },
  decode: (png) => createImageBitmap(png),
  fetch: (...a) => fetch(...a),
  liveTrial,
  idle: () => new Promise((r) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => r(), { timeout: 2000 }) : setTimeout(r, 50))),
});

/** `n` characters rendered every frame for `ms`, the way live mode draws them. */
export async function liveTrial(stage: Stage, n: number, px: number, shadows: boolean, ms: number): Promise<FrameStats> {
  const targets = Array.from({ length: n }, () => { const c = document.createElement('canvas'); c.width = c.height = px; return c.getContext('2d')!; });
  const draw = (now: number) => {
    stage.setSize(px);
    targets.forEach((g, i) => {
      stage.render({ state: 'W3', t: (now / 1400 + i / n) % 1, puffed: false, colour: '#e07a4f', shadows });
      g.clearRect(0, 0, px, px);
      g.drawImage(stage.canvas as CanvasImageSource, 0, 0);
    });
  };
  draw(0);
  // warm-up, not measured: shader compiles and first-use texture uploads happen in the first frames, and
  // on the tablet they made a fresh page's first second look like 2 fps (worst frame 930 ms)
  await measureFrames(400, draw);
  return measureFrames(ms, draw);
}

type Bind = { kind: 'session'; key: string } | { kind: 'large'; key: string; last: Session } | { kind: 'fixed'; id: ClayStateId; puffed: boolean; colour?: string };
interface Rec { sprite: Sprite; bind: Bind; ro: ResizeObserver | null }

export function createClayController(o: { prefs: ClayPrefs; cacheTtlMinutes: number | (() => number); deps?: Partial<ClayDeps> }): ClayController {
  return new Controller(normaliseClayPrefs(o.prefs), typeof o.cacheTtlMinutes === 'function' ? o.cacheTtlMinutes : () => o.cacheTtlMinutes as number, { ...defaultDeps(), ...o.deps });
}

class Controller implements ClayController, SpriteEnv {
  readonly version = RENDERER_VERSION;
  private ticker: Ticker | null = null;
  private stopTick: (() => void) | null = null;
  private cache = new DecodedCache<DecodedSheet>(DECODED_BUDGET, (d) => d.bitmap.close());
  private store: Promise<SheetStore>;
  private stored = new Set<string>();
  private baker: Baker;
  private stage: Promise<Stage> | null = null;
  private stageNow: Stage | null = null;
  private liveBroken = false;
  private recs = new Map<HTMLElement, Rec>();
  private loading = new Map<string, Promise<void>>();
  private failed = new Map<ClayStateId, Set<ConcreteMode>>();
  private override = new Map<ClayStateId, ConcreteMode | 'none'>();
  /** Every fallback step, keyed `state|mode`, so the settings panel can show the whole chain (bake -> pc -> live). */
  private failures = new Map<string, { id: ClayStateId; mode: ConcreteMode; why: string; next: ConcreteMode | null }>();
  private mode: ConcreteMode | null = null;
  private reason = 'Measuring this device';
  private generation = 0;
  /** Bumped by every prefetch() so a newer pass (e.g. the board size changed) replaces the running one. */
  private prefetchGen = 0;
  private pc: Promise<boolean> | null = null;
  private io: IntersectionObserver | null = null;
  private sessions = new Map<string, Session>();
  private primary = 96;
  private disposed = false;

  constructor(private prefs: ClayPrefs, private ttl: () => number, private deps: ClayDeps) {
    this.baker = new Baker(deps.backends(() => this.getStage()), undefined, () => this.redecode());
    // `store` resolves only once the stored keys are known, so nothing re-bakes a sheet that is already stored
    this.store = deps.openStore().catch(() => new MemoryStore()).then(async (s) => {
      try { await s.prune(this.version); for (const k of await s.keys()) this.stored.add(k); } catch { /* unreadable: re-bake as needed */ }
      return s;
    });
    void this.decide();
  }

  // ---------- public API ----------

  sync(root: HTMLElement, sessions: Session[], now: number): void {
    if (this.disposed) return;
    for (const s of sessions) this.sessions.set(s.key, s);
    const seen = new Set<HTMLElement>();
    root.querySelectorAll<HTMLElement>('.char[data-key]').forEach((el) => {
      const key = el.dataset.key!;
      const s = this.sessions.get(key);
      if (!s) return;
      seen.add(el);
      const rec = this.recs.get(el) ?? this.attach(el, { kind: 'session', key });
      if (rec.bind.kind === 'session' && rec.bind.key !== key) rec.bind.key = key;
      this.retarget(rec.sprite, s, now);
    });
    for (const [el, rec] of [...this.recs]) {
      if (rec.bind.kind === 'session' && !seen.has(el) && (!el.isConnected || root.contains(el))) this.detach(el);
      else if (rec.bind.kind === 'large') {
        const s = this.sessions.get(rec.bind.key);
        if (s) { rec.bind.last = s; this.retarget(rec.sprite, s, now); }
      }
    }
    const live = new Set(sessions.map((s) => s.key));
    for (const k of [...this.sessions.keys()]) if (!live.has(k)) this.sessions.delete(k);
  }

  mountLarge(el: HTMLElement, session: Session): () => void {
    const rec = this.attach(el, { kind: 'large', key: session.key, last: session });
    this.retarget(rec.sprite, this.sessions.get(session.key) ?? session, Date.now());
    return () => this.detach(el);
  }

  mountState(el: HTMLElement, id: ClayStateId, opts: { puffed?: boolean; colour?: string } = {}): () => void {
    const rec = this.attach(el, { kind: 'fixed', id, puffed: !!opts.puffed, colour: opts.colour });
    rec.sprite.setTarget(id, !!opts.puffed, this.colourFor(opts.colour), 0, performance.now());
    return () => this.detach(el);
  }

  setPrefs(p: ClayPrefs): void {
    const next = normaliseClayPrefs(p);
    const modeChanged = next.mode !== this.prefs.mode;
    this.prefs = next;
    this.ticker?.setCap(next.fpsCap);
    for (const rec of this.recs.values()) {
      if (rec.bind.kind === 'fixed') rec.sprite.setTarget(rec.bind.id, rec.bind.puffed, this.colourFor(rec.bind.colour), 0, performance.now());
    }
    if (modeChanged) { this.mode = null; this.override.clear(); this.failed.clear(); this.failures.clear(); void this.decide(); }
    else this.prefetch();
  }

  status(): ClayStatus {
    let baked = 0;
    for (const id of CLAY_STATES) if (this.stored.has(keyString(this.keyFor(id, this.primary, false)))) baked++;
    const mode = this.mode ?? (this.prefs.mode === 'auto' ? 'bake' : this.prefs.mode);
    const failed = this.failureSummary();
    return { mode, reason: failed ? `${this.reason} · ${failed}` : this.reason, baked, total: CLAY_STATES.length };
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    for (const el of [...this.recs.keys()]) this.detach(el);
    this.io?.disconnect();
    this.ticker?.dispose();
    this.cache.clear();
    this.baker.dispose();
    this.dropStage();
    void this.store.then((s) => s.close());
  }

  // ---------- SpriteEnv ----------

  modeFor(id: ClayStateId, large: boolean): DrawMode | 'none' | null {
    if (this.mode === null) return null;
    const o = this.override.get(id);
    if (o) return o;
    // a weak device cannot afford a large baked sheet; one live character is cheap (spec §7.3)
    if (large && !this.liveBroken && !this.failed.get(id)?.has('live')) return 'live';
    return this.mode;
  }

  shadows(): boolean { return this.prefs.shadows; }

  sheet(key: SheetKey, urgent: boolean): DecodedSheet | null {
    const ks = keyString(key);
    const hit = this.cache.get(ks);
    if (hit) return hit;
    if (!this.loading.has(ks)) this.loading.set(ks, this.load(key, urgent, true).catch(() => {}).finally(() => this.loading.delete(ks)));
    return null;
  }
  pin(key: SheetKey): void { this.cache.pin(keyString(key)); }
  unpin(key: SheetKey): void { this.cache.unpin(keyString(key)); }
  drop(key: SheetKey): void { this.cache.delete(keyString(key)); }

  live(ctx: CanvasRenderingContext2D, px: number, spec: RenderSpec): boolean {
    if (this.liveBroken) { this.fail(spec.state, 'live', 'live 3D would not start'); return false; }
    const st = this.stageNow;
    if (!st) { void this.getStage().catch(() => {}); return false; }
    try {
      st.setSize(px);
      st.render(spec);
      if (st.lost()) throw new Error('context lost');
      ctx.drawImage(st.canvas as CanvasImageSource, 0, 0);
      return true;
    } catch (e) {
      this.fail(spec.state, 'live', String((e as Error).message ?? e));
      return false;
    }
  }

  // ---------- modes ----------

  private async decide(): Promise<void> {
    const gen = ++this.generation;
    const chosen = this.prefs.mode;
    let mode: ConcreteMode;
    let reason: string;
    if (chosen !== 'auto') {
      mode = chosen;
      reason = 'Chosen in settings';
    } else {
      const store = await this.store;
      const rec = await store.getRecord(AUTO_RECORD).catch(() => null);
      if (validAuto(rec, this.version)) ({ mode, reason } = rec);
      else {
        ({ mode, reason } = await this.trial());
        await store.putRecord(AUTO_RECORD, { version: this.version, mode, reason, at: Date.now() }).catch(() => {});
      }
    }
    if (gen !== this.generation || this.disposed) return;
    this.mode = mode;
    this.reason = reason;
    if (mode !== 'live' && !this.hasLarge()) this.dropStage(); // free the GL context
    this.prefetch();
  }

  /** Spec §7.3 Auto: one second of live rendering, then one short bake. */
  private async trial(): Promise<{ mode: ConcreteMode; reason: string }> {
    let live: FrameStats | null = null;
    try { live = await this.deps.liveTrial(await this.getStage(), 5, this.primary, this.prefs.shadows, 1000); }
    catch { this.liveBroken = true; }
    const t = performance.now();
    let bakeOk = false;
    // one key for the bake and the keep: the board can change `primary` while the bake runs, and a sheet kept under
    // another size's key draws as a strip of several frames (then nothing) in every W2 tile
    const key = this.keyFor('W2', this.primary, false);
    try {
      const r = await this.baker.bake(key, true);
      bakeOk = true;
      void this.keep(key, r.bitmap, r.png, true);
    } catch { /* bakeOk stays false */ }
    return chooseMode({ bakeOk, bakeMs: performance.now() - t, live });
  }

  /** Spec §12: a state whose mode failed falls to the next mode; the reason records it for the settings panel. */
  private fail(id: ClayStateId, mode: ConcreteMode, why: string): void {
    const set = this.failed.get(id) ?? new Set<ConcreteMode>();
    if (set.has(mode)) return;
    set.add(mode);
    this.failed.set(id, set);
    const next = nextMode(set, mode);
    this.override.set(id, next ?? 'none');
    this.failures.set(`${id}|${mode}`, { id, mode, why, next });
  }

  /** "bake failed for S3, X4 (worker broke), using pc" — one clause per kind of fallback. */
  private failureSummary(): string {
    const groups = new Map<string, { ids: ClayStateId[]; why: string }>();
    for (const f of this.failures.values()) {
      const k = `${f.mode} failed for |, ${f.next ? `using ${f.next}` : 'showing the placeholder'}`;
      const g = groups.get(k) ?? { ids: [], why: f.why };
      g.ids.push(f.id);
      groups.set(k, g);
    }
    return [...groups].map(([k, g]) => k.replace('|', `${g.ids.join(', ')} (${g.why})`)).join('; ');
  }

  private async pcAvailable(): Promise<boolean> {
    this.pc ??= this.deps.fetch('/clay/status').then(async (r) => r.ok && (await r.json()).pc === true).catch(() => false);
    return this.pc;
  }

  // ---------- sheets ----------

  private keyFor(state: ClayStateId, size: number, puffed: boolean, colour = this.prefs.bodyColour): SheetKey {
    return { state, puffed, size, shadows: this.prefs.shadows, colour, version: this.version };
  }

  /** Get a sheet into the decoded cache (`keep`), or only into storage (idle prefetch). */
  private async load(key: SheetKey, urgent: boolean, keep: boolean): Promise<void> {
    const ks = keyString(key);
    const store = await this.store;
    const png = this.stored.has(ks) ? await store.get(ks).catch(() => null) : null;
    if (png) {
      if (!keep) return;
      try {
        const bitmap = await this.deps.decode(png);
        const l = layoutFor(key);
        // a sheet stored under another size's key (an Auto trial once kept one) draws as a strip of frames: bake it again
        if (bitmap.width !== l.width || bitmap.height !== l.height) { bitmap.close(); throw new Error('stored sheet does not match its key'); }
        this.cache.set(ks, { bitmap, layout: l }, sheetBytes(l));
        return;
      } catch {
        // a corrupt or unreadable stored sheet: forget it and make it again below (the new one overwrites it)
        this.stored.delete(ks);
      }
    }
    const mode = this.modeFor(key.state, false);
    if (mode === 'bake') {
      try {
        const r = await this.baker.bake(key, urgent);
        const saved = this.keep(key, r.bitmap, r.png, keep);
        // an idle prefetch stays "loading" until its sheet is stored, so a character asking for the same sheet
        // meanwhile waits for it instead of baking it a second time
        if (!keep) await saved;
      } catch (e) { this.fail(key.state, 'bake', String((e as Error).message ?? e)); }
    } else if (mode === 'pc') {
      try {
        if (!(await this.pcAvailable())) throw new Error('the daemon cannot bake (no headless browser)');
        const q = new URLSearchParams({ state: key.state, puffed: key.puffed ? '1' : '0', size: String(key.size), shadows: key.shadows ? '1' : '0', colour: key.colour.slice(1), v: key.version });
        const res = await this.deps.fetch(`/clay/sheet?${q}`);
        if (!res.ok) throw new Error(`daemon answered ${res.status}`);
        if (Number(res.headers.get('x-clay-frames')) !== layoutFor(key).frames) throw new Error('daemon sheet does not match this renderer');
        const blob = await res.blob();
        const saved = this.keep(key, await this.deps.decode(blob), Promise.resolve(blob), keep);
        if (!keep) await saved;
      } catch (e) { this.fail(key.state, 'pc', String((e as Error).message ?? e)); }
    }
  }

  /** Decode-cache the bitmap (or close it) and store the PNG. Resolves once stored (or the store failed). */
  private keep(key: SheetKey, bitmap: ImageBitmap, png: Promise<Blob>, keep: boolean): Promise<void> {
    const ks = keyString(key);
    if (keep && !this.disposed) this.cache.set(ks, { bitmap, layout: layoutFor(key) }, sheetBytes(layoutFor(key)));
    else bitmap.close();
    return png.then(async (b) => { await (await this.store).put(ks, b, this.version); this.stored.add(ks); }).catch(() => {});
  }

  /**
   * Bake (or fetch) every state at the board's size while the page is idle, one at a time. A new call replaces a
   * running pass (it has its own generation, so a board resize never cancels a re-decide); sheets already stored
   * or loading are skipped, so a restart costs nothing.
   */
  private prefetch(): void {
    if (this.mode !== 'bake' && this.mode !== 'pc') return;
    const gen = this.generation;
    const pgen = ++this.prefetchGen;
    void (async () => {
      await this.store;
      for (const id of CLAY_STATES) {
        await this.deps.idle();
        if (gen !== this.generation || pgen !== this.prefetchGen || this.disposed) return;
        const key = this.keyFor(id, this.primary, false);
        const ks = keyString(key);
        if (this.stored.has(ks) || this.cache.has(ks) || this.loading.has(ks)) continue;
        if (this.modeFor(id, false) !== this.mode) continue;
        const p = this.load(key, false, false).catch(() => {});
        this.loading.set(ks, p.finally(() => this.loading.delete(ks)));
        await p;
      }
    })();
  }

  /** A bake backend died: bitmaps it made may be blank now. Drop every decoded sheet; sprites reload from storage. */
  private redecode(): void {
    this.cache.clear();
    for (const r of this.recs.values()) r.sprite.forget();
  }

  // ---------- stage ----------

  private getStage(): Promise<Stage> {
    if (this.stage) return this.stage;
    const p: Promise<Stage> = this.deps.makeStage().then((s) => {
      // Dropped while it was being made (the focus view closed first, or dispose): nothing will ever dispose it
      // later, and a WebGL context is scarce on the tablet, so free it now.
      if (this.stage !== p || this.disposed) { s.dispose(); throw new Error('the live stage was dropped before it was ready'); }
      this.stageNow = s;
      return s;
    }, (e) => { if (this.stage === p) { this.liveBroken = true; this.stage = null; } throw e; });
    this.stage = p;
    return p;
  }
  private dropStage(): void {
    const s = this.stageNow;
    this.stage = null;
    this.stageNow = null;
    s?.dispose();
  }
  private hasLarge(): boolean { for (const r of this.recs.values()) if (r.bind.kind === 'large') return true; return false; }

  // ---------- sprites ----------

  private colourFor(c?: string): string { return c && /^#[0-9a-fA-F]{6}$/.test(c) ? c.toLowerCase() : this.prefs.bodyColour; }

  private retarget(sprite: Sprite, s: Session, now: number): void {
    const { id, puffed } = clayStateFor(s, now, this.ttl());
    sprite.setTarget(id, puffed, this.prefs.bodyColour, now - s.stateSince, performance.now());
  }

  private attach(el: HTMLElement, bind: Bind): Rec {
    this.detach(el);
    const sprite = new Sprite(el, this, bind.kind === 'large');
    const measure = () => {
      const dpr = globalThis.devicePixelRatio || 1;
      const px = Math.round(Math.min(el.clientWidth, el.clientHeight) * dpr);
      if (bind.kind === 'large') {
        // the focus character is drawn at its slot's full device size, never stretched: clientWidth rounds the
        // slot's fractional CSS size (clamp(…30vh…)) down, so round the exact box up instead
        const r = el.getBoundingClientRect();
        const exact = Math.ceil(Math.min(r.width, r.height) * dpr - 0.01);
        sprite.setDevicePx(Math.min(Math.max(px, exact), MAX_LARGE_LIVE_PX));
        return;
      }
      sprite.setDevicePx(px);
      if (bind.kind === 'session' && px > 0) this.updatePrimary();
    };
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    if (typeof IntersectionObserver === 'function') {
      this.io ??= new IntersectionObserver((entries) => {
        for (const e of entries) { const r = this.recs.get(e.target as HTMLElement); if (r) r.sprite.onScreen = e.isIntersecting; }
      });
      this.io.observe(el);
    }
    const rec: Rec = { sprite, bind, ro };
    this.recs.set(el, rec);
    if (bind.kind === 'session') this.updatePrimary();
    this.ticker ??= new Ticker(this.prefs.fpsCap);
    // one character's failure must never stop the others: each tick is isolated
    this.stopTick ??= this.ticker.add((now) => { for (const r of this.recs.values()) { try { r.sprite.tick(now); } catch (e) { console.error('clay: a character failed to draw', e); } } });
    if (bind.kind === 'large') void this.getStage().catch(() => {});
    return rec;
  }

  /**
   * The size idle prefetch bakes at: the smallest board slot. A needs-you row is 1.5x taller; letting it set the
   * size would flip prefetch (and `status().baked`) between two sizes as rows change state.
   */
  private updatePrimary(): void {
    let min = Infinity;
    for (const r of this.recs.values()) if (r.bind.kind === 'session' && r.sprite.px > 0) min = Math.min(min, r.sprite.px);
    if (!Number.isFinite(min)) return;
    const next = bucketFor(min);
    if (next === this.primary) return;
    this.primary = next;
    this.prefetch(); // the pass so far baked at the old size: start again at the board's real size
  }

  private detach(el: HTMLElement): void {
    const rec = this.recs.get(el);
    if (!rec) return;
    rec.ro?.disconnect();
    this.io?.unobserve(el);
    rec.sprite.destroy();
    this.recs.delete(el);
    if (!this.recs.size) { this.stopTick?.(); this.stopTick = null; }
    // Not while Auto is still deciding (mode null): its trial is using the stage, and decide() drops it afterwards.
    if (rec.bind.kind === 'large' && this.mode !== null && this.mode !== 'live' && !this.hasLarge()) this.dropStage();
  }
}

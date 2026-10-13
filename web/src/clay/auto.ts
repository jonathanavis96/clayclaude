import type { FrameStats } from './measure.js';

export type ConcreteMode = 'bake' | 'live' | 'pc';

/** Spec §7.3: live only at 55+ fps with no frame over 50 ms. */
export const AUTO_LIVE_MIN_FPS = 55;
export const AUTO_LIVE_MAX_FRAME_MS = 50;

export interface AutoTrial {
  /** The short bake finished and produced pixels. */
  bakeOk: boolean;
  bakeMs: number;
  /** One second of live rendering, or null when WebGL would not start. */
  live: FrameStats | null;
}

/** Spec §7.3 Auto: live when it holds 55+ fps with no frame over 50 ms; else bake on device; PC only if baking fails. Pure. */
export function chooseMode(t: AutoTrial): { mode: ConcreteMode; reason: string } {
  const liveTxt = t.live ? `live ran at ${t.live.fps} fps, worst frame ${t.live.worstMs} ms` : 'live 3D would not start';
  if (t.live && t.live.fps >= AUTO_LIVE_MIN_FPS && t.live.worstMs <= AUTO_LIVE_MAX_FRAME_MS) return { mode: 'live', reason: liveTxt };
  if (t.bakeOk) return { mode: 'bake', reason: `${liveTxt}; a test bake took ${Math.round(t.bakeMs)} ms` };
  return { mode: 'pc', reason: `${liveTxt}; baking on this device failed` };
}

/** Spec §12: when a mode fails for a state, the next one in this order that has not failed yet. null: none left. */
export function nextMode(failed: ReadonlySet<ConcreteMode>, from: ConcreteMode): ConcreteMode | null {
  const order: Record<ConcreteMode, ConcreteMode[]> = { bake: ['pc', 'live'], pc: ['live', 'bake'], live: ['bake', 'pc'] };
  return order[from].find((m) => !failed.has(m)) ?? null;
}

/** The stored Auto result. Reused only for the same renderer version (spec: re-checked when it changes). */
export interface AutoRecord { version: string; mode: ConcreteMode; reason: string; at: number }
export const AUTO_RECORD = 'auto';

export function validAuto(r: unknown, version: string): r is AutoRecord {
  const x = r as AutoRecord | null;
  return !!x && x.version === version && (x.mode === 'bake' || x.mode === 'live' || x.mode === 'pc') && typeof x.reason === 'string';
}

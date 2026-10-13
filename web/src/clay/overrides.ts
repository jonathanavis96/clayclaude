/**
 * The authored-override layer (spec §7.4.7): when a derived pose is wrong in one place, the fix is to say the
 * answer in web/src/clay/overrides.json, not to re-tune the procedure. A state with no entry renders exactly as
 * derived. Entries apply last: after the script and the timeline (X2 included), before the character is posed.
 * The tablet's baker, live mode, the PC baker and the snapshot tests all import this module, so they all agree.
 */
import raw from './overrides.json';
import {
  type Ease, type GlyphKey, type GlyphOffset, KEY_RANGES, type OverrideEntry, type Overrides, type PropName,
  type PropXform, type Track, clampTo, parseOverrides,
} from './override-schema.js';
import { POSE_KEYS, type Pose, type PoseKey } from './pose.js';
import type { ClayStateId } from './states.js';

/**
 * Check a loaded file. In development (Vite dev, Vitest) a bad file is an error at load; in production the bad
 * parts are left out with a console warning, so a slip in the file never takes the board down.
 */
export function loadOverrides(x: unknown, dev: boolean): Overrides {
  const { value, errors } = parseOverrides(x);
  if (errors.length && dev) throw new Error(`clay overrides.json: ${errors.join('; ')}`);
  if (errors.length) console.warn(`clay overrides.json: ignored ${errors.join('; ')}`);
  return value;
}

let current: Overrides = loadOverrides(raw, !!import.meta.env?.DEV);

/** The overrides in force. */
export const getOverrides = (): Overrides => current;
/** Replace the overrides in force (the pose editor's live preview, and tests). Checked like a loaded file. */
export function setOverrides(o: Overrides): void { current = loadOverrides(o, true); }

const entries = (id: ClayStateId): OverrideEntry[] => [current['*'], current[id]].filter((e): e is OverrideEntry => !!e);

const smooth = (x: number) => (1 - Math.cos(Math.PI * x)) / 2;
/** A track's value at loop position `t`: keyframes interpolate and wrap from the last key back to the first. */
export function evalTrack(tr: Track, t: number, ease: Ease = 'linear'): number {
  if (typeof tr === 'number') return tr;
  const k = tr;
  if (k.length === 1) return k[0][1];
  const u = t - Math.floor(t);
  let i = k.length - 1;
  while (i >= 0 && k[i][0] > u) i--;
  // a is the key at or before u (wrapping to the last key), b the next one (wrapping to the first, one loop on)
  const [ta, va] = i < 0 ? [k[k.length - 1][0] - 1, k[k.length - 1][1]] : k[i];
  const [tb, vb] = i + 1 < k.length ? k[i + 1] : [k[0][0] + 1, k[0][1]];
  const f = tb > ta ? (u - ta) / (tb - ta) : 0;
  return va + (vb - va) * (ease === 'smooth' ? smooth(f) : f);
}

/** `p` with the overrides of state `id` applied at loop position `t`. Pure; a state with no entry is unchanged. */
export function applyOverrides(id: ClayStateId, t: number, p: Pose): Pose {
  const es = entries(id);
  if (!es.length) return p;
  const out = { ...p };
  for (const e of es) {
    const ease = e.timing?.ease ?? {};
    const touched = new Set<PoseKey>();
    for (const [k, tr] of Object.entries(e.pose ?? {}) as Array<[PoseKey, Track]>) { out[k] = evalTrack(tr, t, ease[k]); touched.add(k); }
    for (const [k, tr] of Object.entries(e.offsets ?? {}) as Array<[PoseKey, Track]>) { out[k] += evalTrack(tr, t, ease[k]); touched.add(k); }
    for (const k of touched) out[k] = clampTo(out[k], KEY_RANGES[k]);
  }
  return out;
}

/** Loop length of `id` in ms: its authored timing, or `derived`. */
export function loopMsFor(id: ClayStateId, derived: number): number {
  let ms = derived;
  for (const e of entries(id)) if (e.timing?.loopMs !== undefined) ms = Math.round(e.timing.loopMs);
  return ms;
}

/** What the character applies on top of its own placement of props and glyphs for state `id`. */
export interface Authored { props: Partial<Record<PropName, Required<PropXform>>>; glyphs: Partial<Record<GlyphKey, Required<GlyphOffset>>> }

/** Props and glyph offsets of `id` ("*" first, then the state's own entry on top), with defaults filled in. */
export function authoredFor(id: ClayStateId): Authored {
  const a: Authored = { props: {}, glyphs: {} };
  for (const e of entries(id)) {
    for (const [k, x] of Object.entries(e.props ?? {}) as Array<[PropName, PropXform]>) {
      const b = a.props[k] ?? { x: 0, y: 0, z: 0, rot: 0, scale: 1 };
      a.props[k] = { x: b.x + (x.x ?? 0), y: b.y + (x.y ?? 0), z: b.z + (x.z ?? 0), rot: b.rot + (x.rot ?? 0), scale: b.scale * (x.scale ?? 1) };
    }
    for (const [k, g] of Object.entries(e.glyphs ?? {}) as Array<[GlyphKey, GlyphOffset]>) {
      const b = a.glyphs[k] ?? { dx: 0, dy: 0, scale: 1 };
      a.glyphs[k] = { dx: b.dx + (g.dx ?? 0), dy: b.dy + (g.dy ?? 0), scale: b.scale * (g.scale ?? 1) };
    }
  }
  return a;
}

export { POSE_KEYS };

/**
 * The authored-override file (web/src/clay/overrides.json, spec §7.4.7): what it may contain, each value's valid
 * range, and how it is checked, rounded and written. Pure: no three.js, no DOM, so the Vite dev endpoint
 * (web/clay-overrides-plugin.ts) and the tests use it as-is.
 *
 * Shape, keyed by state id ("W1" … "L1"), or "*" for an entry every state shares (the "?" centring):
 *   pose:    { <poseKey>: number | [[t, v], …] }   replaces the derived value (constant, or keyframes over the loop)
 *   offsets: { <poseKey>: number | [[t, v], …] }   added to the derived value
 *   props:   { <prop>: { x, y, z, rot, scale } }   moves a prop: x/y/z added (body units, the prop's own parent
 *                                                  space), rot added about z (radians), scale multiplied
 *   glyphs:  { <glyph>: { dx, dy, scale } }        moves a glyph inside its prop: dx/dy in the glyph's own units
 *                                                  (its box is about 0.6 wide and 1 tall), scale multiplied
 *   timing:  { loopMs, ease: { <poseKey>: "linear" | "smooth" } }
 * Keyframe times are loop fractions in [0, 1); between keys the value is linear (or smooth), and after the last key
 * it runs back to the first, so a keyframed override loops seamlessly.
 */
import { POSE_KEYS, type PoseKey } from './pose.js';
import { CLAY_STATES, type ClayStateId } from './states.js';

export type Track = number | ReadonlyArray<readonly [number, number]>;
export interface PropXform { x?: number; y?: number; z?: number; rot?: number; scale?: number }
export interface GlyphOffset { dx?: number; dy?: number; scale?: number }
export type Ease = 'linear' | 'smooth';
export interface OverrideEntry {
  pose?: Partial<Record<PoseKey, Track>>;
  offsets?: Partial<Record<PoseKey, Track>>;
  props?: Partial<Record<PropName, PropXform>>;
  glyphs?: Partial<Record<GlyphKey, GlyphOffset>>;
  timing?: { loopMs?: number; ease?: Partial<Record<PoseKey, Ease>> };
}
export type OverrideKey = ClayStateId | '*';
export type Overrides = Partial<Record<OverrideKey, OverrideEntry>>;

/** Every movable part of the character, by the name `Character.inspect().parts` reports. */
export const PROP_NAMES = [
  'laptop', 'bits', 'sweat', 'fastHands', 'steam', 'headphones', 'headband', 'sleeves', 'watch', 'hourglass', 'bell',
  'mug', 'tea', 'stool', 'alarm', 'speech', 'bed', 'blanket', 'ice', 'battery', 'press', 'zzz', 'qbubble', 'qmark', 'sparkle',
  'knock', 'gauge', 'narrowEyes', 'flatEyes', 'wideEyes', 'browsDown', 'angerPuff', 'snore', 'blurHands',
] as const;
export type PropName = (typeof PROP_NAMES)[number];

/** Glyphs, by name: `q` is every "?" (bubble, floating mark), `0`/`1` the bits, `Z` the Zzz, `F` the gauge's, `bang` the "!". */
export const GLYPH_KEYS = ['q', '0', '1', 'Z', 'F', 'bang'] as const; // no 'check' since gallery review note C
export type GlyphKey = (typeof GLYPH_KEYS)[number];

const ANGLE: readonly [number, number] = [-3.2, 3.2];
const UNIT: readonly [number, number] = [0, 1];
const SIGNED: readonly [number, number] = [-1, 1];
/** Valid range of every pose key. Anything not listed is a 0..1 switch, level or phase. */
export const KEY_RANGES: Readonly<Record<PoseKey, readonly [number, number]>> = Object.freeze({
  ...(Object.fromEntries(POSE_KEYS.map((k) => [k, UNIT])) as Record<PoseKey, readonly [number, number]>),
  aLx: ANGLE, aLz: ANGLE, aRx: ANGLE, aRz: ANGLE, lLx: ANGLE, lRx: ANGLE, lRz: ANGLE,
  squash: [-0.6, 0.6], bodyY: [-0.6, 0.6], bodyX: [-0.6, 0.6], lean: [-1.6, 1.6], nod: [-1.6, 1.6], turn: [-1.6, 1.6],
  lookX: SIGNED, lookY: SIGNED, mouthCurve: SIGNED, brow: SIGNED, alarmShake: SIGNED, bellSwing: [-1.6, 1.6],
  mouthOpen: [0, 0.2], // the mouth stays a thin line or a tiny closed shape (spec §7.4.3, no beard)
});
export const PROP_RANGES = { x: [-2, 2], y: [-2, 2], z: [-2, 2], rot: [-Math.PI, Math.PI], scale: [0.1, 3] } as const;
export const GLYPH_RANGES = { dx: [-1, 1], dy: [-1, 1], scale: [0.25, 3] } as const;
export const LOOP_MS_RANGE = [300, 10_000] as const;

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
export const clampTo = (v: number, [lo, hi]: readonly [number, number]) => Math.max(lo, Math.min(hi, v));

/**
 * Check `raw` against the shape. Returns what is valid (anything unknown or malformed left out) and a message per
 * problem. With `ranges`, an out-of-range number is a problem too (the editor's Save); without, it is kept and
 * clamped when applied (spec: values are clamped instead of erroring).
 */
export function parseOverrides(raw: unknown, opts: { ranges?: boolean } = {}): { value: Overrides; errors: string[] } {
  const errors: string[] = [];
  const value: Overrides = {};
  const num = (v: unknown, at: string, range?: readonly [number, number]): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { errors.push(`${at}: not a finite number`); return undefined; }
    if (opts.ranges && range && (v < range[0] || v > range[1])) { errors.push(`${at}: ${v} outside ${range[0]}..${range[1]}`); return undefined; }
    return v;
  };
  const track = (v: unknown, at: string, range?: readonly [number, number]): Track | undefined => {
    if (!Array.isArray(v)) return num(v, at, range);
    const keys: Array<[number, number]> = [];
    for (const [i, kv] of v.entries()) {
      if (!Array.isArray(kv) || kv.length !== 2) { errors.push(`${at}[${i}]: not a [t, value] pair`); return undefined; }
      const t = num(kv[0], `${at}[${i}] time`, [0, 1]), x = num(kv[1], `${at}[${i}] value`, range);
      if (t === undefined || x === undefined) return undefined;
      if (t < 0 || t > 1) { errors.push(`${at}[${i}]: time ${t} outside 0..1`); return undefined; }
      if (keys.length && t <= keys[keys.length - 1][0]) { errors.push(`${at}[${i}]: times must increase`); return undefined; }
      keys.push([t, x]);
    }
    if (!keys.length) { errors.push(`${at}: no keyframes`); return undefined; }
    return keys;
  };
  const record = <K extends string, V>(v: unknown, at: string, names: readonly string[], item: (x: unknown, at: string, k: K) => V | undefined) => {
    if (!isObj(v)) { errors.push(`${at}: not an object`); return undefined; }
    const outR: Partial<Record<K, V>> = {};
    for (const [k, x] of Object.entries(v)) {
      if (!names.includes(k)) { errors.push(`${at}.${k}: unknown name`); continue; }
      const got = item(x, `${at}.${k}`, k as K);
      if (got !== undefined) outR[k as K] = got;
    }
    return outR;
  };
  const xform = <R extends Record<string, readonly [number, number]>>(ranges: R) => (x: unknown, at: string) =>
    record(x, at, Object.keys(ranges), (v, a, k: string) => num(v, a, ranges[k])) as { [K in keyof R]?: number } | undefined;

  if (!isObj(raw)) return { value, errors: ['overrides: not an object'] };
  for (const [id, e] of Object.entries(raw)) {
    if (id !== '*' && !(CLAY_STATES as readonly string[]).includes(id)) { errors.push(`${id}: unknown state`); continue; }
    if (!isObj(e)) { errors.push(`${id}: not an object`); continue; }
    const entry: OverrideEntry = {};
    for (const [part, v] of Object.entries(e)) {
      const at = `${id}.${part}`;
      if (part === 'pose' || part === 'offsets') {
        const r = record(v, at, POSE_KEYS, (x, a, k: PoseKey) => track(x, a, part === 'pose' ? KEY_RANGES[k] : undefined));
        if (r) entry[part] = r;
      } else if (part === 'props') {
        const r = record(v, at, PROP_NAMES, xform(PROP_RANGES));
        if (r) entry.props = r;
      } else if (part === 'glyphs') {
        const r = record(v, at, GLYPH_KEYS, xform(GLYPH_RANGES));
        if (r) entry.glyphs = r;
      } else if (part === 'timing') {
        const r = record(v, at, ['loopMs', 'ease'], (x, a, k: string) => k === 'loopMs'
          ? num(x, a, LOOP_MS_RANGE)
          : record(x, a, POSE_KEYS, (ev, ea) => (ev === 'linear' || ev === 'smooth' ? ev : (errors.push(`${ea}: not "linear" or "smooth"`), undefined))));
        if (r) entry.timing = r as OverrideEntry['timing'];
      } else errors.push(`${at}: unknown part`);
    }
    value[id as OverrideKey] = entry;
  }
  return { value, errors };
}

/** Every number rounded to 3 decimal places (the editor's Save, before the range checks). */
export function roundDeep(x: unknown): unknown {
  if (typeof x === 'number') return Number.isFinite(x) ? Math.round(x * 1000) / 1000 + 0 : x;
  if (Array.isArray(x)) return x.map(roundDeep);
  if (isObj(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, roundDeep(v)]));
  return x;
}

/** Pretty-printed with sorted keys (keyframe arrays keep their order, a pair per line), ending in a newline: stable diffs. */
export function serializeOverrides(o: Overrides): string {
  const sort = (x: unknown): unknown => Array.isArray(x) ? x.map(sort)
    : isObj(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x;
  // keyframes stay one [t, value] pair per line
  return `${JSON.stringify(sort(o), null, 2).replace(/\[\s+(-?[\d.e+-]+),\s+(-?[\d.e+-]+)\s+\]/g, '[$1, $2]')}\n`;
}

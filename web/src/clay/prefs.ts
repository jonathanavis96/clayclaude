export type AnimMode = 'auto' | 'bake' | 'live' | 'pc';
export interface ClayPrefs { mode: AnimMode; shadows: boolean; fpsCap: 15 | 30 | 60; bodyColour: string }

export const DEFAULT_CLAY_PREFS: ClayPrefs = Object.freeze({ mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' }) as ClayPrefs;

/** Keeps known-good values and fills the rest from the defaults. Never throws. */
export function normaliseClayPrefs(p: unknown): ClayPrefs {
  const o = (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;
  const d = DEFAULT_CLAY_PREFS;
  return {
    mode: o.mode === 'auto' || o.mode === 'bake' || o.mode === 'live' || o.mode === 'pc' ? o.mode : d.mode,
    shadows: typeof o.shadows === 'boolean' ? o.shadows : d.shadows,
    fpsCap: o.fpsCap === 15 || o.fpsCap === 30 || o.fpsCap === 60 ? o.fpsCap : d.fpsCap,
    bodyColour: typeof o.bodyColour === 'string' && /^#[0-9a-fA-F]{6}$/.test(o.bodyColour) ? o.bodyColour.toLowerCase() : d.bodyColour,
  };
}

export const PREFS_KEY = 'clayclaude.prefs';
export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

/** Reads `clay` from the shared `clayclaude.prefs` object. Tolerates anything. */
export function readClayPrefs(s: StorageLike): ClayPrefs {
  try { return normaliseClayPrefs((JSON.parse(s.getItem(PREFS_KEY) ?? '{}') ?? {}).clay); } catch { return { ...DEFAULT_CLAY_PREFS }; }
}

/** Writes only the `clay` key, keeping every other key in the shared object. */
export function writeClayPrefs(s: StorageLike, p: ClayPrefs): void {
  try {
    let o: Record<string, unknown> = {};
    try { const j = JSON.parse(s.getItem(PREFS_KEY) ?? '{}'); if (j && typeof j === 'object' && !Array.isArray(j)) o = j; } catch { /* start fresh */ }
    s.setItem(PREFS_KEY, JSON.stringify({ ...o, clay: normaliseClayPrefs(p) }));
  } catch { /* storage blocked */ }
}

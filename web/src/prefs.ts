export interface NightPrefs { enabled: boolean; from: string; to: string; level: number }

/** Everything Plan 3 stores. Other keys in the same object (`meters` from Plan 1, `clay` from Plan 2) are left alone. */
export interface AppPrefs {
  meters: 'rings' | 'bars';
  /** Spec §5.3: strips, the grid of cards, or auto (the grid when the strips would not fit). */
  layout: 'auto' | 'strips' | 'grid';
  night: NightPrefs;
  sound: boolean;
  /** null = use the daemon's stoppedRetention. */
  stoppedRetentionMs: number | null;
  /** null = use the daemon config's default. */
  confirmBeforeSend: boolean | null;
  quickReplies: string[] | null;
  /** Task 45: list headless helpers (`claude -p`, the Agent SDK) too. Off by default. */
  showBackground: boolean;
}

export const DEFAULT_PREFS: AppPrefs = {
  meters: 'rings', layout: 'auto',
  night: { enabled: false, from: '22:00', to: '06:30', level: 0.6 },
  sound: false, stoppedRetentionMs: null, confirmBeforeSend: null, quickReplies: null, showBackground: false,
};

export const KEY = 'clayclaude.prefs';
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/** Tolerant: missing or wrong-typed keys fall back to defaults. */
export function parsePrefs(raw: string | null): AppPrefs {
  let o: Record<string, unknown> = {};
  try { const j = raw ? JSON.parse(raw) : {}; if (isObj(j)) o = j; } catch { /* corrupt storage */ }
  const n = isObj(o.night) ? o.night : {};
  const d = DEFAULT_PREFS;
  return {
    meters: o.meters === 'bars' ? 'bars' : 'rings',
    layout: o.layout === 'strips' || o.layout === 'grid' ? o.layout : 'auto',
    night: {
      enabled: n.enabled === true,
      from: typeof n.from === 'string' && HM.test(n.from) ? n.from : d.night.from,
      to: typeof n.to === 'string' && HM.test(n.to) ? n.to : d.night.to,
      level: typeof n.level === 'number' && n.level >= 0 && n.level <= 0.9 ? n.level : d.night.level,
    },
    sound: o.sound === true,
    stoppedRetentionMs: typeof o.stoppedRetentionMs === 'number' && o.stoppedRetentionMs > 0 ? o.stoppedRetentionMs : null,
    confirmBeforeSend: typeof o.confirmBeforeSend === 'boolean' ? o.confirmBeforeSend : null,
    quickReplies: Array.isArray(o.quickReplies) ? o.quickReplies.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 12) : null,
    showBackground: o.showBackground === true,
  };
}

export interface StorageLike { getItem(k: string): string | null; setItem(k: string, v: string): void }

export function loadPrefs(s: StorageLike): AppPrefs {
  try { return parsePrefs(s.getItem(KEY)); } catch { return parsePrefs(null); }
}

/** Merge our keys into the stored object so Plan 1 and Plan 2 keys survive. */
export function savePrefs(s: StorageLike, p: AppPrefs): void {
  try {
    let o: Record<string, unknown> = {};
    try { const j = JSON.parse(s.getItem(KEY) ?? '{}'); if (isObj(j)) o = j; } catch { /* start fresh */ }
    s.setItem(KEY, JSON.stringify({ ...o, ...p }));
  } catch { /* storage blocked */ }
}

export interface ConfigDefaults { quickReplies: string[]; confirmBeforeSend: boolean; stoppedRetentionMs: number }

export function effective(p: AppPrefs, d: ConfigDefaults) {
  return {
    quickReplies: p.quickReplies && p.quickReplies.length ? p.quickReplies : d.quickReplies,
    confirmBeforeSend: p.confirmBeforeSend ?? d.confirmBeforeSend,
    stoppedRetentionMs: p.stoppedRetentionMs ?? d.stoppedRetentionMs,
  };
}

/** Plan 2 keeps its renderer prefs under `clay` in the same stored object. These read and write only that key. */
export function loadClayPrefs<T extends object>(s: StorageLike, defaults: T): T {
  try {
    const j = JSON.parse(s.getItem(KEY) ?? '{}');
    return isObj(j) && isObj(j.clay) ? { ...defaults, ...(j.clay as Partial<T>) } : { ...defaults };
  } catch { return { ...defaults }; }
}

export function saveClayPrefs<T extends object>(s: StorageLike, clay: T): void {
  try {
    let o: Record<string, unknown> = {};
    try { const j = JSON.parse(s.getItem(KEY) ?? '{}'); if (isObj(j)) o = j; } catch { /* start fresh */ }
    s.setItem(KEY, JSON.stringify({ ...o, clay }));
  } catch { /* storage blocked */ }
}

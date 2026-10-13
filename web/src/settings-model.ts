import type { AppPrefs } from './prefs.js';
import type { ClayPrefs } from './clay/index.js';

export type PrefName =
  | 'clay.mode' | 'clay.shadows' | 'clay.fpsCap' | 'clay.bodyColour'
  | 'meters' | 'layout' | 'night.enabled' | 'night.from' | 'night.to' | 'night.level'
  | 'sound' | 'stoppedRetentionMs' | 'confirmBeforeSend' | 'quickReplies' | 'showBackground';

const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const RETENTION_CHOICES: [string, number][] = [['15 minutes', 15 * 60_000], ['1 hour', 3_600_000], ['3 hours', 3 * 3_600_000], ['12 hours', 12 * 3_600_000], ['24 hours', 24 * 3_600_000]];

/** Apply one control change. Invalid values leave things as they were. */
export function applyChange(p: AppPrefs, clay: ClayPrefs, name: PrefName, raw: string | boolean): { prefs: AppPrefs; clay: ClayPrefs } {
  const s = String(raw);
  const on = raw === true;
  switch (name) {
    case 'clay.mode': return ['auto', 'bake', 'live', 'pc'].includes(s) ? { prefs: p, clay: { ...clay, mode: s as ClayPrefs['mode'] } } : { prefs: p, clay };
    case 'clay.shadows': return { prefs: p, clay: { ...clay, shadows: on } };
    case 'clay.fpsCap': return [15, 30, 60].includes(Number(s)) ? { prefs: p, clay: { ...clay, fpsCap: Number(s) as ClayPrefs['fpsCap'] } } : { prefs: p, clay };
    case 'clay.bodyColour': return /^#[0-9a-fA-F]{6}$/.test(s) ? { prefs: p, clay: { ...clay, bodyColour: s } } : { prefs: p, clay };
    case 'layout': return s === 'auto' || s === 'strips' || s === 'grid' ? { prefs: { ...p, layout: s }, clay } : { prefs: p, clay };
    case 'meters': return { prefs: { ...p, meters: s === 'bars' ? 'bars' : 'rings' }, clay };
    case 'night.enabled': return { prefs: { ...p, night: { ...p.night, enabled: on } }, clay };
    case 'night.from': return HM.test(s) ? { prefs: { ...p, night: { ...p.night, from: s } }, clay } : { prefs: p, clay };
    case 'night.to': return HM.test(s) ? { prefs: { ...p, night: { ...p.night, to: s } }, clay } : { prefs: p, clay };
    case 'night.level': { const n = Number(s) / 100; return n >= 0.1 && n <= 0.9 ? { prefs: { ...p, night: { ...p.night, level: n } }, clay } : { prefs: p, clay }; }
    case 'sound': return { prefs: { ...p, sound: on }, clay };
    case 'showBackground': return { prefs: { ...p, showBackground: on }, clay };
    case 'stoppedRetentionMs': { const n = Number(s); return { prefs: { ...p, stoppedRetentionMs: s === '' ? null : n > 0 ? n : p.stoppedRetentionMs }, clay }; }
    case 'confirmBeforeSend': return { prefs: { ...p, confirmBeforeSend: on }, clay };
    case 'quickReplies': {
      const list = s.split(',').map((x) => x.trim()).filter((x) => x && x.length <= 200).slice(0, 12);
      return { prefs: { ...p, quickReplies: list.length ? list : null }, clay };
    }
  }
}

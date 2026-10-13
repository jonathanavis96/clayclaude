import type { NightPrefs } from './prefs.js';

const minutes = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));

/** Darkness (0 to 0.9) to lay over the board at `now`. The window may cross midnight. */
export function nightLevel(now: Date, n: NightPrefs): number {
  if (!n.enabled) return 0;
  const t = now.getHours() * 60 + now.getMinutes();
  const a = minutes(n.from), b = minutes(n.to);
  if (a === b) return 0;
  const inside = a < b ? t >= a && t < b : t >= a || t < b;
  return inside ? n.level : 0;
}

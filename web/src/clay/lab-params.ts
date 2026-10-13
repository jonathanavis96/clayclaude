import type { AnimMode } from './prefs.js';
import type { LayoutPref } from '../layout.js';

/** `layout` is the board view's layout: strips unless the URL asks for grid or auto, so a check that counts `.row`s
 * keeps its rows on a short screen (auto would switch 10 rows to the grid there). */
export interface LabParams { mode: AnimMode; fail: Set<string>; n: number; layout: LayoutPref }

const MODES: readonly AnimMode[] = ['auto', 'bake', 'live', 'pc'];
const MAX_ROWS = 40;
const LAYOUTS: readonly LayoutPref[] = ['auto', 'strips', 'grid'];

/**
 * The clay lab's URL parameters (`mode`, `fail`, `n`, `layout`). The lab is one of the app's pages, which the request guard
 * lets a cross-site navigation open (an Android intent; src/security.ts isAppPage), so a link on any site can open
 * it with any query. Outside the dev server the URL therefore cannot choose "pc" (the daemon's headless PC baker)
 * or `fail` (which drives Auto down to pc); bake and live only cost the browser that opened the page. `n` is bounded.
 */
export function labParams(search: string, dev: boolean): LabParams {
  const q = new URLSearchParams(search);
  const asked = q.get('mode') as AnimMode | null;
  const mode = asked && MODES.includes(asked) && (dev || asked !== 'pc') ? asked : 'auto';
  const fail = new Set(dev ? (q.get('fail') ?? '').split(',').filter(Boolean) : []);
  const n = Number.parseInt(q.get('n') ?? '', 10);
  const layout = q.get('layout') as LayoutPref | null;
  return { mode, fail, n: Number.isFinite(n) ? Math.min(MAX_ROWS, Math.max(1, n)) : 8, layout: layout && LAYOUTS.includes(layout) ? layout : 'strips' };
}

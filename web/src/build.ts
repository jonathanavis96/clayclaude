declare const __CLAY_BUILD__: Stamp | undefined;

/** Which build this page is (spec §5.1): version, commit, build time. Baked in by web/build-stamp.ts; `dev` from source. */
export interface Stamp { version: string; commit: string; builtAt: string | null }

export const BUILD: Stamp = typeof __CLAY_BUILD__ === 'object' && __CLAY_BUILD__ ? __CLAY_BUILD__ : { version: 'dev', commit: 'dev', builtAt: null };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const two = (n: number) => String(n).padStart(2, '0');

/** "v0.1.0 · abc1234 · built 12 Oct 21:30" (local time). */
export function buildLabel(s: Stamp): string {
  const t = s.builtAt ? new Date(s.builtAt) : null;
  const when = t && !Number.isNaN(t.getTime()) ? ` · built ${t.getDate()} ${MONTHS[t.getMonth()]} ${two(t.getHours())}:${two(t.getMinutes())}` : '';
  return `v${s.version} · ${s.commit}${when}`;
}

/**
 * The daemon now serves another build than this page is running. A dev page and an unknown stamp (no build.json) never
 * count; a build made outside a git checkout has commit `unknown` but a build time, which still tells two builds apart.
 */
export function staleAgainst(page: Stamp, served: Stamp | null): boolean {
  if (!served || page.commit === 'dev' || !served.builtAt) return false;
  return served.commit !== page.commit || served.builtAt !== page.builtAt;
}

interface SessionStore { getItem(k: string): string | null; setItem(k: string, v: string): void }
const KEY = 'clayclaude.reloadedFor';

/**
 * What an open page does about the build the daemon serves. An always-on board tab otherwise runs the code it loaded
 * for days, through daemon upgrades (Task 32: the focus-view bug stayed on the tablet after its fix shipped).
 * - `current`: same build. `wait`: newer build, but a sheet or the focus view is open; ask again later.
 * - `reload`: reload now (remembered per served build in sessionStorage). `stale`: already reloaded for this build
 *   and still old (a cache in the way): show it rather than reload in a loop.
 */
export function reloadFor(page: Stamp, served: Stamp | null, store: SessionStore, idle: boolean): 'current' | 'wait' | 'reload' | 'stale' {
  if (!staleAgainst(page, served)) return 'current';
  if (!idle) return 'wait';
  const id = `${served!.commit}@${served!.builtAt}`;
  if (store.getItem(KEY) === id) return 'stale';
  store.setItem(KEY, id);
  return 'reload';
}

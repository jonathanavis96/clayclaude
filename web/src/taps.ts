import { isCountFilter, type CountFilter } from './filter.js';

/** Spec §5.1 (UI round 4): two taps within 350 ms and 30 px on the clock or blank space toggle full screen. */
export const DOUBLE_TAP_MS = 350;
export const DOUBLE_TAP_PX = 30;

export interface TapClock {
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(id: unknown): void;
}

export interface Tapper {
  (x: number, y: number, onSingle: () => void, onDouble: () => void): void;
  /** Drop a pending single tap (another kind of tap came in between). */
  cancel(): void;
}

/**
 * Tells a double tap from a single one. A single tap acts only once the double-tap window has passed, so the first
 * tap of a double tap never clears the filter, and a double tap never also counts as a single one.
 */
export function createTapper(c: TapClock): Tapper {
  let pending: { x: number; y: number; at: number; timer: unknown; single: () => void } | null = null;
  const cancel = () => { if (pending) c.clearTimer(pending.timer); pending = null; };
  const tap = (x: number, y: number, onSingle: () => void, onDouble: () => void) => {
    const t = c.now();
    const prev = pending;
    cancel();
    if (prev && t - prev.at <= DOUBLE_TAP_MS && Math.hypot(x - prev.x, y - prev.y) <= DOUBLE_TAP_PX) { onDouble(); return; }
    // A first tap that turned out not to be half of a double tap is still a single tap: act on it now.
    prev?.single();
    const timer = c.setTimer(() => { pending = null; onSingle(); }, DOUBLE_TAP_MS);
    pending = { x, y, at: t, timer, single: onSingle };
  };
  return Object.assign(tap, { cancel });
}

/** What is not blank space: rows, cards, buttons, meters, counts and anything else that takes a tap. The meters' line
 *  itself is blank where it has no meter: it stretches across the top bar and right-aligns them. */
const SOLID = '.row, .gcard, button, a, input, select, textarea, label, [role="button"], [data-act], .meter, .counts';

export interface BoardTapDeps extends Partial<TapClock> {
  getFilter(): CountFilter | null;
  setFilter(f: CountFilter | null): void;
  toggleFullscreen(): void;
  openAccount(id: string): void;
}

/**
 * The top bar's taps (spec §5.1, UI round 4): a count filters the board (again clears it), an account meter opens its
 * popup, and the clock or blank space clears the filter on a single tap and toggles full screen on a double tap.
 * Taps on rows, cards and other buttons are left to the app's own handler.
 */
export function initBoardTaps(root: HTMLElement, deps: BoardTapDeps): () => void {
  const tapper = createTapper({
    now: deps.now ?? (() => performance.now()),
    setTimer: deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: deps.clearTimer ?? ((id) => clearTimeout(id as ReturnType<typeof setTimeout>)),
  });
  const onClick = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || !root.contains(t)) return;
    const count = t.closest<HTMLElement>('.count[data-filter]');
    if (count) {
      tapper.cancel();
      const f = count.dataset.filter;
      if (isCountFilter(f)) deps.setFilter(deps.getFilter() === f ? null : f);
      return;
    }
    const meter = t.closest<HTMLElement>('.meter[data-account]');
    if (meter) { tapper.cancel(); deps.openAccount(meter.dataset.account!); return; }
    if (!t.closest('.clock') && t.closest(SOLID)) { tapper.cancel(); return; }
    const { clientX: x, clientY: y } = e as MouseEvent;
    // The double tap's click is the user gesture requestFullscreen needs: toggle synchronously inside it.
    tapper(x, y, () => { if (deps.getFilter()) deps.setFilter(null); }, deps.toggleFullscreen);
  };
  root.addEventListener('click', onClick);
  return () => { tapper.cancel(); root.removeEventListener('click', onClick); };
}

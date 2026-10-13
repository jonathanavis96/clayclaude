import type { Session } from '../../src/types.js';

/** Spec §5.3: the layout setting. */
export type LayoutPref = 'auto' | 'strips' | 'grid';
export type Layout = 'strips' | 'grid';

/**
 * The height the strip view needs: every row plus the gaps between them. A row's measured height is used when
 * there is one (a needs-you row grows to show a long question); otherwise a row is `row` px, a needs-you row 1.5×.
 */
export function stripsNeed(sessions: Pick<Session, 'key' | 'state'>[], row: number, gap: number, measured?: ReadonlyMap<string, number>): number {
  if (!sessions.length) return 0;
  const rows = sessions.reduce((sum, s) => sum + (measured?.get(s.key) ?? (s.state === 'needs-you' ? row * 1.5 : row)), 0);
  return rows + gap * (sessions.length - 1);
}

/**
 * Spec §5.1: auto uses the grid when the strips would not fit the board's height. Going back to strips needs
 * `hysteresis` px of room to spare, so a board right at the boundary does not flap between the two.
 * With no measured height yet (`avail` 0) the current layout stays.
 */
export function chooseLayout(pref: LayoutPref, current: Layout, need: number, avail: number, hysteresis: number): Layout {
  if (pref !== 'auto') return pref;
  if (!(avail > 0)) return current;
  if (current === 'strips') return need > avail ? 'grid' : 'strips';
  return need <= avail - hysteresis ? 'strips' : 'grid';
}

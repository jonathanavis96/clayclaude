import type { Session } from '../../src/types.js';

/**
 * Hide stopped sessions older than the retention the user chose (the daemon has its own, longer or equal, limit),
 * and headless helpers unless the person asked to see them (Task 45).
 */
export function visibleSessions(list: Session[], stoppedRetentionMs: number, now: number, showBackground = false): Session[] {
  return withoutBackground(list, showBackground).filter((s) => s.state !== 'stopped' || now - s.stateSince <= stoppedRetentionMs);
}

/** The list without background sessions (`claude -p`, the Agent SDK), unless `show`. Interactive ones always stay. */
export const withoutBackground = (list: Session[], show: boolean): Session[] => (show ? list : list.filter((s) => !s.background));

/** Sessions that were not waiting before and are now. `prev` holds the keys that were. */
export function newlyNeedsYou(prev: Set<string>, list: Session[]): Session[] {
  return list.filter((s) => s.state === 'needs-you' && s.hostOnline && !prev.has(s.key));
}

export const needsYouKeys = (list: Session[]) => new Set(list.filter((s) => s.state === 'needs-you').map((s) => s.key));

/** The states the top bar counts, and the filter a tap on a count applies (spec §5.1, UI round 4). Local, never saved. */
export const COUNT_FILTERS = ['needs-you', 'working', 'asleep', 'stopped'] as const;
export type CountFilter = (typeof COUNT_FILTERS)[number];
export const isCountFilter = (v: unknown): v is CountFilter => (COUNT_FILTERS as readonly unknown[]).includes(v);

/** The sessions a filter shows: those in that state, or all of them without a filter. */
export const applyFilter = (list: Session[], f: CountFilter | null | undefined): Session[] => (f ? list.filter((s) => s.state === f) : list);

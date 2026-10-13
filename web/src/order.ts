import type { Session } from '../../src/types.js';

const RANK: Record<string, number> = { 'needs-you': 0, limit: 1, working: 2, compacting: 3, asleep: 4, stopped: 5 };

export function sortSessions<T extends Pick<Session, 'state' | 'stateSince'>>(list: T[]): T[] {
  return [...list].sort((a, b) => RANK[a.state] - RANK[b.state]
    || (a.state === 'needs-you' ? a.stateSince - b.stateSince : b.stateSince - a.stateSince));
}

export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d`;
}

/**
 * Time left until something happens ("resets in …"). Unlike formatAge it rounds up, to the unit shown, so a
 * countdown never claims less time than is left: 90 s reads 2m, and 26 h 10 min reads 1d 3h.
 */
export function formatCountdown(ms: number): string {
  if (ms <= 0) return '0s';
  const s = Math.ceil(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.ceil(ms / 60_000);
  if (m < 24 * 60) return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  const h = Math.ceil(ms / 3_600_000);
  return `${Math.floor(h / 24)}d${h % 24 ? ` ${h % 24}h` : ''}`;
}

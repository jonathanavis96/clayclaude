import type { AccountUsage } from '../../src/types.js';
import { formatAge } from './order.js';

const arc = (r: number, pct: number | null) => {
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(100, pct ?? 0));
  return `stroke-dasharray="${((c * p) / 100).toFixed(2)} ${c.toFixed(2)}"`;
};
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));

/** Spec §12: a failing provider shows "stale" and the last value with its age, not just a dimmed meter. */
const staleNote = (u: AccountUsage, now: number) =>
  u.stale ? `<div class="stale">stale${u.updatedAt ? ` · ${formatAge(now - u.updatedAt)}` : ''}</div>` : '';

export function ringsSvg(u: AccountUsage, now = Date.now()): string {
  const outer = (u.fiveHour ?? 0) >= 80 ? 'var(--needs)' : u.colour;
  const label = u.fiveHour === null ? '–' : `${Math.round(u.fiveHour)}%`;
  return `<svg class="rings" viewBox="0 0 56 56" style="${u.stale ? 'opacity:.45' : ''}">`
    + (u.stale ? '<title>stale</title>' : '')
    + `<g transform="rotate(-90 28 28)" fill="none">`
    + `<circle cx="28" cy="28" r="24" stroke="${u.colour}" stroke-opacity=".18" stroke-width="5"/>`
    + `<circle cx="28" cy="28" r="24" stroke="${outer}" stroke-width="5" stroke-linecap="round" ${arc(24, u.fiveHour)}/>`
    + `<circle cx="28" cy="28" r="16" stroke="${u.colour}" stroke-opacity=".18" stroke-width="4"/>`
    + `<circle cx="28" cy="28" r="16" stroke="${u.colour}" stroke-width="4" stroke-linecap="round" ${arc(16, u.weekly)}/>`
    + `</g><text x="28" y="32" text-anchor="middle" class="ring-pct">${esc(label)}</text></svg>` + staleNote(u, now);
}

export function barsSvg(u: AccountUsage, now = Date.now()): string {
  const bar = (y: number, pct: number | null, colour: string) =>
    `<rect x="0" y="${y}" width="64" height="6" rx="3" fill="${u.colour}" fill-opacity=".18"/>`
    + `<rect x="0" y="${y}" width="${(64 * Math.max(0, Math.min(100, pct ?? 0))) / 100}" height="6" rx="3" fill="${colour}"/>`;
  return `<svg class="bars" viewBox="0 0 64 16" preserveAspectRatio="none" style="${u.stale ? 'opacity:.45' : ''}">`
    + bar(0, u.fiveHour, (u.fiveHour ?? 0) >= 80 ? 'var(--needs)' : u.colour) + bar(10, u.weekly, u.colour) + `</svg>` + staleNote(u, now);
}

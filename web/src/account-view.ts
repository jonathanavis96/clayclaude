import type { AccountUsage, Session } from '../../src/types.js';
import { formatDate } from './board.js';
import { esc } from './html.js';
import { formatAge, formatCountdown, sortSessions } from './order.js';

const STATE_WORD: Record<string, string> = { 'needs-you': 'needs you', working: 'working', asleep: 'asleep', stopped: 'stopped', compacting: 'compacting', limit: 'limit' };
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)}%`);
const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });

/** "resets 12:14 · in 2h 14m" (local time; the day as well when it is not today). Empty when unknown or past. */
export function formatReset(iso: string | null, now: number): string {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t) || t <= now) return '';
  const d = new Date(t);
  const today = new Date(now).toDateString() === d.toDateString();
  return `resets ${today ? '' : `${formatDate(d)} `}${hhmm(d)} · in ${formatCountdown(t - now)}`;
}

/** "updated 3m ago", or "stale · …" when the provider has failed or the reading is old (spec §12). */
function ageText(u: AccountUsage, now: number): string {
  const age = u.updatedAt === null ? 'never updated' : `updated ${formatAge(now - u.updatedAt)} ago`;
  return u.stale ? `stale · ${age}` : age;
}

function windowHtml(name: string, v: number | null, resetsAt: string | null, colour: string, now: number, amber: boolean): string {
  const w = Math.max(0, Math.min(100, v ?? 0));
  const fill = amber && (v ?? 0) >= 80 ? 'var(--needs)' : colour;
  return `<div class="acct-win"><span class="wname">${name}</span><b class="wpct">${pct(v)}</b>`
    + `<span class="wbar"><span style="width:${w}%;background:${fill}"></span></span>`
    + `<span class="wreset">${esc(formatReset(resetsAt, now))}</span></div>`;
}

/**
 * The account popup's body (spec §5.1, UI round 4): label, name and email, the plan when known, the 5-hour and weekly
 * figures with their resets, the sessions on the account (each opens its focus view) and when it was last updated.
 */
export function accountHtml(u: AccountUsage, sessions: Session[], now: number): string {
  const mine = sortSessions(sessions.filter((s) => s.account === u.account));
  const who = [u.name ? `<b>${esc(u.name)}</b>` : '', u.email ? `<span class="muted">${esc(u.email)}</span>` : ''].filter(Boolean).join(' ');
  const list = mine.length
    ? mine.map((s) => `<button class="mini st-${esc(s.state)}" data-act="focus" data-key="${esc(s.key)}"><span>${esc(s.name)}</span>`
      + `<small>${esc(STATE_WORD[s.state] ?? s.state)}</small></button>`).join('')
    : '<p class="muted">No sessions use this account</p>';
  return `<div class="account-panel" style="--c:${esc(u.colour)}">`
    + `<header><h2>${esc(u.label)}</h2>${u.plan ? `<span class="plan">${esc(u.plan)}</span>` : ''}<button class="x" data-act="close" aria-label="Close">×</button></header>`
    + (who ? `<div class="acct-who">${who}</div>` : '')
    + `<div class="acct-wins">${windowHtml('5-hour', u.fiveHour, u.fiveHourResetsAt, esc(u.colour), now, true)}`
    + `${windowHtml('Weekly', u.weekly, u.weeklyResetsAt, esc(u.colour), now, false)}</div>`
    + `<h3>Sessions</h3><div class="acct-sessions">${list}</div>`
    + `<div class="acct-age${u.stale ? ' warn' : ' muted'}">${esc(ageText(u, now))}</div></div>`;
}

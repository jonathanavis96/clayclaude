// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { accountHtml, formatReset } from '../web/src/account-view.js';
import { openAccount } from '../web/src/account.js';
import type { BoardState } from '../web/src/board.js';

const NOW = new Date(2026, 9, 13, 10, 0, 0).getTime();
const at = (h: number, m: number, dayOffset = 0) => new Date(2026, 9, 13 + dayOffset, h, m, 0).toISOString();
const session = (i: number, account: string, state: string, name = `sess${i}`) => ({
  key: `h:${account}:s${i}`, host: 'h', account, sessionId: `s${i}`, pid: i, name, cwd: '/',
  state, stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0,
}) as any;
const usage = (over: object = {}) => ({
  account: 'studio', label: 'Studio', colour: '#e8b54a', email: 'studio@example.test', name: 'Sam Studio', plan: 'Max 20x',
  fiveHour: 82, weekly: 54, fiveHourResetsAt: at(12, 14), weeklyResetsAt: at(9, 0, 3), stale: false, updatedAt: NOW - 3 * 60_000, ...over,
}) as any;
const state = (u = usage()): BoardState => ({
  sessions: [session(1, 'studio', 'working', 'docs-site'), session(2, 'lab', 'working', 'other-acct'), session(3, 'studio', 'needs-you', 'api')],
  usage: [u, { ...u, account: 'lab', label: 'Lab' }], accounts: [], cacheTtlMinutes: 60, serverTime: NOW, clockSkew: 0,
});
const text = (html: string) => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent!.replace(/\s+/g, ' '); };

describe('account popup content', () => {
  it('shows label, name, email, plan, both windows with their resets, the sessions on the account and the age', () => {
    const s = state();
    const t = text(accountHtml(s.usage[0], s.sessions, NOW));
    for (const want of ['Studio', 'Sam Studio', 'studio@example.test', 'Max 20x', '5-hour', '82%', 'Weekly', '54%',
      'resets 12:14 · in 2h 14m', 'docs-site', 'api', 'needs you', 'working', 'updated 3m ago']) expect(t).toContain(want);
    expect(t).not.toContain('other-acct');
    // the weekly reset is days away: its absolute time carries the day
    expect(t).toMatch(/resets Fri 16 Oct 09:00 · in 2d 23h/);
    // the session needing you is listed first, each a button that opens its focus view
    const d = document.createElement('div'); d.innerHTML = accountHtml(s.usage[0], s.sessions, NOW);
    expect([...d.querySelectorAll<HTMLElement>('[data-act="focus"]')].map((b) => b.dataset.key)).toEqual(['h:studio:s3', 'h:studio:s1']);
    expect(d.querySelectorAll('.acct-win .wbar').length).toBe(2);
  });

  it('shows no plan when the plan is unknown, and no name row content it does not have', () => {
    const s = state(usage({ plan: null, name: null }));
    const d = document.createElement('div'); d.innerHTML = accountHtml(s.usage[0], s.sessions, NOW);
    expect(d.querySelector('.plan')).toBeNull();
    expect(d.textContent).not.toMatch(/plan|unknown|undefined|null/i);
    expect(d.textContent).toContain('studio@example.test');
  });

  it('marks stale usage with the age of the last reading, and says when it never updated', () => {
    const s = state(usage({ stale: true, updatedAt: NOW - 20 * 60_000 }));
    const d = document.createElement('div'); d.innerHTML = accountHtml(s.usage[0], s.sessions, NOW);
    expect(d.querySelector('.acct-age')!.textContent).toBe('stale · updated 20m ago');
    expect(d.querySelector('.acct-age')!.classList.contains('warn')).toBe(true);
    const never = text(accountHtml(usage({ stale: true, updatedAt: null, fiveHour: null, weekly: null, fiveHourResetsAt: null, weeklyResetsAt: null }), [], NOW));
    expect(never).toContain('stale · never updated');
    expect(never).toContain('–');
    expect(never).toContain('No sessions use this account');
    expect(never).not.toContain('resets');
  });

  it('escapes every text field', () => {
    const u = usage({ label: '<b>L</b>', name: '<img src=x onerror=1>', email: '"e"<x>', plan: '<i>p</i>' });
    const d = document.createElement('div');
    d.innerHTML = accountHtml(u, [session(1, 'studio', 'working', '<script>x</script>')], NOW);
    expect(d.querySelector('img, script, i, h2 b')).toBeNull();
    expect(d.textContent).toContain('<b>L</b>');
    expect(d.textContent).toContain('<img src=x onerror=1>');
    expect(d.textContent).toContain('<script>x</script>');
  });

  it('formats a reset as local time and a countdown, with the day when it is not today', () => {
    expect(formatReset(at(12, 14), NOW)).toBe('resets 12:14 · in 2h 14m');
    expect(formatReset(at(9, 0, 3), NOW)).toBe('resets Fri 16 Oct 09:00 · in 2d 23h');
    expect(formatReset(null, NOW)).toBe('');
    expect(formatReset(at(9, 0), NOW)).toBe('');   // already past
  });
});

describe('openAccount', () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] }); vi.setSystemTime(NOW); });
  afterEach(() => { document.querySelector<HTMLElement>('.account [data-act="close"]')?.click(); vi.useRealTimers(); });

  it('opens the popup for that account; tapping a session closes it and opens its focus view', () => {
    const focus = vi.fn();
    openAccount('studio', { getState: () => state(), focus });
    const panel = document.querySelector('.account .account-panel')!;
    expect(panel.textContent).toContain('Sam Studio');
    panel.querySelector<HTMLElement>('[data-key="h:studio:s1"]')!.click();
    expect(focus).toHaveBeenCalledWith('h:studio:s1');
    expect(document.querySelector('.account')).toBeNull();
  });

  it('closes on the × and on a tap outside the panel', () => {
    const deps = { getState: () => state(), focus: vi.fn() };
    openAccount('studio', deps);
    document.querySelector<HTMLElement>('.account [data-act="close"]')!.click();
    expect(document.querySelector('.account')).toBeNull();
    openAccount('studio', deps);
    const modal = document.querySelector<HTMLElement>('.account')!;
    modal.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(document.querySelector('.account')).toBeNull();
  });

  it('does nothing for an account without usage, and opens one popup at a time', () => {
    const deps = { getState: () => state(), focus: vi.fn() };
    openAccount('nope', deps);
    expect(document.querySelector('.account')).toBeNull();
    openAccount('studio', deps); openAccount('lab', deps);
    expect(document.querySelectorAll('.account').length).toBe(1);
  });
});

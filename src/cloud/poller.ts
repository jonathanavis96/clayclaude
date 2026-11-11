// Polls Claude Code cloud sessions through the probe's `cloud` mode on each account's own host (the OAuth token never
// leaves it), one account per login, and keeps them as board Sessions.
import { EventEmitter } from 'node:events';
import type { AccountConfig, Config, HostConfig } from '../config.js';
import { runProbe } from '../probe/run.js';
import type { ProbeFn } from '../collector.js';
import type { Session } from '../types.js';
import { cloudSession, mergeEntry, type CloudEntry } from './reduce.js';
import type { CloudAccount, ProbeCloud } from './types.js';

/** Poll a login this often while one of its sessions runs or waits on a question, and this often otherwise. */
export const FAST_MS = 10_000, SLOW_MS = 60_000;
/** List five pages (not one) this often, and retry an account with no credentials this often. */
export const DISCOVER_MS = 600_000;
export const PROBE_TIMEOUT_MS = 30_000, PROBE_BUDGET_MS = 20_000;
/**
 * After a poke (an answer was sent), poll this soon rather than at the next tick: the answer sheet waits 10 s for the
 * session to respond, and a tick up to 10 s away would show "No response" for an answer that worked.
 */
export const POKE_DELAY_MS = 1500;
const DISCOVER_PAGES = 5;
/** After a 429: 2, 4, 8, then 16 min (longer if Retry-After says so, up to an hour): UsagePoller's values. */
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 16 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;

interface AccountState {
  /** Learned from the account's first ok poll: accounts with the same login see the same sessions. */
  login?: string;
  lastTry: number;
  lastOk?: number;
  /** Set while the account's last poll failed. */
  failing?: 'down' | 'error' | 'noAuth';
  backoff?: { until: number; n: number };
}
interface LoginState { lastOk: number; lastDiscover: number; poked: boolean }
interface Tracked { entry: CloudEntry; login: string; owner: string; firstSeen: number }
interface Known { afterId?: string; updatedAt: string }
type Due = { a: AccountConfig; pages: number };

/** lastSeen changes on every successful poll; leave it out when deciding whether anything changed. */
const withoutLastSeen = (k: string, v: unknown) => (k === 'lastSeen' ? undefined : v);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class CloudPoller extends EventEmitter {
  private probe: ProbeFn;
  private now: () => number;
  private log: (m: string) => void;
  private accts = new Map<string, AccountState>();
  private logins = new Map<string, LoginState>();
  private tracked = new Map<string, Tracked>();
  /** The last prompts per session key, kept while the session is listed (as Collector.prompts). */
  private prompts = new Map<string, string[]>();
  /** Launch-log rows seen so far: session id → the host whose log lists it. Kept for the daemon's lifetime. */
  private origins = new Map<string, { hostId: string; task?: string }>();
  private logTry = new Map<string, number>();
  /** When each host's launch log was last read successfully (the start of that poll). */
  private logOk = new Map<string, number>();
  private logFailing = new Set<string>();
  private inFlight = new Set<string>();
  private list: Session[] = [];
  private lastJson = '';
  private timer?: NodeJS.Timeout;
  private soon?: NodeJS.Timeout;
  private tick?: () => void;

  constructor(private cfg: Config, opts: { probe?: ProbeFn; now?: () => number; log?: (m: string) => void } = {}) {
    super();
    this.probe = opts.probe ?? ((h, r) => runProbe(h, r, { timeoutMs: PROBE_TIMEOUT_MS }));
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m) => console.warn(m));
  }

  sessions(): Session[] { return [...this.list]; }

  entry(sessionId: string): CloudEntry | undefined { return this.tracked.get(sessionId)?.entry; }

  /** Accounts whose login lists the session, in config order; the owner first. */
  accountsFor(sessionId: string): AccountConfig[] {
    const t = this.tracked.get(sessionId);
    if (!t) return [];
    const same = this.cfg.accounts.filter((a) => this.st(a.id).login === t.login);
    return [...same.filter((a) => a.id === t.owner), ...same.filter((a) => a.id !== t.owner)];
  }

  /** Poll the session's login (or every login) on the next tick, e.g. after an answer. */
  poke(sessionId?: string): void {
    const login = sessionId === undefined ? undefined : this.tracked.get(sessionId)?.login;
    for (const [l, s] of this.logins) if (login === undefined || l === login) s.poked = true;
    if (this.timer && this.tick) { clearTimeout(this.soon); this.soon = setTimeout(this.tick, POKE_DELAY_MS); }
  }

  async pollOnce(): Promise<Session[]> {
    const now = this.now();
    const due = this.due(now);
    await Promise.all(this.cfg.hosts.map((h) => {
      if (this.inFlight.has(h.id)) return undefined;
      const accounts = due.filter((d) => d.a.host === h.id);
      const log = !!h.cloudLaunchLog && (accounts.length > 0 || now - (this.logTry.get(h.id) ?? -Infinity) >= SLOW_MS);
      return accounts.length || log ? this.pollHost(h, accounts, log, now) : undefined;
    }));
    return this.emitIfChanged();
  }

  start(): void {
    if (this.timer) return;
    // A throwing 'update' listener rejects pollOnce; unhandled, that rejection would stop the daemon.
    const tick = () => { void this.pollOnce().catch((e) => this.log(`clayclaude: cloud poll failed: ${errText(e)}`)); };
    this.tick = tick;
    tick();
    this.timer = setInterval(tick, FAST_MS);
  }
  stop(): void { clearInterval(this.timer); clearTimeout(this.soon); this.timer = undefined; this.soon = undefined; }

  private st(id: string): AccountState {
    let s = this.accts.get(id);
    if (!s) this.accts.set(id, (s = { lastTry: -Infinity }));
    return s;
  }

  /** The accounts to ask this tick: one per known login, plus accounts whose login is not known yet. */
  private due(now: number): Due[] {
    const out: Due[] = [];
    // Accounts whose login is not known yet go last: the probe reads accounts in order within one time budget, and a
    // first read (every page, every session's events) must not leave a known login's cards without their poll.
    const discover: Due[] = [];
    const groups = new Map<string, AccountConfig[]>();
    const waiting = (s: AccountState) => !!s.backoff && now < s.backoff.until;
    const retry = (s: AccountState) => !waiting(s) && now - s.lastTry >= (s.failing === 'noAuth' ? DISCOVER_MS : SLOW_MS);
    for (const a of this.cfg.accounts) {
      const s = this.st(a.id);
      if (s.login === undefined) { if (s.lastTry === -Infinity || (s.failing && retry(s))) discover.push({ a, pages: DISCOVER_PAGES }); continue; }
      const g = groups.get(s.login);
      if (g) g.push(a); else groups.set(s.login, [a]);
    }
    for (const [login, group] of groups) {
      const ls = this.logins.get(login)!;
      const pages = now - ls.lastDiscover >= DISCOVER_MS ? DISCOVER_PAGES : 1;
      const rep = group.find((a) => { const s = this.st(a.id); return !waiting(s) && !s.failing; });
      if (!rep) { for (const a of group) if (retry(this.st(a.id))) out.push({ a, pages }); continue; }
      if (ls.poked || now - ls.lastOk >= (this.active(login) ? FAST_MS : SLOW_MS)) out.push({ a: rep, pages });
      // A failed account is asked again now and then, so it takes its sessions back once it works (owner = config order).
      for (const a of group) {
        const s = this.st(a.id);
        if (a !== rep && s.failing && !waiting(s) && now - s.lastTry >= DISCOVER_MS) out.push({ a, pages: 1 });
      }
    }
    return [...out, ...discover];
  }

  private active(login: string): boolean {
    for (const t of this.tracked.values()) if (t.login === login && (t.entry.raw.status === 'running' || t.entry.raw.status === 'requires_action')) return true;
    return false;
  }

  private known(a: AccountConfig): Record<string, Known> {
    const login = this.st(a.id).login;
    const out: Record<string, Known> = {};
    if (login === undefined) return out;
    for (const [id, t] of this.tracked) {
      if (t.login !== login) continue;
      out[id] = { ...(t.entry.afterId !== undefined ? { afterId: t.entry.afterId } : {}), updatedAt: t.entry.updatedAt };
    }
    return out;
  }

  private async pollHost(h: HostConfig, due: Due[], log: boolean, now: number): Promise<void> {
    this.inFlight.add(h.id);
    const sent = new Map(due.map((d) => [d.a.id, this.known(d.a)]));
    const req = { mode: 'cloud', budgetMs: PROBE_BUDGET_MS, ...(log ? { launchLog: h.cloudLaunchLog } : {}),
      accounts: due.map(({ a, pages }) => { const k = sent.get(a.id)!; return { key: a.id, configDir: a.configDir, pages, also: Object.keys(k), known: k }; }) };
    for (const { a } of due) this.st(a.id).lastTry = now;
    if (log) this.logTry.set(h.id, now);
    try {
      let r: ProbeCloud;
      try {
        r = (await this.probe(h, req)) as ProbeCloud;
        if (!r || !Array.isArray(r.accounts)) throw new Error('malformed cloud probe output');
      } catch (e) {
        for (const { a } of due) this.failed(a, 'down', errText(e));
        if (log) this.logFailed(h, errText(e));
        return;
      }
      if (log) {
        if (Array.isArray(r.launches)) {
          this.logOk.set(h.id, now);
          if (this.logFailing.delete(h.id)) this.log(`clayclaude: cloud launch log on ${h.id} is readable again`);
          for (const l of r.launches) {
            if (l && typeof l.sessionId === 'string') this.origins.set(l.sessionId, { hostId: h.id, ...(typeof l.task === 'string' && l.task ? { task: l.task } : {}) });
          }
        } else this.logFailed(h, typeof r.launchError === 'string' ? r.launchError : 'no launches in probe output');
      }
      const returned = new Map<string, Set<string>>();   // login → session ids its ok accounts returned
      for (const { a, pages } of due) {
        const e = r.accounts.find((x) => x?.key === a.id);
        if (!e) this.failed(a, 'error', 'no entry in probe output');
        else if (e.ok && typeof e.login === 'string' && e.login) this.ok(a, e, pages, sent.get(a.id)!, now, returned);
        else if (e.ok) this.failed(a, 'error', 'no login in probe output');
        else if (e.status === 429) this.limited(a, e.error, e.retryAfterS);
        else this.failed(a, e.noAuth ? 'noAuth' : 'error', e.error);
      }
      for (const [id, t] of this.tracked) {
        const seen = returned.get(t.login);
        if (seen && !seen.has(id)) this.tracked.delete(id);   // archived or gone
      }
    } finally {
      this.inFlight.delete(h.id);
      this.rebuild();
      this.emitIfChanged();
    }
  }

  private ok(a: AccountConfig, e: Extract<CloudAccount, { ok: true }>, pages: number, sent: Record<string, Known>, now: number,
    returned: Map<string, Set<string>>) {
    const s = this.st(a.id);
    if (s.failing) this.log(`clayclaude: cloud sessions for ${a.id} are back`);
    s.failing = undefined; s.backoff = undefined; s.lastOk = now; s.login = e.login;
    const ls = this.logins.get(e.login) ?? { lastOk: -Infinity, lastDiscover: -Infinity, poked: false };
    ls.lastOk = now; ls.poked = false;
    if (pages >= DISCOVER_PAGES) ls.lastDiscover = now;
    this.logins.set(e.login, ls);
    let seen = returned.get(e.login);
    if (!seen) returned.set(e.login, (seen = new Set()));
    const order = (id: string) => this.cfg.accounts.findIndex((x) => x.id === id);
    for (const raw of Array.isArray(e.sessions) ? e.sessions : []) {
      if (!raw || typeof raw.id !== 'string') continue;
      seen.add(raw.id);
      const t = this.tracked.get(raw.id);
      // Another account read these events already this tick (or since the request was made): merging them twice
      // would repeat lines, so keep only the list fields.
      const fresh = !t || t.entry.afterId === sent[raw.id]?.afterId;
      const entry = mergeEntry(t?.entry, fresh ? raw : { ...raw, events: undefined });
      const keep = t && t.owner !== a.id && !this.st(t.owner).failing && t.login === e.login ? t.owner : undefined;
      const owner = keep !== undefined && order(keep) < order(a.id) ? keep : a.id;
      this.tracked.set(raw.id, { entry, login: e.login, owner, firstSeen: t?.firstSeen ?? now });
    }
  }

  private failed(a: AccountConfig, kind: 'down' | 'error' | 'noAuth', why: unknown) {
    const s = this.st(a.id);
    if (!s.failing) this.log(`clayclaude: cloud sessions for ${a.id} failed: ${String(why ?? 'unknown error').slice(0, 300)}`);
    s.failing = kind;
  }

  private limited(a: AccountConfig, why: unknown, retryAfterS?: number) {
    const s = this.st(a.id);
    const n = (s.backoff?.n ?? 0) + 1;
    const ra = typeof retryAfterS === 'number' && Number.isFinite(retryAfterS) ? retryAfterS : 0;
    const wait = Math.max(Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS), Math.min(Math.max(ra, 0) * 1000, RETRY_AFTER_MAX_MS));
    this.failed(a, 'error', `${String(why ?? 'HTTP 429')} (rate limited; backing off ${Math.round(wait / 60_000)} min)`);
    s.backoff = { until: this.now() + wait, n };
  }

  private logFailed(h: HostConfig, why: string) {
    if (this.logFailing.has(h.id)) return;
    this.logFailing.add(h.id);
    this.log(`clayclaude: cloud launch log on ${h.id} unreadable: ${why.slice(0, 300)}`);
  }

  /** "this PC", a host id, "claude.ai" (no launch log lists it), or undefined while that is not known yet. */
  private origin(id: string, t: Tracked): { origin?: string; originTask?: string } {
    const o = this.origins.get(id);
    if (o) {
      const h = this.cfg.hosts.find((x) => x.id === o.hostId);
      return { origin: h && !h.ssh ? 'this PC' : o.hostId, ...(o.task ? { originTask: o.task } : {}) };
    }
    const logs = this.cfg.hosts.filter((h) => h.cloudLaunchLog);
    // Only a read that started after the session was first seen can rule a launch row out: cloud-build writes its row
    // once the session exists, and another host's log is read less often than the list.
    if (logs.length && logs.every((h) => (this.logOk.get(h.id) ?? -Infinity) > t.firstSeen)) return { origin: 'claude.ai' };
    return {};
  }

  private rebuild() {
    const out: Session[] = [];
    const keys = new Set<string>();
    for (const [id, t] of this.tracked) {
      const a = this.cfg.accounts.find((x) => x.id === t.owner);
      if (!a) continue;
      const s = this.st(a.id);
      const key = 'cloud:' + id;
      keys.add(key);
      const session = cloudSession(t.entry, { account: a.id, host: a.host, hostOnline: !s.failing, lastSeen: s.lastOk ?? this.now(),
        ...this.origin(id, t), prompts: this.prompts.get(key) });
      if (session.lastPrompts) this.prompts.set(key, session.lastPrompts);
      out.push(session);
    }
    for (const k of this.prompts.keys()) if (!keys.has(k)) this.prompts.delete(k);
    this.list = out;
  }

  private emitIfChanged(): Session[] {
    const json = JSON.stringify(this.list, withoutLastSeen);
    if (json !== this.lastJson) { this.lastJson = json; this.emit('update', this.sessions()); }
    return this.sessions();
  }
}

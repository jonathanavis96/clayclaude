import { EventEmitter } from 'node:events';
import type { Config, HostConfig } from './config.js';
import { ProbeError, runProbe } from './probe/run.js';
import { deriveSession, parseEvents } from './core/status.js';
import type { ProbeSnapshot, Session } from './types.js';
import type { PendingLaunches } from './actions/pending.js';

export type ProbeFn = (host: HostConfig, req: object) => Promise<unknown>;

/** Longest wait between retries to an unreachable host (spec §12: reconnect with backoff). */
export const MAX_BACKOFF_MS = 60_000;

/**
 * A remote clock this far from the daemon's is corrected for. Below it the measurement is mostly ssh latency, and
 * re-measuring every poll would move every timestamp and re-emit the list each time.
 */
export const SKEW_TOLERANCE_MS = 2000;

/**
 * Time the probe may spend reading transcripts in one snapshot, well inside the probe's 10 s timeout. Past it (or
 * past its byte budget) the rest are deferred to later polls instead of the whole host timing out every poll.
 */
export const SNAPSHOT_BUDGET_MS = 4000;

/** lastSeen changes on every successful poll; leave it out when deciding whether anything changed. */
const withoutLastSeen = (k: string, v: unknown) => (k === 'lastSeen' ? undefined : v);

export class Collector extends EventEmitter {
  private byHost = new Map<string, Session[]>();
  /** Last transcript tail per host and config dir, keyed by session id, so the probe can skip unchanged ones. */
  private transcripts = new Map<string, Map<string, { sig: string; lines: string[] }>>();
  private log: (msg: string) => void;
  private lastJson = '';
  private timer?: NodeJS.Timeout;
  private probe: ProbeFn;
  private now: () => number;
  private exhausted: (accountId: string) => boolean;
  /** Hosts with a probe still pending; skipped until it settles so probes never overlap. */
  private inFlight = new Set<string>();
  /** Consecutive failures and the earliest next attempt per host, for exponential backoff. */
  private backoff = new Map<string, { failures: number; nextAttemptAt: number }>();
  /** Daemon clock minus host clock, per host; only changed when a new measurement is off by more than the tolerance. */
  private skew = new Map<string, number>();
  /** Keys of sessions seen past their configured context window: they stay on 1M while they are on the board. */
  private wide = new Set<string>();
  /** Sessions the user cleared (spec §5.1): left out unless live. A live session is never hidden. */
  private hidden: (key: string) => boolean;
  /** Told when a cleared session is seen live again, so it can be un-cleared (T39). */
  private resumed: (key: string) => void;
  /** Registry files behind each session key, per host, from the last good snapshot (for clearing: probe `reap`). */
  private files = new Map<string, Map<string, { configDir: string; files: string[] }>>();

  /** Launches Claude has not registered yet (Task 40): listed after the registered sessions, refreshed on each poll. */
  private pending?: Pick<PendingLaunches, 'refresh' | 'sessions'>;

  constructor(private cfg: Config, opts: { probe?: ProbeFn; now?: () => number; exhausted?: (a: string) => boolean; log?: (msg: string) => void; hidden?: (key: string) => boolean; resumed?: (key: string) => void; pending?: Pick<PendingLaunches, 'refresh' | 'sessions'> } = {}) {
    super();
    this.log = opts.log ?? ((m) => console.warn(m));
    this.probe = opts.probe ?? ((h, r) => runProbe(h, r));
    this.now = opts.now ?? Date.now;
    this.exhausted = opts.exhausted ?? (() => false);
    this.hidden = opts.hidden ?? (() => false);
    this.resumed = opts.resumed ?? (() => {});
    this.pending = opts.pending;
  }

  sessions(): Session[] { return [...this.registered(), ...(this.pending?.sessions() ?? [])]; }
  private registered(): Session[] { return [...this.byHost.values()].flat(); }

  /** The registry files (names inside `<configDir>/sessions/`) a session key came from in the last snapshot. */
  registryFiles(key: string): { configDir: string; files: string[] } | undefined {
    for (const m of this.files.values()) { const f = m.get(key); if (f) return { configDir: f.configDir, files: [...f.files] }; }
    return undefined;
  }

  /** Drop newly hidden sessions now, without waiting for the next poll. */
  refilter() {
    for (const [h, list] of this.byHost) this.byHost.set(h, list.filter((s) => s.live || !this.hidden(s.key)));
    this.emitIfChanged();
  }

  async pollOnce(): Promise<Session[]> {
    await Promise.all(this.cfg.hosts.map((h) => this.pollHost(h)));
    if (this.pending) {
      try { await this.pending.refresh(this.registered()); }
      catch (e) { this.log(`clayclaude: reading launched panes failed: ${e instanceof Error ? e.message : String(e)}`); }
    }
    return this.emitIfChanged();
  }

  private emitIfChanged(): Session[] {
    const list = this.sessions();
    const json = JSON.stringify(list, withoutLastSeen);
    if (json !== this.lastJson) { this.lastJson = json; this.emit('update', list); }
    return list;
  }

  private async pollHost(host: HostConfig) {
    const accounts = this.cfg.accounts.filter((a) => a.host === host.id);
    if (!accounts.length) return;
    const now = this.now();
    if (this.inFlight.has(host.id)) return;
    const b = this.backoff.get(host.id);
    if (b && now < b.nextAttemptAt) return;
    this.inFlight.add(host.id);
    try {
      const known: Record<string, Record<string, string>> = {};
      for (const a of accounts) {
        const cache = this.transcripts.get(`${host.id}\0${a.configDir}`);
        if (cache?.size) known[a.configDir] = Object.fromEntries([...cache].map(([sid, c]) => [sid, c.sig]));
      }
      const snap = (await this.probe(host, { mode: 'snapshot', dirs: accounts.map((a) => a.configDir), known, budgetMs: SNAPSHOT_BUDGET_MS,
        // Stopped sessions are hidden after stoppedRetention (by updatedAt, never later than the file's mtime);
        // an hour of slack covers clock skew between the hosts.
        deadAfterMs: Math.min(this.cfg.stoppedRetentionMs + 3600_000, Number.MAX_SAFE_INTEGER) })) as ProbeSnapshot; // the probe takes integers only
      // Judge remote timestamps by the remote clock, so clock skew between hosts cannot misclassify a session.
      const remoteNow = typeof snap.nowMs === 'number' && Number.isFinite(snap.nowMs) ? snap.nowMs : null;
      const hostNow = remoteNow ?? now;
      // ...but report them on the daemon's clock, which is what the board measures ages and the cache timer against.
      const skew = this.measureSkew(host.id, remoteNow === null ? null : (now + this.now()) / 2 - remoteNow);
      const out = new Map<string, Session>();
      const files = new Map<string, { configDir: string; files: string[] }>();
      for (const dir of snap.dirs) {
        const account = accounts.find((a) => a.configDir === dir.configDir);
        if (!account) continue;
        const events = parseEvents(dir.events);
        const prevCache = this.transcripts.get(`${host.id}\0${dir.configDir}`);
        const cache = new Map<string, { sig: string; lines: string[] }>();
        for (const raw of dir.registries) {
          const sid = typeof raw.data?.sessionId === 'string' ? raw.data.sessionId : undefined;
          let reg = raw;
          if (sid && raw.tsig) {
            const hit = prevCache?.get(sid);
            if (raw.same && hit?.sig === raw.tsig) reg = { ...raw, transcript: hit.lines };
            if (!raw.same || hit?.sig === raw.tsig) cache.set(sid, { sig: raw.tsig, lines: reg.transcript });
          } else if (sid && raw.deferred) {
            // Over this poll's budget: show the last tail we have, and keep its old signature so the probe resends.
            const hit = prevCache?.get(sid);
            if (hit) { reg = { ...raw, transcript: hit.lines }; cache.set(sid, hit); }
          }
          const s = deriveSession({ host: host.id, account: account.id, reg, events, usageExhausted: this.exhausted(account.id),
            cacheTtlMinutes: this.cfg.cacheTtlMinutes, contextWindows: this.cfg.contextWindows, hostOnline: true, lastSeen: now, wide: this.wide,
            ...(sid && dir.contexts && typeof dir.contexts === 'object' && Object.hasOwn(dir.contexts, sid) ? { context: dir.contexts[sid] } : {}) }, hostNow);
          if (!s) continue;
          const f = files.get(s.key);
          if (f) f.files.push(raw.file); else files.set(s.key, { configDir: dir.configDir, files: [raw.file] });
          if (s.state === 'stopped' && hostNow - s.stateSince > this.cfg.stoppedRetentionMs) continue;
          if (skew) shift(s, skew);
          const prev = out.get(s.key);
          if (!prev || (s.live && !prev.live) || (s.live === prev.live && s.stateSince > prev.stateSince)) out.set(s.key, s);
        }
        this.transcripts.set(`${host.id}\0${dir.configDir}`, cache);
      }
      for (const k of this.wide) if (k.startsWith(`${host.id}:`) && !out.has(k)) this.wide.delete(k); // bounded: only sessions still listed
      for (const s of out.values()) if (s.live && this.hidden(s.key)) this.resumed(s.key);
      this.byHost.set(host.id, [...out.values()].filter((s) => s.live || !this.hidden(s.key)));
      this.files.set(host.id, files);
      if (b) this.log(`clayclaude: host ${host.id} is back online`);
      this.backoff.delete(host.id);
    } catch (e) {
      const why = e instanceof ProbeError && e.kind === 'unsupported' ? 'cannot be watched' : 'unreachable';
      if (!b) this.log(`clayclaude: host ${host.id} ${why}: ${e instanceof Error ? e.message : String(e)}`);
      const failures = (b?.failures ?? 0) + 1;
      // One timeout on a slow link is not an outage (a cold poll after a restart reads every transcript): a host goes
      // grey on its second failure in a row, or at once when ssh itself fails.
      const slowOnce = e instanceof ProbeError && e.kind === 'timeout' && failures < 2;
      if (!slowOnce) this.byHost.set(host.id, (this.byHost.get(host.id) ?? []).map((s) => ({ ...s, hostOnline: false })));
      const delay = Math.min(this.cfg.pollMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
      this.backoff.set(host.id, { failures, nextAttemptAt: this.now() + delay }); // from when the failure was seen, so a slow ssh timeout does not eat the delay
    } finally {
      this.inFlight.delete(host.id);
    }
  }

  /** Returns the skew to apply for a host, updating it only when `measured` is off by more than the tolerance. */
  private measureSkew(hostId: string, measured: number | null): number {
    const cur = this.skew.get(hostId) ?? 0;
    if (measured === null || Math.abs(measured - cur) <= SKEW_TOLERANCE_MS) return cur;
    const next = Math.abs(measured) <= SKEW_TOLERANCE_MS ? 0 : Math.round(measured);
    this.skew.set(hostId, next);
    return next;
  }

  start() {
    if (this.timer) return;
    // A throwing 'update' listener rejects pollOnce; unhandled, that rejection would stop the daemon.
    const tick = () => this.pollOnce().catch((e) => this.log(`clayclaude: poll failed: ${e instanceof Error ? e.message : String(e)}`));
    void tick();
    this.timer = setInterval(tick, this.cfg.pollMs);
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}

function shift(s: Session, by: number) {
  s.stateSince += by;
  if (s.lastAssistantAt !== undefined) s.lastAssistantAt += by;
  if (s.cacheExpiresAt !== undefined) s.cacheExpiresAt += by;
}

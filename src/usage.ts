import { EventEmitter } from 'node:events';
import type { AccountConfig, Config } from './config.js';
import { runProbe } from './probe/run.js';
import type { ProbeFn } from './collector.js';
import type { AccountUsage, ProbeUsage, UsageEntry, UsageWindow } from './types.js';

const STALE_MS = 5 * 60_000;
const HTTP_TIMEOUT_MS = 10_000;
/** The usage probe's kill timeout, and the budget it is told to finish inside (ssh start-up takes the rest). */
const PROBE_TIMEOUT_MS = 45_000;
const PROBE_BUDGET_MS = 38_000;
/** After a 429: wait 2, 4, 8, then 16 min between tries (longer if Retry-After says so; the real API sends 0). */
const BACKOFF_BASE_MS = 2 * 60_000;
const BACKOFF_MAX_MS = 16 * 60_000;
const RETRY_AFTER_MAX_MS = 60 * 60_000;
/** A token or meter-log reading older than this is shown stale, unless it is held (see reading()). */
export const READING_STALE_MS = 15 * 60_000;
/** Least time between two token-provider calls for one account: each call spends a little of that account's usage. */
export const TOKEN_MIN_INTERVAL_MS = 5 * 60_000;

/** A token or meter-log reading: the figures and when they were read (ms; NaN if unknown). */
interface Reading { ts: number; five: unknown; week: unknown }

export class UsagePoller extends EventEmitter {
  private state = new Map<string, AccountUsage>();
  private timer?: NodeJS.Timeout;
  private probe: ProbeFn;
  private fetchFn: typeof fetch;
  private now: () => number;
  private log: (msg: string) => void;
  /** Accounts whose last poll failed, so a lasting failure is logged once, not every minute. */
  private failing = new Set<string>();
  private inflight?: Promise<AccountUsage[]>;
  /** Rate-limited accounts: not asked again until `until`; `n` consecutive 429s so far. */
  private backoff = new Map<string, { until: number; n: number }>();
  /** Token accounts: the last good reading (shown again between calls) and when each was last asked. */
  private readings = new Map<string, Reading>();
  private asked = new Map<string, number>();
  /** Per-account staleness limit where it is not STALE_MS from the last poll (token and meter-log readings). */
  private staleAfter = new Map<string, number>();

  constructor(private cfg: Config, opts: { probe?: ProbeFn; fetchFn?: typeof fetch; now?: () => number; log?: (msg: string) => void } = {}) {
    super();
    this.log = opts.log ?? ((m) => console.warn(m));
    this.probe = opts.probe ?? ((h, r) => runProbe(h, r, { timeoutMs: PROBE_TIMEOUT_MS }));
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    for (const a of cfg.accounts) if (a.usage.provider !== 'none') this.state.set(a.id, blank(a));
  }

  usage(): AccountUsage[] {
    const now = this.now();
    return [...this.state.values()].map((u) => ({ ...u,
      stale: u.stale || u.updatedAt === null || now - u.updatedAt > (this.staleAfter.get(u.account) ?? STALE_MS) }));
  }

  isExhausted(id: string): boolean {
    const u = this.usage().find((x) => x.account === id);
    return !!u && !u.stale && ((u.fiveHour ?? 0) >= 100 || (u.weekly ?? 0) >= 100);
  }

  publicShape() {
    const out: Record<string, { label: string; five_hour: UsageWindow | null; seven_day: UsageWindow | null; stale: boolean }> = {};
    for (const u of this.usage()) out[u.account] = {
      label: u.label, stale: u.stale,
      five_hour: u.fiveHour === null ? null : { utilization: u.fiveHour, resets_at: u.fiveHourResetsAt },
      seven_day: u.weekly === null ? null : { utilization: u.weekly, resets_at: u.weeklyResetsAt },
    };
    return out;
  }

  /** One poll at a time: a second one overlapping it could refresh the same token twice. */
  pollOnce(): Promise<AccountUsage[]> {
    return (this.inflight ??= this.poll().finally(() => { this.inflight = undefined; }));
  }

  private async poll(): Promise<AccountUsage[]> {
    const now = this.now();
    const due = this.cfg.accounts.filter((a) => (this.backoff.get(a.id)?.until ?? 0) <= now);
    const http = due.filter((a) => a.usage.provider === 'http');
    // Token accounts are asked at most every TOKEN_MIN_INTERVAL_MS (and never while the week is capped); in between,
    // the last reading is shown again, so a five-hour window that has since reset reads 0.
    const tokens = due.filter((a) => a.usage.provider === 'token');
    const ask = tokens.filter((a) => now - (this.asked.get(a.id) ?? -Infinity) >= TOKEN_MIN_INTERVAL_MS && !capped(this.readings.get(a.id), now));
    for (const a of tokens) {
      if (ask.includes(a)) this.asked.set(a.id, now);
      else { const r = this.readings.get(a.id); if (r) this.reading(a, r); }
    }
    const viaProbe = [...due.filter((a) => a.usage.provider === 'oauth' || a.usage.provider === 'meter-log'), ...ask];
    // A hung host takes up to PROBE_TIMEOUT_MS to fail; publish each answer as it lands rather than holding every
    // account's meters back until then (the server coalesces the extra updates).
    const tasks: Promise<unknown>[] = [
      ...this.cfg.hosts.map((h) => [h, viaProbe.filter((a) => a.host === h.id)] as const).filter(([, accts]) => accts.length).map(async ([h, accts]) => {
        try {
          const r = (await this.probe(h, { mode: 'usage', budgetMs: PROBE_BUDGET_MS, accounts: accts.map((a) => this.request(a, now)) })) as ProbeUsage;
          for (const a of accts) {
            const e = r.accounts.find((x) => (x.key !== undefined ? x.key === a.id : x.configDir === a.configDir));
            if (e?.ok && a.usage.provider === 'meter-log') this.reading(a, { ts: Date.parse(String(e.ts)), five: e.five_hour, week: e.seven_day }, who(e), e.idle === true);
            else if (e?.ok && a.usage.provider === 'token') {
              const held = e.held ? this.readings.get(a.id) : undefined; // the host held the call: nothing has started a window
              const r = held ?? { ts: this.now(), five: e.five_hour, week: e.seven_day };
              if (held || !e.held) { this.readings.set(a.id, r); this.reading(a, r, who(e)); }
            } else if (e?.ok) this.set(a, e.five_hour ?? null, e.seven_day ?? null, who(e));
            else if (e?.status === 429) this.limited(a.id, e.error ?? '429', e.retryAfterS);
            else this.fail(a.id, e?.error ?? 'no entry in probe output');
          }
        } catch (err) { accts.forEach((a) => this.fail(a.id, errText(err))); }
      }),
      ...http.map(async (a) => {
        const u = a.usage as { url: string; key: string };
        const shown = shownUrl(u.url);
        try {
          const res = await this.fetchFn(u.url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
          if (res.status === 429) {
            const ra = Number(res.headers.get('retry-after'));
            return this.limited(a.id, `HTTP 429 from ${shown}`, Number.isFinite(ra) ? ra : undefined);
          }
          if (!res.ok) return this.fail(a.id, `HTTP ${res.status} from ${shown}`);
          const body: any = await res.json();
          const e = body?.[u.key];
          if (e) this.set(a, e.five_hour ?? null, e.seven_day ?? null); else this.fail(a.id, `no "${u.key}" key in ${shown}`);
        } catch (err) { this.fail(a.id, hideUrl(errText(err), u.url, shown)); }
      }),
    ];
    let pending = tasks.length;
    await Promise.all(tasks.map((t) => t.finally(() => { if (--pending > 0) this.emit('update', this.usage()); })));
    const out = this.usage();
    this.emit('update', out);
    return out;
  }

  /** One account's entry in the probe's usage request. Paths and names ride as JSON data, never through a shell. */
  private request(a: AccountConfig, now: number): object {
    const u = a.usage;
    if (u.provider === 'meter-log') return { kind: 'meter-log', key: a.id, configDir: a.configDir, log: u.log };
    if (u.provider === 'token') {
      const reset = Date.parse(String((this.readings.get(a.id)?.five as UsageWindow | undefined)?.resets_at));
      return { kind: 'token', key: a.id, configDir: a.configDir, tokenEnv: u.tokenEnv, envFile: u.envFile, model: u.model,
        ...(reset <= now ? { idleSinceMs: reset } : {}) };
    }
    return { key: a.id, configDir: a.configDir, refresh: (u as { refresh?: boolean }).refresh !== false };
  }

  /**
   * Show a token or meter-log reading. A window whose reset has passed reads 0 with no reset. The reading is stale
   * READING_STALE_MS after it was taken, except while it is held. A token reading is held while its five-hour window
   * has lapsed or the week is capped (no call is made then). A meter-log reading is held only when its five-hour
   * window has lapsed and the host reports no claude run on the account since that reset (`idle`: a live meter takes
   * no new reading then), and only until the reading's own weekly reset; an account in use with an old reading means
   * the meter has stopped, so it goes stale. The host re-checks `idle` on every poll.
   */
  private reading(a: AccountConfig, r: Reading, id?: Who, idle = false) {
    const now = this.now();
    const at = (w: UsageWindow | null) => Date.parse(String(w?.resets_at));
    const lapse = (w: UsageWindow | null) => (w && at(w) <= now ? { utilization: 0, resets_at: null } : w);
    const five = lapse(window(r.five)), week = lapse(window(r.week));
    this.set(a, five, week, id);
    this.state.set(a.id, { ...this.state.get(a.id)!, updatedAt: Number.isFinite(r.ts) ? r.ts : null });
    const held = a.usage.provider === 'meter-log'
      ? idle && at(window(r.five)) <= now && at(window(r.week)) > now
      : !five?.resets_at || capped(r, now);
    this.staleAfter.set(a.id, held ? Infinity : READING_STALE_MS);
  }

  private set(a: AccountConfig, five: UsageWindow | null, week: UsageWindow | null, id?: Who) {
    this.backoff.delete(a.id);
    if (this.failing.delete(a.id)) this.log(`clayclaude: usage for ${a.id} is back`);
    five = window(five); week = window(week);
    const was = this.state.get(a.id);
    this.state.set(a.id, { ...blank(a), email: (typeof id?.email === 'string' ? id.email : null) ?? was?.email ?? null,
      name: id?.name ?? was?.name ?? null, plan: id?.plan ?? was?.plan ?? null,
      fiveHour: five?.utilization ?? null, weekly: week?.utilization ?? null,
      fiveHourResetsAt: five?.resets_at ?? null, weeklyResetsAt: week?.resets_at ?? null,
      stale: false, updatedAt: this.now() });
  }
  private fail(id: string, why: string) {
    this.readings.delete(id); // a token account's last reading is not shown again as fresh after a failed call
    if (!this.failing.has(id)) { this.failing.add(id); this.log(`clayclaude: usage for ${id} failed: ${why}`); }
    const u = this.state.get(id); if (u) this.state.set(id, { ...u, stale: true });
  }

  /** A 429: back off exponentially (honouring a longer Retry-After) instead of asking again every minute. */
  private limited(id: string, why: string, retryAfterS?: number) {
    const n = (this.backoff.get(id)?.n ?? 0) + 1;
    const wait = Math.max(Math.min(BACKOFF_BASE_MS * 2 ** (n - 1), BACKOFF_MAX_MS),
      Math.min(Math.max(retryAfterS ?? 0, 0) * 1000, RETRY_AFTER_MAX_MS));
    this.backoff.set(id, { until: this.now() + wait, n });
    this.fail(id, `${why} (rate limited; backing off ${Math.round(wait / 60_000)} min)`);
  }

  start() {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), 60_000);
  }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}

/** Who an account belongs to, from the probe's entry: email, name and a readable plan (each null when unknown). */
interface Who { email: string | null; name: string | null; plan: string | null }
const who = (e: UsageEntry): Who => ({
  email: typeof e.email === 'string' ? e.email : null,
  name: typeof e.name === 'string' && e.name ? e.name : null,
  plan: planLabel(e.plan, e.planTier),
});

/**
 * The plan as shown: Claude Code's organisation type ("claude_max") with its rate-limit tier's multiplier
 * ("default_claude_max_20x") reads "Max 20x". Anything not shaped like those reads null: nothing rather than a guess.
 */
export function planLabel(type: unknown, tier: unknown): string | null {
  const m = typeof type === 'string' ? /^claude_([a-z]+)$/.exec(type) : null;
  if (!m) return null;
  const x = typeof tier === 'string' ? new RegExp(`^default_claude_${m[1]}_(\\d+)x$`).exec(tier) : null;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)}${x ? ` ${x[1]}x` : ''}`;
}

/** The week read 100% and its reset is still ahead: a token call now would only spend usage to read the same. */
function capped(r: Reading | undefined, now: number): boolean {
  const w = window(r?.week);
  return !!w && (w.utilization ?? 0) >= 100 && Date.parse(String(w.resets_at)) > now;
}

/** Keep only well-typed fields: provider output is untrusted, and a string "99" would never count as exhausted. */
function window(w: unknown): UsageWindow | null {
  if (!w || typeof w !== 'object') return null;
  const { utilization: u, resets_at: r } = w as Record<string, unknown>;
  return { utilization: typeof u === 'number' && Number.isFinite(u) ? u : null, resets_at: typeof r === 'string' ? r : null };
}

/** A usage URL as logged: no query string or fragment, which may carry an access key. */
export function shownUrl(url: string): string {
  try { const u = new URL(url); return `${u.origin}${u.pathname}${u.search || u.hash ? ' (query hidden)' : ''}`; } catch { return '(usage url)'; }
}

/** `msg` with the URL, as written or as normalised, replaced by `shown`. */
function hideUrl(msg: string, url: string, shown: string): string {
  let href = url;
  try { href = new URL(url).href; } catch { /* as written */ }
  return msg.split(url).join(shown).split(href).join(shown);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function blank(a: AccountConfig): AccountUsage {
  return { account: a.id, label: a.label, colour: a.colour, email: null, name: null, plan: null, fiveHour: null, weekly: null,
    fiveHourResetsAt: null, weeklyResetsAt: null, stale: true, updatedAt: null };
}

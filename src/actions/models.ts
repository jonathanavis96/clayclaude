import type { AccountConfig, Config, HostConfig } from '../config.js';
import { readState, writeStateKey } from '../dismissed.js';

/**
 * The models + New offers (Task 46): what each account's token can use, read from the API's model list on the account's
 * own host (the probe's `models` mode), cached per account for a day. A failure falls back to the last good list, then to
 * BUILTIN_MODELS. `launch.models` in the config adds extra entries.
 */
export interface ModelInfo { id: string; name: string; created?: string }

/** A model id as passed to `claude --model`: the config's rule. It is always one argv element, never shell text. */
export const MODEL_ID_RE = /^[\w.\[\]-]{1,64}$/;
/** Claude Code's own model aliases, still accepted from the config and the tablet. */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable'] as const;
/** The order families are offered in; anything else sorts after them. */
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];

/** Offered when an account has never had a good list. */
export const BUILTIN_MODELS: readonly ModelInfo[] = [
  { id: 'claude-opus-5-5', name: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1' },
  { id: 'claude-opus-5', name: 'Opus 5' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5' },
  { id: 'claude-fable-5', name: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
];

const MAX_NAME = 64;
const MAX_MODELS = 200;

const familyIndex = (id: string) => {
  const i = FAMILIES.findIndex((f) => new RegExp(`(^|[-_.])${f}($|[-_.\\[])`).test(id));
  return i < 0 ? FAMILIES.length : i;
};
const time = (m: ModelInfo) => { const t = m.created ? Date.parse(m.created) : NaN; return Number.isFinite(t) ? t : undefined; };

/** Newest first where both have a date; a dated model before an undated one; otherwise the list's own order. */
function newestFirst(list: ModelInfo[]): ModelInfo[] {
  return list.map((m, i) => ({ m, i, t: time(m) })).sort((a, b) =>
    a.t !== undefined && b.t !== undefined ? b.t - a.t || a.i - b.i : a.t !== undefined ? -1 : b.t !== undefined ? 1 : a.i - b.i).map((x) => x.m);
}

/**
 * The launcher's order: the newest model of each family (Opus, Sonnet, Haiku, Fable, those present), then under More
 * every other model, family by family in that order (others last), newest first within each.
 */
export function groupModels(list: readonly ModelInfo[]): { main: ModelInfo[]; more: ModelInfo[] } {
  const seen = new Set<string>();
  const unique = list.filter((m) => !seen.has(m.id) && seen.add(m.id));
  const sorted = newestFirst(unique);
  const main = FAMILIES.map((_, f) => sorted.find((m) => familyIndex(m.id) === f)).filter((m): m is ModelInfo => !!m);
  const rest = sorted.filter((m) => !main.includes(m));
  const more = rest.map((m, i) => ({ m, i, f: familyIndex(m.id) })).sort((a, b) => a.f - b.f || a.i - b.i).map((x) => x.m);
  return { main, more };
}

/** A model entry from a host, kept only if well formed: an argv-safe id, a short name (the id when missing), a date string. */
export function cleanModel(raw: unknown): ModelInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const id = r.id;
  if (typeof id !== 'string' || !MODEL_ID_RE.test(id) || id.startsWith('-')) return null;
  const nm = typeof r.display_name === 'string' ? r.display_name : typeof r.name === 'string' ? r.name : '';
  const name = nm.replace(/[\p{Cc}\u2028\u2029\u202A-\u202E\u2066-\u2069]/gu, ' ').trim().replace(/^Claude\s+(?=\S)/, '').slice(0, MAX_NAME) || id;   // the API's "Claude Opus 5.5" reads "Opus 5.5"
  const c = typeof r.created_at === 'string' ? r.created_at : typeof r.created === 'string' ? r.created : undefined;
  return { id, name, ...(c && c.length <= 40 ? { created: c } : {}) };
}

const cleanList = (raw: unknown): ModelInfo[] => (Array.isArray(raw) ? raw.slice(0, MAX_MODELS).map(cleanModel).filter((m): m is ModelInfo => !!m) : []);

export type ProbeFn = (host: HostConfig, req: object) => Promise<unknown>;

interface Entry { at: number; models: ModelInfo[] }

/** What the probe needs to find an account's token on its host. Names and paths only, never a token. */
function probeAccount(a: AccountConfig): object {
  const u = a.usage;
  if (u.provider === 'token') return { key: a.id, configDir: a.configDir, kind: 'token', tokenEnv: u.tokenEnv, ...(u.envFile ? { envFile: u.envFile } : {}) };
  return { key: a.id, configDir: a.configDir, kind: 'oauth' };
}

/**
 * Each account's model list: in memory and under `models` in state.json, refreshed when the launcher opens and the list
 * is a day old. A host is asked once for all its due accounts. A failed account is not asked again for `failTtlMs`.
 */
export class ModelCache {
  private good = new Map<string, Entry>();
  private failedAt = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private now: () => number;
  private statePath: string | null;
  private ttlMs: number; private failTtlMs: number; private waitMs: number;
  private log: (m: string) => void;

  constructor(private cfg: Config, private probe: ProbeFn, o: { now?: () => number; statePath?: string | null; ttlMs?: number; failTtlMs?: number; waitMs?: number; log?: (m: string) => void } = {}) {
    this.now = o.now ?? Date.now;
    this.statePath = o.statePath ?? null;
    this.ttlMs = o.ttlMs ?? 24 * 3_600_000;
    this.failTtlMs = o.failTtlMs ?? 10 * 60_000;
    this.waitMs = o.waitMs ?? 4000;
    this.log = o.log ?? ((m) => console.warn(m));
    const saved = this.statePath ? readState(this.statePath).models : undefined;
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const a of cfg.accounts) {
        const e = (saved as Record<string, unknown>)[a.id] as { at?: unknown; models?: unknown } | undefined;
        const models = cleanList(e?.models);
        if (e && typeof e.at === 'number' && Number.isFinite(e.at) && models.length) this.good.set(a.id, { at: e.at, models });
      }
    }
  }

  /** The account's models as offered: its discovered (or last good, or built-in) list, then the config's extras. */
  list(accountId: string): ModelInfo[] {
    const base = this.good.get(accountId)?.models ?? [...BUILTIN_MODELS];
    const have = new Set(base.map((m) => m.id));
    const extras = this.cfg.launch.models.filter((id) => !have.has(id) && (have.add(id), true)).map((id) => ({ id, name: id }));
    return [...base, ...extras];
  }

  /** What the server accepts for this account: its list, the built-in list, the config's extras and the aliases. */
  allowed(accountId: string): Set<string> {
    return new Set([...this.list(accountId).map((m) => m.id), ...BUILTIN_MODELS.map((m) => m.id), ...MODEL_ALIASES]);
  }

  /** Asks the hosts of the accounts whose list is due. Resolves when they answer or after `waitMs`, whichever is first. */
  async refresh(): Promise<void> {
    const t = this.now();
    const due = this.cfg.accounts.filter((a) => {
      const g = this.good.get(a.id);
      if (g && t - g.at < this.ttlMs) return false;
      const f = this.failedAt.get(a.id);
      return f === undefined || t - f >= this.failTtlMs;
    });
    const jobs = this.cfg.hosts.map((h) => {
      const accts = due.filter((a) => a.host === h.id);
      if (!accts.length) return this.inflight.get(h.id);
      let p = this.inflight.get(h.id);
      if (!p) {
        p = this.fetch(h, accts).finally(() => this.inflight.delete(h.id));
        this.inflight.set(h.id, p);
      }
      return p;
    }).filter((p): p is Promise<void> => !!p);
    if (!jobs.length) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.all(jobs), new Promise<void>((r) => { timer = setTimeout(r, this.waitMs); })]);
    clearTimeout(timer);
  }

  private async fetch(host: HostConfig, accts: AccountConfig[]): Promise<void> {
    let r: { accounts?: unknown } | undefined;
    try { r = (await this.probe(host, { mode: 'models', accounts: accts.map(probeAccount) })) as { accounts?: unknown }; }
    catch (e) { this.log(`clayclaude: model list from ${host.id} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
    const entries = Array.isArray(r?.accounts) ? (r!.accounts as Record<string, unknown>[]) : [];
    const t = this.now();
    let changed = false;
    for (const a of accts) {
      const e = entries.find((x) => x && typeof x === 'object' && x.key === a.id);
      const models = e?.ok === true ? cleanList(e.models) : [];
      if (models.length) { this.good.set(a.id, { at: t, models }); this.failedAt.delete(a.id); changed = true; }
      else {
        this.failedAt.set(a.id, t);
        if (e) this.log(`clayclaude: model list for ${a.id} failed: ${typeof e.error === 'string' ? e.error.slice(0, 200) : e.ok === true ? 'empty list' : 'error'}${typeof e.status === 'number' ? ` (HTTP ${e.status})` : ''}`);
      }
    }
    if (changed) this.save();
  }

  private save() {
    if (!this.statePath) return;
    try { writeStateKey(this.statePath, 'models', Object.fromEntries(this.good)); }
    catch (e) { this.log(`clayclaude: could not save state.json: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
  }
}

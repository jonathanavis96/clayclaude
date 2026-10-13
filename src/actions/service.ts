import type { Config } from '../config.js';
import type { ProbeSnapshot, Session } from '../types.js';
import type { DismissedStore } from '../dismissed.js';
import { cleanNickname, renameIn, type NicknameStore } from '../nicknames.js';
import { buildSummary } from '../core/summary.js';
import { SendGuard, answer, readPrompt } from './answer.js';
import { makeExec, type HostExec } from './exec.js';
import { CapsCache, RepoLister, launch, launchOptions, type ProbeFn } from './launch.js';
import { ModelCache } from './models.js';
import type { PendingLaunches } from './pending.js';
import { appCmd, chromeCmd, launchDetached, terminalCmd, type Cmd, type GuiLauncher } from './open.js';
import { detectPlatform, type PlatformEnv } from './platform.js';
import { publicConfig } from './public-config.js';
import { fail, type ActionApi, type Fail, type Result, type SessionSummary } from './types.js';
import { ActionError, parseTmuxRef, type TmuxRef } from './validate.js';
import { renameWindow, tmuxNameProblem, windowTarget } from './window-rename.js';

export interface ServiceDeps {
  cfg: Config;
  sessions: () => Session[];
  probe: ProbeFn;
  exec?: HostExec;
  gui?: GuiLauncher;
  env?: PlatformEnv;
  now?: () => number;
  /** Clearing stopped sessions (spec §5.1): the dismissed list, each session's registry files, and a hook to re-filter the board. */
  clear?: { store: DismissedStore; files(key: string): { configDir: string; files: string[] } | undefined; changed(): void };
  /** Launches Claude has not registered yet (Task 40): each Start adds one, and the board is re-sent at once. */
  pending?: { store: Pick<PendingLaunches, 'add'>; changed(): void };
  /** Board nicknames (Task 41). */
  names?: NicknameStore;
  /** state.json, where each account's model list is kept between restarts (Task 46). Memory only without it. */
  statePath?: string;
}

const toFail = (e: unknown): Fail =>
  e instanceof ActionError ? fail(e.code as never, e.message) : fail('failed', e instanceof Error ? e.message.split('\n')[0] : 'failed');

export function createActionService(d: ServiceDeps): ActionApi & { publicConfig(): unknown } {
  const exec = d.exec ?? makeExec();
  const gui = d.gui ?? launchDetached;
  const env = d.env ?? detectPlatform();
  const now = d.now ?? Date.now;
  const caps = new CapsCache(d.probe, now);
  const repos = new RepoLister(d.cfg, d.probe, now);
  const models = new ModelCache(d.cfg, d.probe, { now, statePath: d.statePath ?? null });
  const summaries = new Map<string, { at: number; value: SessionSummary }>();
  const guard = new SendGuard(now);   // one per daemon: a double tap must not type twice

  const find = (id: string): Session | Fail => d.sessions().find((s) => s.key === id) ?? fail('unknown_session', 'that session is no longer listed');
  const isFail = (x: Session | Fail): x is Fail => 'ok' in x;

  async function run(cmd: Cmd, done: string): Promise<Result<{ message: string }>> {
    const r = await gui(cmd);
    return r.ok ? { ok: true, message: done } : fail('failed', r.error ?? 'could not start the program');
  }

  async function attachRef(session: Session | { host: string; name: string }, ref: TmuxRef, title: string): Promise<Result<{ message: string }>> {
    const host = d.cfg.hosts.find((h) => h.id === session.host);
    if (!host) return fail('unknown_session', 'unknown host');
    return run(terminalCmd(d.cfg, host, ref, env, title), `Attached in a terminal (${ref.session})`);
  }

  /** Asks the session's host to remove its registry files; the probe re-checks every condition itself. Never throws. */
  async function reap(s: Session): Promise<number> {
    const account = d.cfg.accounts.find((a) => a.id === s.account);
    const host = d.cfg.hosts.find((h) => h.id === s.host);
    const files = d.clear?.files(s.key)?.files ?? [];
    if (!account || !host || !s.hostOnline || !files.length) return 0;
    try {
      const r = (await d.probe(host, { mode: 'reap', configDir: account.configDir, sessionId: s.sessionId, files })) as { results?: { removed?: boolean }[] };
      return (r.results ?? []).filter((x) => x.removed === true).length;
    } catch { return 0; } // the row stays hidden; the file is left for another day
  }

  /** Hide first (saved, then the board re-filtered), then reap: one host at a time per host, hosts in parallel. */
  async function clearSessions(list: Session[]): Promise<Result<{ removed: number }>> {
    const c = d.clear!;
    try { await c.store.add(list.map((s) => s.key)); }
    catch (e) { return fail('failed', `could not save the cleared sessions: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
    c.changed();
    // A cleared session's nickname goes with it. Not saved is not fatal: the session is hidden either way.
    await d.names?.remove(list.map((s) => s.key)).catch(() => {});
    const byHost = new Map<string, Session[]>();
    for (const s of list) byHost.set(s.host, [...(byHost.get(s.host) ?? []), s]);
    const counts = await Promise.all([...byHost.values()].map(async (ss) => { let n = 0; for (const s of ss) n += await reap(s); return n; }));
    return { ok: true, removed: counts.reduce((a, b) => a + b, 0) };
  }

  const stopped = (s: Session) => !s.live && s.state === 'stopped';

  const api: ActionApi & { publicConfig(): unknown } = {
    async open(id) {
      try {
        const s = find(id);
        if (isFail(s)) return s;
        const account = d.cfg.accounts.find((a) => a.id === s.account);
        if (!account) return fail('unknown_account', 'unknown account');
        if (account.open.type === 'tmux') return api.attach(id);
        if (!s.bridgeSessionId) return fail('no_bridge', 'This session has no remote-control link. Use Attach tmux.');
        if (account.open.type === 'chrome')
          return run(chromeCmd(d.cfg, account, s.bridgeSessionId), `Opened in Chrome${account.open.profileDirectory ? ` (${account.open.profileDirectory})` : ''}`);
        return run(appCmd(d.cfg, env, s.bridgeSessionId), 'Opened in the Claude app');
      } catch (e) { return toFail(e); }
    },

    async attach(id) {
      try {
        const s = find(id);
        if (isFail(s)) return s;
        const ref = parseTmuxRef(s.tmux);
        if (!ref) return fail('no_tmux', 'this session is not running in tmux');
        if (!s.hostOnline) return fail('host_offline', `${s.host} is offline`);
        return await attachRef(s, ref, s.name);
      } catch (e) { return toFail(e); }
    },

    readPrompt: (id) => readPrompt({ cfg: d.cfg, sessions: d.sessions, exec, quickReplies: () => d.cfg.ui.quickReplies, lastAssistantText: async (s) => {
      const r = await api.summary(s.key);
      return r.ok ? r.summary.lastAssistantText : undefined;
    } }, id),

    answer: (req) => answer({ cfg: d.cfg, sessions: d.sessions, exec, quickReplies: () => d.cfg.ui.quickReplies, guard }, req),

    launch: (req) => launch({ cfg: d.cfg, exec, caps, repos, models, attachNew: (host, ref, title) => attachRef({ host: host.id, name: title }, ref, title),
      onStarted: d.pending ? (l) => { d.pending!.store.add(l); d.pending!.changed(); } : undefined }, req),

    launchOptions: () => launchOptions({ cfg: d.cfg, caps, models }),

    async repos(accountId) {
      const a = d.cfg.accounts.find((x) => x.id === accountId);
      if (!a) return fail('unknown_account', 'no such account');
      try { return { ok: true, repos: await repos.list(a.host) }; } catch (e) { return toFail(e); }
    },

    async summary(id) {
      const s = find(id);
      if (isFail(s)) return s;
      const hit = summaries.get(id);
      if (hit && now() - hit.at < 3000) return { ok: true, summary: hit.value };
      const account = d.cfg.accounts.find((a) => a.id === s.account);
      const host = d.cfg.hosts.find((h) => h.id === s.host);
      if (!account || !host) return fail('unknown_account', 'unknown account');
      if (!s.hostOnline) return fail('host_offline', `${host.id} is offline`);
      try {
        const snap = (await d.probe(host, { mode: 'snapshot', dirs: [account.configDir], only: s.sessionId, tailBytes: 1_048_576, maxLines: 400, clip: 400 })) as ProbeSnapshot;
        const reg = snap.dirs[0]?.registries[0];
        const value = buildSummary(reg?.transcript ?? [], typeof reg?.data?.startedAt === 'number' ? (reg.data.startedAt as number) : undefined);
        for (const [k, v] of summaries) if (now() - v.at >= 3000) summaries.delete(k); // stale entries only ever miss
        summaries.set(id, { at: now(), value });
        return { ok: true, summary: value };
      } catch (e) { return toFail(e); }
    },

    async clear(id) {
      if (!d.clear) return fail('unsupported', 'clearing sessions is not available');
      const s = find(id);
      if (isFail(s)) return s;
      // Never a live session: the latest snapshot decides here, and the probe checks again on the host.
      if (!stopped(s)) return fail('live', 'That session is still running. Only stopped sessions can be cleared.');
      const r = await clearSessions([s]);
      return r.ok ? { ok: true, message: `Cleared ${s.name}`, removed: r.removed } : r;
    },

    async clearStopped() {
      if (!d.clear) return fail('unsupported', 'clearing sessions is not available');
      const list = d.sessions().filter(stopped);
      if (!list.length) return { ok: true, message: 'No stopped sessions to clear', cleared: 0, removed: 0 };
      const r = await clearSessions(list);
      return r.ok ? { ok: true, message: `Cleared ${list.length} stopped session${list.length === 1 ? '' : 's'}`, cleared: list.length, removed: r.removed } : r;
    },

    async rename(id, name, o = {}) {
      if (!d.names) return fail('unsupported', 'renaming sessions is not available');
      const s = find(id);
      if (!o.tmux || isFail(s)) return renameIn(d.names, s, name);
      // Also rename the tmux window (Task 42a): everything is checked before the board name changes. The window takes
      // the name the board ends up showing: the new one, or on Reset the session's own.
      const host = d.cfg.hosts.find((h) => h.id === s.host);
      const t = windowTarget(s, host);
      if ('ok' in t) return t;
      let target = s.name;
      if (name !== null) { const c = cleanNickname(name); if (!c.ok) return fail('bad_request', c.message); target = c.name; }
      const problem = tmuxNameProblem(target);
      if (problem) return fail('bad_request', problem);
      const r = await renameIn(d.names, s, name);
      if (!r.ok) return r;
      const err = await renameWindow(exec, host!, t.ref, s.pid, target);
      return err ? { ...r, message: `${r.message}. The tmux window was not renamed: ${err}`, tmuxError: err } : { ...r, message: `${r.message}, and its tmux window` };
    },

    /** What the settings panel may show. Never includes tokens or credential contents. */
    publicConfig: () => publicConfig(d.cfg),
  };
  return api;
}

import type { Config } from '../config.js';
import type { Session } from '../types.js';
import { readPane } from './answer.js';
import type { HostExec } from './exec.js';
import type { StartedLaunch } from './launch.js';
import { parseTmuxRef, type TmuxRef } from './validate.js';

/** How long a launch is shown without Claude registering a session for it (Task 40). */
export const PENDING_MAX_MS = 10 * 60_000;

interface Entry { launch: StartedLaunch; ref: TmuxRef; at: number; state: 'working' | 'needs-you'; since: number; question?: string }

/**
 * Panes started with + New that Claude has not registered yet (Task 40). Claude asks "do you trust this folder?"
 * in a folder the account never trusted, before it writes its registry file, so without this the board would never
 * show the session and the tablet could not reach it.
 *
 * Each one is a row in state working (shown as STARTING) until, on a poll, its pane shows the trust question: then
 * it is a needs-you row whose question the answer sheet answers. Only panes that `launch` reported are listed, and an
 * answer goes through the usual checks (pane id, window, and the pid tmux reported, in the foreground). The row goes
 * when Claude registers a session for the pane (same host and pane, or the same pid), when the pane closes or
 * changes hands, or after PENDING_MAX_MS.
 */
export class PendingLaunches {
  private entries = new Map<string, Entry>();
  private now: () => number;
  /** `onRegistered`: told when Claude registers the session for a launch (Task 42a: a name from + New becomes its board name). */
  constructor(private o: { cfg: Config; exec: HostExec; now?: () => number; onRegistered?: (l: StartedLaunch, s: Session) => void }) { this.now = o.now ?? Date.now; }

  add(l: StartedLaunch): void {
    const ref = parseTmuxRef(l.target);
    if (!ref || !Number.isInteger(l.pid) || l.pid <= 0) return;
    if (!this.o.cfg.hosts.some((h) => h.id === l.host) || !this.o.cfg.accounts.some((a) => a.id === l.account && a.host === l.host)) return;
    const at = this.now();
    this.entries.set(keyOf(l, ref), { launch: l, ref, at, state: 'working', since: at });
  }

  sessions(): Session[] {
    return [...this.entries].map(([key, e]) => ({
      key, host: e.launch.host, account: e.launch.account, sessionId: key.slice(e.launch.host.length + e.launch.account.length + 2),
      pid: e.launch.pid, name: e.launch.name, cwd: e.launch.cwd, state: e.state, stateSince: e.since, live: true,
      tmux: e.launch.target, overContext: false, hostOnline: true, lastSeen: this.now(), starting: true,
      ...(e.state === 'needs-you' ? { question: e.question } : { currentAction: 'Starting Claude…' }),
    }));
  }

  /** One poll: drop what has registered, expired or closed, and read the rest of the panes. Never throws. */
  async refresh(registered: Session[]): Promise<void> {
    await Promise.all([...this.entries].map(async ([key, e]) => {
      const l = e.launch;
      const reg = registered.find((s) => s.live && s.host === l.host && (s.tmux === l.target || s.pid === l.pid));
      if (reg) { this.entries.delete(key); this.o.onRegistered?.(l, reg); return; }
      if (this.now() - e.at >= PENDING_MAX_MS) { this.entries.delete(key); return; }
      const host = this.o.cfg.hosts.find((h) => h.id === l.host)!;
      let r: Awaited<ReturnType<typeof readPane>>;
      try { r = await readPane(this.o.exec, host, e.ref, l.pid); } catch { return; }
      if (!this.entries.has(key)) return;
      if (!r.ok) { if (r.error === 'pane_gone') this.entries.delete(key); return; }   // otherwise unreadable for now: keep it
      const state = r.parsed.trust ? 'needs-you' : 'working';
      const question = r.parsed.trust ? r.parsed.title : undefined;
      if (state !== e.state || question !== e.question) this.entries.set(key, { ...e, state, question, since: this.now() });
    }));
  }
}

/** `host:account:launch-<window>-<pane>`: one row per launched pane, apart from any registered session id. */
const keyOf = (l: StartedLaunch, ref: TmuxRef) => `${l.host}:${l.account}:launch-${ref.window.slice(1)}-${ref.pane.slice(1)}`;

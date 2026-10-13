import { EventEmitter } from 'node:events';
import { parseConfig, type Config } from '../config.js';
import { promptHash } from '../actions/hash.js';
import { fail, type ActionApi, type PromptView, type RepoEntry, type Result, type SessionSummary } from '../actions/types.js';
import { BOARD, DEMO_MODELS, DEMO_YAML, GALLERY, createClock, demoUsage, sessionAt, type DemoDef, type SessionOverride } from './scenario.js';
import type { AccountUsage, Session } from '../types.js';
import { publicConfig } from '../actions/public-config.js';
import { NicknameStore, cleanNickname, renameIn } from '../nicknames.js';
import { groupModels } from '../actions/models.js';
import { PERMISSION_MODES, defaultModeFor } from '../actions/launch.js';

export type ScenarioName = 'board' | 'gallery';

/** How long (real time) an answered demo session shows as working before its question comes back. */
export const ANSWERED_SHOW_MS = 20_000;

const MENU: PromptView = {
  kind: 'menu', hash: '', title: 'Do you want to proceed?', detail: 'Bash command\nnpm run build\nBuild the project',
  options: [
    { key: '1', label: 'Yes', selected: true },
    { key: '2', label: "Yes, and don't ask again for npm run build commands in /home/demo/code/tidepool-ui", selected: false },
    { key: '3', label: 'No, and tell Claude what to do differently (esc)', selected: false },
  ], quickReplies: [],
};
const TEXT: PromptView = { kind: 'text', hash: '', title: '', detail: 'Should I also update the changelog, or leave it for the release PR?', options: [], quickReplies: [] };
/** Claude's folder-trust question as 2.1.296 draws it (test/fixtures/panes/trust-folder.txt), for a folder never trusted (Task 40). */
const TRUST_QUESTION = 'Is this a project you created or one you trust?';
const trustView = (folder: string): PromptView => ({
  kind: 'menu', trust: true, hash: '', title: TRUST_QUESTION, quickReplies: [],
  detail: `Accessing workspace:\n\n${folder}\n\nQuick safety check: ${TRUST_QUESTION} (Like your own code, a well-known open source project, or work from your team). If not, take a moment to review what's in this folder first.\n\nClaude Code'll be able to read, edit, and execute files here.\n\nSecurity guide`,
  options: [{ key: '1', label: 'No, exit', selected: true }, { key: '2', label: 'Yes, I trust this folder', selected: false }],
});
/** The demo folder the accounts have never trusted: + New there stops at the trust question. */
const UNTRUSTED = 'kestrel-bot';

const withHash = (v: PromptView, quick: string[]): PromptView => ({ ...v, quickReplies: quick, hash: promptHash([v.kind, v.title, v.detail, ...v.options.map((o) => o.key + o.label)]) });

const REPOS = ['orchard-api', 'tidepool-ui', 'lantern-docs', 'mossgarden-infra', 'pebble-cli', 'quill-site', 'ember-sync', 'riverbank-etl',
  'fernwood-app', 'harbor-notes', 'cobalt-bench', 'willow-sdk', 'atlas-importer', 'kestrel-bot'];

export class DemoCollector extends EventEmitter {
  private timer?: NodeJS.Timeout;
  private last = '';
  constructor(private list: () => Session[]) { super(); }
  sessions() { return this.list(); }
  pollOnce() { const l = this.list(); const j = JSON.stringify(l); if (j !== this.last) { this.last = j; this.emit('update', l); } return Promise.resolve(l); }
  start() { void this.pollOnce(); this.timer = setInterval(() => void this.pollOnce(), 1000); }
  stop() { clearInterval(this.timer); }
}

export class DemoUsage extends EventEmitter {
  constructor(private now: () => number) { super(); }
  usage(): AccountUsage[] { return demoUsage(this.now()); }
  isExhausted() { return false; }
  publicShape() {
    return Object.fromEntries(this.usage().map((u) => [u.account, { label: u.label, stale: false,
      five_hour: { utilization: u.fiveHour, resets_at: u.fiveHourResetsAt }, seven_day: { utilization: u.weekly, resets_at: u.weeklyResetsAt } }]));
  }
  start() { /* static */ } stop() { /* static */ }
}

export interface DemoOptions {
  scenario?: ScenarioName; speed?: number; now?: () => number; launchDelayMs?: number;
  /** Show this many sessions: the scenario's own, cut short or repeated under numbered names (`orchard-api-2`). */
  sessions?: number;
}

export function createDemo(opts: DemoOptions = {}) {
  const now = opts.now ?? Date.now;
  const scenario = opts.scenario ?? 'board';
  const speed = scenario === 'gallery' ? 0 : opts.speed ?? 1;
  const clock = createClock(speed, now);
  const cfg: Config = parseConfig(DEMO_YAML, '/home/demo');
  const base = scenario === 'gallery' ? GALLERY : BOARD;
  const defs: DemoDef[] = opts.sessions === undefined ? [...base] : Array.from({ length: opts.sessions }, (_, i) => {
    const d = base[i % base.length], round = Math.floor(i / base.length);
    return round ? { ...d, id: `${d.id}-${round + 1}`, name: `${d.name}-${round + 1}`, offsetMin: d.offsetMin + round * 7 } : d;
  });
  const overrides = new Map<string, SessionOverride>();
  const answered = new Set<string>();
  /** Sessions cleared from the board (spec §5.1): hidden until the demo restarts or the session is seen live again. */
  const dismissed = new Set<string>();
  const launched: { def: DemoDef; at: number }[] = [];
  /** Board nicknames (Task 41), in memory: gone when the demo restarts. */
  const names = new NicknameStore(null);

  const sessions = (): Session[] => {
    const t = now();
    const all = [...defs.map((d) => ({ d, startMin: 0, ov: undefined as SessionOverride | undefined })),
      ...launched.map((l) => ({ d: l.def, startMin: clock.virtualMin() - ((t - l.at) / 60_000) * speed, ov: undefined as SessionOverride | undefined }))];
    return all.map(({ d, startMin }, i) => {
      const key = `${d.host}:${d.account}:${d.id}`;
      let ov = overrides.get(key);
      // An answered session shows as working for a while (real time), then its script resumes and the
      // question comes back, so the demo can be answered again and again.
      if (ov && t - ov.since > ANSWERED_SHOW_MS) { overrides.delete(key); answered.delete(key); ov = undefined; }
      return sessionAt(d, launched.some((l) => l.def === d) ? clock.virtualMin() - startMin : clock.virtualMin(), t, cfg.cacheTtlMinutes, i, ov);
    }).filter((s) => { if (s.live) dismissed.delete(s.key); return s.live || !dismissed.has(s.key); });   // seen live again: un-cleared (T39)
  };

  const find = (id: string) => sessions().find((s) => s.key === id);
  const defOf = (s: Session) => [...defs, ...launched.map((l) => l.def)].find((d) => `${d.host}:${d.account}:${d.id}` === s.key)!;
  const quick = cfg.ui.quickReplies;

  const promptFor = (s: Session): PromptView | null => {
    if (s.state !== 'needs-you' || answered.has(s.key)) return null;
    const d = defOf(s);
    if (d.prompt === 'trust') return withHash(trustView(s.cwd), []);
    return d.prompt === 'menu' ? withHash(MENU, quick) : withHash({ ...TEXT, detail: s.question ?? TEXT.detail }, quick);
  };

  const api: ActionApi = {
    async open(id) {
      const s = find(id);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      const acct = cfg.accounts.find((a) => a.id === s.account)!;
      if (acct.open.type === 'tmux') return api.attach(id);
      if (!s.bridgeSessionId) return fail('no_bridge', 'This session has no remote-control link. Use Attach tmux.');
      if (defOf(s).failOpen) return fail('failed', 'Chrome profile "Profile 2" is locked by another window (simulated)');
      return { ok: true, message: `Simulated: would open ${s.name} in ${acct.open.type === 'chrome' ? 'Chrome (Profile 2)' : 'the Claude app'}` };
    },
    async attach(id) {
      const s = find(id);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      if (!s.tmux) return fail('no_tmux', 'this session is not running in tmux');
      return { ok: true, message: `Simulated: would attach to ${s.tmux}` };
    },
    async readPrompt(id) {
      const s = find(id);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      if (!s.tmux) return fail('no_tmux', 'this session has no tmux pane, so it cannot be answered from here');
      const p = promptFor(s);
      if (!p) return fail('no_prompt', 'nothing is waiting for input in that pane');
      return { ok: true, prompt: p, question: s.question, lastAssistantText: defOf(s).lastReply };
    },
    async answer(req) {
      const s = find(req.sessionId);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      const p = promptFor(s);
      if (!p) return fail('no_prompt', 'nothing is waiting for input in that pane');
      if (p.hash !== req.promptHash) return fail('prompt_changed', 'The prompt changed. Nothing was sent.', p);
      if (req.choice !== undefined && !p.options.some((o) => o.key === req.choice)) return fail('bad_request', 'that is not one of the options on screen', p);
      if (req.text !== undefined && p.kind !== 'text') return fail('bad_request', 'a menu is showing; choose one of its options', p);
      if (p.trust) {
        // Yes: Claude starts and registers, so the row becomes an ordinary working session. No: Claude exits and the pane closes.
        const d = defOf(s);
        if (req.choice === '2') Object.assign(d, { starting: undefined, prompt: undefined, question: undefined, segments: [{ state: 'working', fromMin: 0, toMin: 1_000_000 }] });
        else launched.splice(launched.findIndex((l) => l.def === d), 1);
        void collector.pollOnce();
        return { ok: true, sent: `option ${req.choice}` };
      }
      if (req.text !== undefined && req.text.trim().toLowerCase() === 'fail') return fail('failed', 'tmux: can\'t find pane (simulated failure; type anything else)');
      answered.add(s.key);
      overrides.set(s.key, { state: 'working', since: now() });
      return { ok: true, sent: req.choice !== undefined ? `option ${req.choice}` : `reply (${req.text!.length} characters)` };
    },
    async launchOptions() {
      // Task 46: a fixture model list, grouped as the daemon groups a discovered one. Lab plays an older claude without --permission-mode.
      const g = groupModels(DEMO_MODELS);
      return { accounts: cfg.accounts.map((a) => ({ a, modes: a.id === 'lab' ? [] : PERMISSION_MODES.filter((m) => m !== 'bypassPermissions' || cfg.launch.allowBypassPermissions) })).map(({ a, modes }) => ({
        id: a.id, label: a.label, colour: a.colour, host: a.host, canLaunch: true,
        models: g.main.map((m) => m.id), moreModels: g.more.map((m) => m.id), modelNames: Object.fromEntries(DEMO_MODELS.map((m) => [m.id, m.name])),
        efforts: a.id === 'lab' ? ['low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max'], remoteControl: a.id !== 'lab',
        modes, defaultMode: defaultModeFor(cfg, modes),
      })) };
    },
    async repos(accountId) {
      if (!cfg.accounts.some((a) => a.id === accountId)) return fail('unknown_account', 'no such account');
      const repos: RepoEntry[] = REPOS.map((name, i) => ({ path: `/home/demo/code/${name}`, name, lastUsedMs: now() - i * 3_600_000 }));
      return { ok: true, repos };
    },
    async launch(req) {
      const a = cfg.accounts.find((x) => x.id === req.account);
      if (!a) return fail('unknown_account', `no such account "${req.account}"`);
      if (!REPOS.some((r) => req.repo === `/home/demo/code/${r}`)) return fail('forbidden', "that folder is not a repository under this host's repoRoots");
      await new Promise((r) => setTimeout(r, opts.launchDelayMs ?? 400));
      // Task 42a: a Name from + New is checked like a nickname and, as `claude --name` does, becomes the session's name.
      const given = req.options.name === undefined ? undefined : cleanNickname(req.options.name);
      if (given && !given.ok) return fail('bad_request', given.message);
      // Task 46: the same checks as the daemon's, against the demo's list: a listed model, a known mode, bypass only confirmed.
      const o = req.options;
      if (o.model !== undefined && !DEMO_MODELS.some((m) => m.id === o.model) && !['opus', 'sonnet', 'haiku', 'fable'].includes(o.model)) return fail('bad_request', `model "${o.model}" is not in this account's model list`);
      if (o.permissionMode && !(PERMISSION_MODES as readonly string[]).includes(o.permissionMode)) return fail('bad_request', 'not a permission mode');
      if (o.permissionMode === 'bypassPermissions' && (!cfg.launch.allowBypassPermissions || (o.confirmBypass !== true && cfg.launch.defaultMode !== 'bypassPermissions'))) return fail('bad_request', 'bypassPermissions needs the confirm step');
      if (a.id === 'side') return fail('failed', 'tmux: no server running on /tmp/tmux-1000/default (simulated)');
      const folder = req.repo.split('/').pop()!;
      const name = given?.ok ? given.name : folder;
      const def: DemoDef = { id: `${folder}-${launched.length + 1}`, name, account: a.id as DemoDef['account'], host: a.host as DemoDef['host'], tmux: `${a.host === 'rack' ? 'agents' : 'desk'}:@${20 + launched.length}.%${20 + launched.length}`,
        bridge: req.options.remoteControl ? `session_demo_new${launched.length}` : undefined, model: req.options.model?.startsWith('claude-') ? req.options.model : `claude-${req.options.model ?? 'opus'}-5-5`, effort: req.options.effort ?? 'high', contextPct: 3,
        segments: [{ state: 'working', fromMin: 0, toMin: 1_000_000 }], offsetMin: 0, lastPrompt: '', lastReply: '' };
      // A folder the account never trusted: a few seconds of STARTING, then the trust question, as on a real host (Task 40).
      if (folder === UNTRUSTED) Object.assign(def, { starting: true, prompt: 'trust', question: TRUST_QUESTION, contextPct: undefined,
        segments: [{ state: 'working', fromMin: 0, toMin: 0.05 }, { state: 'needs-you', fromMin: 0.05, toMin: 1_000_000 }] });
      launched.push({ def, at: now() });
      return { ok: true, message: `Simulated: started ${name} under ${a.label}`, target: def.tmux };
    },
    async clear(id) {
      const s = find(id);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      if (s.live || s.state !== 'stopped') return fail('live', 'That session is still running. Only stopped sessions can be cleared.');
      dismissed.add(s.key);
      await names.remove([s.key]);
      void collector.pollOnce();
      return { ok: true, message: `Cleared ${s.name}`, removed: 1 };
    },
    async clearStopped() {
      const list = sessions().filter((s) => !s.live && s.state === 'stopped');
      for (const s of list) dismissed.add(s.key);
      await names.remove(list.map((s) => s.key));
      void collector.pollOnce();
      return { ok: true, message: list.length ? `Cleared ${list.length} stopped session${list.length === 1 ? '' : 's'}` : 'No stopped sessions to clear', cleared: list.length, removed: list.length };
    },
    async rename(id, name, o) {
      const r = await renameIn(names, find(id), name);
      return r.ok && o?.tmux ? { ...r, message: `${r.message} (the demo renames no tmux window)` } : r;
    },
    async summary(id) {
      const s = find(id);
      if (!s) return fail('unknown_session', 'that session is no longer listed');
      const d = defOf(s);
      const t = now();
      const names = ['Read', 'Edit', 'Bash', 'Grep', 'Write'];
      const targets = ['src/routes/orders.ts', 'src/lib/backoff.ts', 'npm test -- --run', 'retryAfter', 'test/orders.test.ts', 'package.json'];
      const bucket = Math.floor(t / 6000);
      const tools = Array.from({ length: 12 }, (_, i) => ({ at: t - (11 - i) * 6000 - (t % 6000), name: names[(bucket + i) % 5], target: targets[(bucket + i * 2) % 6] }));
      const summary: SessionSummary = { lastPrompt: d.lastPrompt, lastAssistantText: d.lastReply, files: ['src/lib/backoff.ts', 'src/routes/orders.ts', 'test/orders.test.ts'], tools,
        toolCount: 40 + bucket % 7, tokensIn: 182_400, tokensOut: 14_950, startedAt: t - 95 * 60_000 };
      return { ok: true, summary };
    },
  };

  const collector = new DemoCollector(sessions);
  const usage = new DemoUsage(now);
  return { cfg, collector, usage, api, names, publicConfig: () => ({ ...publicConfig(cfg), demo: true }), stop: () => collector.stop() };
}

export type { Result };

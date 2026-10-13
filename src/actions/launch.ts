import type { AccountConfig, Config, HostConfig } from '../config.js';
import { errorLine, firstLine, type HostExec } from './exec.js';
import { fail, type LaunchAccountOptions, type LaunchOptions, type LaunchRequest, type RepoEntry, type Result } from './types.js';
import { ActionError, parseTmuxRef, safeName, type TmuxRef } from './validate.js';
import { cleanNickname } from '../nicknames.js';
import { BUILTIN_MODELS, MODEL_ALIASES, groupModels, type ModelCache, type ModelInfo } from './models.js';

export type ProbeFn = (host: HostConfig, req: object) => Promise<unknown>;

/* ---------- what the installed CLI supports ---------- */

export interface CliCaps { version?: string; efforts: string[]; remoteControl: boolean; model: boolean; name: boolean; permissionModes: string[] }

/**
 * The permission modes + New offers (Task 46), in the launcher's order. Manual (`manual`, or `default` in older CLIs) is
 * the CLI's own default and passes no flag. A mode the CLI lists that is not here is not offered. bypassPermissions is
 * offered only with `launch.allowBypassPermissions`, and needs the tablet's confirm.
 */
export const PERMISSION_MODES = ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] as const;
const DEFAULT_MODES = ['manual', 'default', ''];
export const BYPASS = 'bypassPermissions';

/** Read `claude --help`. An option the CLI does not list is reported as unsupported and hidden in the launcher. */
export function parseClaudeHelp(help: string, version?: string): CliCaps {
  const eff = /--effort\s+<[^>]*>[^(]{0,200}\(([a-z]+(?:,\s*[a-z]+)*)\)/.exec(help);
  return {
    version,
    efforts: eff ? eff[1].split(',').map((s) => s.trim()) : [],
    remoteControl: /--remote-control\b/.test(help),
    model: /--model\b/.test(help),
    name: /(^|\s)-n,\s*--name\b/m.test(help),
    // `--permission-mode <mode>  … (choices: "acceptEdits", "auto", …)`, wrapped over several lines by the CLI.
    permissionModes: [...(/--permission-mode\s+<[^>]*>[^(]{0,300}\(choices:\s*((?:"[A-Za-z]{1,32}",?\s*)+)\)/.exec(help)?.[1] ?? '').matchAll(/"([A-Za-z]{1,32})"/g)].map((m) => m[1]),
  };
}

type CapsEntry = { at: number; value: { caps: CliCaps } | { error: string } };

export class CapsCache {
  private byHost = new Map<string, CapsEntry>();
  private inflight = new Map<string, Promise<CapsEntry['value']>>();
  constructor(private probe: ProbeFn, private now: () => number = Date.now, private okTtlMs = 3_600_000, private failTtlMs = 30_000) {}

  async get(host: HostConfig): Promise<CapsEntry['value']> {
    const hit = this.byHost.get(host.id);
    if (hit && this.now() - hit.at < ('caps' in hit.value ? this.okTtlMs : this.failTtlMs)) return hit.value;
    let p = this.inflight.get(host.id);
    if (!p) {
      p = this.fetch(host).finally(() => this.inflight.delete(host.id));
      this.inflight.set(host.id, p);
    }
    return p;
  }

  private async fetch(host: HostConfig): Promise<CapsEntry['value']> {
    let value: CapsEntry['value'];
    try {
      const r = (await this.probe(host, { mode: 'cli', bin: host.claudeBin })) as { ok: boolean; help?: string; version?: string; error?: string };
      value = r.ok && r.help ? { caps: parseClaudeHelp(r.help, r.version) } : { error: r.error ?? 'claude --help failed' };
    } catch (e) {
      value = { error: e instanceof Error ? e.message : 'host unreachable' };
    }
    this.byHost.set(host.id, { at: this.now(), value });
    return value;
  }
}

/* ---------- repositories ---------- */

export class RepoLister {
  private cache = new Map<string, { at: number; repos: RepoEntry[] }>();
  constructor(private cfg: Config, private probe: ProbeFn, private now: () => number = Date.now, private ttlMs = 30_000) {}

  async list(hostId: string, force = false): Promise<RepoEntry[]> {
    const hit = this.cache.get(hostId);
    if (hit && !force && this.now() - hit.at < this.ttlMs) return hit.repos;
    const host = this.cfg.hosts.find((h) => h.id === hostId);
    if (!host) return [];
    const r = (await this.probe(host, {
      mode: 'repos', roots: host.repoRoots,
      configDirs: this.cfg.accounts.filter((a) => a.host === hostId).map((a) => a.configDir),
    })) as { ok: boolean; repos: RepoEntry[] };
    const repos = r.ok ? r.repos : [];
    this.cache.set(hostId, { at: this.now(), repos });
    return repos;
  }
}

/* ---------- the launch command ---------- */

/**
 * Static script, run as `bash -lc SCRIPT clayclaude-launch SESSION DIR NAME CONFIGDIR BIN ARGS…`.
 * Every variable arrives as a positional parameter, so nothing is ever interpolated into shell text.
 * The binary is resolved to an absolute path and PATH is passed along, because a tmux window
 * inherits the tmux server's environment, not this login shell's.
 * The default config dir (~/.claude) runs with CLAUDE_CONFIG_DIR unset: claude reads its global config
 * from $CLAUDE_CONFIG_DIR/.claude.json when it is set and ~/.claude.json when not, so setting it to
 * ~/.claude would give the session a different .claude.json from the user's plain `claude`.
 * `-u` also drops a value the tmux server's own environment may carry.
 * The window starts in the repo by `cd`, not `tmux -c`: tmux format-expands `-c`, so a folder named
 * `#(cmd)` would run cmd and `##`, `#{..}` or `#[..]` would change the path, and no escaping covers
 * all of them (tmux keeps a run of `#` before `[` as a style). A tmux command run from a shell that is
 * not attached to a session starts its new pane in that shell's directory.
 * A leading `~/` in the binary is expanded here, as the capability probe does.
 * `type -P` finds the executable file: `command -v` would give an alias's text or a function's name,
 * which tmux cannot run.
 */
export const LAUNCH_SCRIPT = [
  'S="$1"; DIR="$2"; NAME="$3"; CFG="$4"; BIN="$5"; shift 5',
  'case "$CFG" in "~") CFG="$HOME";; "~/"*) CFG="$HOME/${CFG#\\~/}";; esac',
  'case "$CFG" in ?*/) CFG="${CFG%/}";; esac',
  'case "$BIN" in "~/"*) BIN="$HOME/${BIN#\\~/}";; esac',
  'if [ "$CFG" = "$HOME/.claude" ]; then ENV=(-u CLAUDE_CONFIG_DIR); else ENV=("CLAUDE_CONFIG_DIR=$CFG"); fi',
  'ABS="$(type -P -- "$BIN")" || { echo "claude binary not found: $BIN (an executable file is needed; an alias or shell function will not do)" >&2; exit 127; }',
  'cd -- "$DIR" || exit 1',
  'FMT="#{session_name}:#{window_id}.#{pane_id} #{pane_pid}"',
  'if tmux has-session -t "=$S" 2>/dev/null; then',
  '  exec tmux new-window -P -F "$FMT" -t "=$S:" -n "$NAME" -- env "${ENV[@]}" "PATH=$PATH" "$ABS" "$@"',
  'else',
  '  exec tmux new-session -d -P -F "$FMT" -s "$S" -n "$NAME" -- env "${ENV[@]}" "PATH=$PATH" "$ABS" "$@"',
  'fi',
].join('\n');

/** `name`: this claude takes `-n/--name`. `sessionName`: the name asked for in + New (Task 42a), cleaned. */
export interface ValidOptions { model?: string; effort?: string; permissionMode?: string; remoteControl: boolean; openOnPc: boolean; name: boolean; sessionName?: string }

/** The models allowed without a discovered list: the built-in list, the config's extras and the aliases. */
const staticAllowed = (cfg: Config) => new Set<string>([...BUILTIN_MODELS.map((m) => m.id), ...cfg.launch.models, ...MODEL_ALIASES]);

/** `models`: the ids this account may use (Task 46: discovered ∪ built-in ∪ config); never anything the tablet supplies. */
export function validateOptions(cfg: Config, caps: CliCaps, o: LaunchRequest['options'], models: Set<string> = staticAllowed(cfg)): ValidOptions {
  if (o.model !== undefined) {
    if (!models.has(o.model)) throw new ActionError('bad_request', `model "${o.model}" is not in this account's model list`);
    if (!caps.model) throw new ActionError('unsupported', 'this claude does not support --model');
  }
  if (o.effort !== undefined) {
    if (!cfg.launch.efforts.includes(o.effort)) throw new ActionError('bad_request', `effort "${o.effort}" is not in the allowed list`);
    if (!caps.efforts.includes(o.effort)) throw new ActionError('unsupported', 'this claude does not support that effort level');
  }
  if (o.remoteControl && !caps.remoteControl) throw new ActionError('unsupported', 'this claude does not support --remote-control');
  // Task 46: never trust the client. A known mode the host's claude lists; bypass only when the config allows it, and confirmed.
  let permissionMode: string | undefined;
  if (o.permissionMode !== undefined && !DEFAULT_MODES.includes(o.permissionMode)) {
    if (!(PERMISSION_MODES as readonly string[]).includes(o.permissionMode)) throw new ActionError('bad_request', `"${o.permissionMode.slice(0, 32)}" is not a permission mode`);
    if (!caps.permissionModes.includes(o.permissionMode)) throw new ActionError('unsupported', `this claude does not support --permission-mode ${o.permissionMode}`);
    if (o.permissionMode === BYPASS) {
      if (!cfg.launch.allowBypassPermissions) throw new ActionError('forbidden', 'bypassPermissions is off (launch.allowBypassPermissions in the config)');
      // Task 47: the owner's own default (launch.defaultMode) needs no confirm; bypass chosen by hand still does.
      if (o.confirmBypass !== true && cfg.launch.defaultMode !== BYPASS) throw new ActionError('bad_request', 'bypassPermissions needs the confirm step');
    }
    permissionMode = o.permissionMode;
  }
  // Task 42a: a name from + New follows the board nickname's rules (it becomes the session's board name).
  let sessionName: string | undefined;
  if (o.name !== undefined) {
    const c = cleanNickname(o.name);
    if (!c.ok) throw new ActionError('bad_request', c.message);
    sessionName = c.name;
  }
  // -n is passed only when this claude lists it: an unknown flag would end the session at once.
  return { model: o.model, effort: o.effort, permissionMode, remoteControl: !!o.remoteControl, openOnPc: !!o.openOnPc, name: caps.name, sessionName };
}

export function launchArgv(p: { host: HostConfig; account: AccountConfig; repoPath: string; options: ValidOptions; windowName: string }): string[] {
  const claudeArgs = [
    ...(p.options.model ? ['--model', p.options.model] : []),
    ...(p.options.effort ? ['--effort', p.options.effort] : []),
    ...(p.options.permissionMode ? ['--permission-mode', p.options.permissionMode] : []),
    ...(p.options.remoteControl ? ['--remote-control'] : []),
    // A name from + New is one `--name=…` argument, so a name that starts with `-` can never be read as another option.
    ...(p.options.name ? (p.options.sessionName !== undefined ? [`--name=${p.options.sessionName}`] : ['-n', p.windowName]) : []),
  ];
  return ['bash', '-lc', LAUNCH_SCRIPT, 'clayclaude-launch', p.host.tmuxSession, p.repoPath, p.windowName, p.account.configDir, p.host.claudeBin, ...claudeArgs];
}

/* ---------- service pieces ---------- */

export interface LaunchDeps {
  cfg: Config; exec: HostExec; caps: CapsCache; repos: RepoLister;
  /** Each account's model list (Task 46). Without it, the built-in list and the config's extras. */
  models?: ModelCache;
  attachNew: (host: HostConfig, ref: TmuxRef, title: string) => Promise<Result<{ message: string }>>;
  /** Told about each pane started, with the process tmux runs in it, so the board can show it until Claude registers (Task 40). */
  onStarted?: (l: StartedLaunch) => void;
}

/** `name`: what the starting row shows. `nickname` (Task 42a): the name asked for in + New, for the registered session's board name. */
export interface StartedLaunch { host: string; account: string; target: string; pid: number; cwd: string; name: string; nickname?: string }

/** The account's models for the launcher: grouped (newest of each family, then More), with display names. */
function modelChoices(list: ModelInfo[]) {
  const g = groupModels(list);
  return { models: g.main.map((m) => m.id), moreModels: g.more.map((m) => m.id), modelNames: Object.fromEntries([...g.main, ...g.more].map((m) => [m.id, m.name])) };
}

/** Task 47: the mode + New preselects for a host offering `modes`: launch.defaultMode, or Manual ('') when it is not offered. */
export const defaultModeFor = (cfg: Config, modes: readonly string[]): string => modes.includes(cfg.launch.defaultMode) ? cfg.launch.defaultMode : '';

export async function launchOptions(d: Pick<LaunchDeps, 'cfg' | 'caps' | 'models'>): Promise<LaunchOptions> {
  // Opening the launcher refreshes model lists a day old; it waits a few seconds at most, then offers what it has.
  const refreshed = d.models?.refresh();
  // All hosts at once: one slow or unreachable host must not hold up the others' cards.
  const accounts = await Promise.all(d.cfg.accounts.map(async (a): Promise<LaunchAccountOptions> => {
    const host = d.cfg.hosts.find((h) => h.id === a.host)!;
    const c = await d.caps.get(host);
    const base = { id: a.id, label: a.label, colour: a.colour, host: a.host };
    if ('error' in c) return { ...base, canLaunch: false, reason: c.error, models: [], efforts: [], remoteControl: false };
    await refreshed;
    const list = d.models ? d.models.list(a.id) : [...BUILTIN_MODELS, ...d.cfg.launch.models.filter((id) => !BUILTIN_MODELS.some((m) => m.id === id)).map((id) => ({ id, name: id }))];
    const modes = PERMISSION_MODES.filter((m) => c.caps.permissionModes.includes(m) && (m !== BYPASS || d.cfg.launch.allowBypassPermissions));
    return {
      ...base, canLaunch: true,
      ...(c.caps.model ? modelChoices(list) : { models: [] }),
      efforts: d.cfg.launch.efforts.filter((e) => c.caps.efforts.includes(e)),
      modes,
      defaultMode: defaultModeFor(d.cfg, modes),
      remoteControl: c.caps.remoteControl,
    };
  }));
  return { accounts };
}

export async function launch(d: LaunchDeps, req: LaunchRequest): Promise<Result<{ message: string; target?: string }>> {
  try {
    const account = d.cfg.accounts.find((a) => a.id === req.account);
    if (!account) return fail('unknown_account', `no such account "${req.account}"`);
    const host = d.cfg.hosts.find((h) => h.id === account.host)!;
    const c = await d.caps.get(host);
    if ('error' in c) return fail('failed', `${host.id}: ${c.error}`);
    // The repo must be one the host itself reported under its configured roots.
    const repos = await d.repos.list(host.id);
    const repo = repos.find((r) => r.path === req.repo) ?? (await d.repos.list(host.id, true)).find((r) => r.path === req.repo);
    if (!repo) return fail('forbidden', 'that folder is not a repository under this host\'s repoRoots');
    const options = validateOptions(d.cfg, c.caps, req.options, d.models?.allowed(account.id));
    const windowName = safeName(repo.name);
    const r = await d.exec(host, launchArgv({ host, account, repoPath: repo.path, options, windowName }), { timeoutMs: 15_000 });
    if (r.code !== 0) return fail('failed', errorLine(r.stderr) || `tmux exited with ${r.code}`);
    // The last line is `TARGET PANE_PID` (anything before it came from the remote shell's startup files).
    const out = /^(.*?)(?: (\d+))?$/.exec(r.stdout.trim().split('\n').pop() ?? '')!;
    const target = out[1], pid = Number(out[2] ?? 0);
    const ref = parseTmuxRef(target);
    const note = ref ? `Started in ${target}` : 'Started';
    if (ref && pid > 0) d.onStarted?.({ host: host.id, account: account.id, target, pid, cwd: repo.path, name: options.sessionName ?? repo.name,
      ...(options.sessionName !== undefined ? { nickname: options.sessionName } : {}) });
    if (options.openOnPc && ref) {
      const a = await d.attachNew(host, ref, windowName);
      if (!a.ok) return { ok: true, message: `${note}. Could not open it on the PC: ${a.message}`, target };
    }
    return { ok: true, message: note, target: ref ? target : undefined };
  } catch (e) {
    if (e instanceof ActionError) return fail(e.code as never, e.message);
    return fail('failed', e instanceof Error ? firstLine(e.message) : 'launch failed');
  }
}

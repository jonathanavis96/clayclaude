import { spawn } from 'node:child_process';
import type { AccountConfig, Config, HostConfig } from '../config.js';
import type { PlatformEnv } from './platform.js';
import { shJoin } from './quote.js';
import { RE, type TmuxRef } from './validate.js';
import { ActionError } from './validate.js';

export interface Cmd { bin: string; args: string[] }

export const claudeUrl = (bridgeId: string) => `https://claude.ai/code/${bridgeId}`;

function checkBridge(id: string | undefined): string {
  if (!id) throw new ActionError('no_bridge', 'this session has no remote-control link');
  if (!RE.bridgeId.test(id)) throw new ActionError('bad_request', 'malformed remote-control id');
  return id;
}

/** Open the session's /rc page in the account's Chrome profile. */
export function chromeCmd(cfg: Config, account: AccountConfig, bridgeId: string | undefined): Cmd {
  const o = account.open;
  if (o.type !== 'chrome') throw new ActionError('bad_request', 'account is not set up for chrome');
  const bin = cfg.browsers[o.browser];
  if (!bin) throw new ActionError('unsupported', `browser "${o.browser}" is not in the config (run clayclaude setup)`);
  const args: string[] = [];
  if (o.profileDirectory) args.push(`--profile-directory=${o.profileDirectory}`);
  if (o.incognito) args.push('--incognito');
  args.push(claudeUrl(checkBridge(bridgeId)));
  return { bin, args };
}

/** The OS command that opens a URL with whatever handles it. */
export function openerPrefix(cfg: Config, env: PlatformEnv): string[] {
  if (cfg.opener?.length) return cfg.opener;
  if (env.kind === 'wsl' || env.kind === 'win32') return ['rundll32.exe', 'url.dll,FileProtocolHandler'];
  if (env.kind === 'darwin') return ['open'];
  return ['xdg-open'];
}

/** Open the session in the Claude desktop app through its claude:// link (see appLink in the config). */
export function appCmd(cfg: Config, env: PlatformEnv, bridgeId: string | undefined): Cmd {
  const url = cfg.appLink.replace('{id}', checkBridge(bridgeId));
  const [bin, ...pre] = openerPrefix(cfg, env);
  return { bin, args: [...pre, url] };
}

/** The shell script run inside the terminal: select the window and pane, then attach. No `;`, which Windows Terminal treats as its own separator. */
export function attachScript(ref: TmuxRef): string {
  return `tmux select-window -t ${ref.window} 2>/dev/null && tmux select-pane -t ${ref.pane} 2>/dev/null || true && exec tmux attach -t ${shJoin([ref.session])}`;
}

/** The argv the terminal should run to attach to `ref` on `host`. */
export function attachArgv(host: HostConfig, ref: TmuxRef, env: PlatformEnv): string[] {
  const script = attachScript(ref);
  const inner = host.ssh ? `exec ${shJoin(['ssh', '-t', host.ssh, script])}` : script;
  const bash = ['bash', '-lc', inner];
  return env.kind === 'wsl' ? ['wsl.exe', ...(env.distro ? ['-d', env.distro] : []), '-e', ...bash] : bash;
}

/**
 * The title is the session's name (its registry name, Claude's AI title or the folder): keep only plain characters.
 * Windows Terminal splits its command line on ";" even inside quotes, WSL interop re-quotes arguments for Windows,
 * and a template may put {title} inside a shell string, so quotes, `$` and backslashes are dropped too.
 * Leading dashes go as well: wt.exe (and many terminals) would read a title such as "-p x" as an option.
 */
const plainTitle = (title: string) => title.replace(/[^\w .@()-]/g, ' ').replace(/^[\s-]+/, '').slice(0, 60) || 'clayclaude';

export function terminalCmd(cfg: Config, host: HostConfig, ref: TmuxRef, env: PlatformEnv, title: string): Cmd {
  const argv = attachArgv(host, ref, env);
  const shownTitle = plainTitle(title);
  if (cfg.terminal.type === 'template') {
    if (!cfg.terminal.template?.length) throw new ActionError('unsupported', 'terminal.template is empty');
    // Function replacers: a string replacement would read $' $` $& in the values as patterns.
    const [bin, ...rest] = cfg.terminal.template.flatMap((t) =>
      t === '{argv}' ? argv : [t.replace(/\{(script|title)\}/g, (_m, k: string) => (k === 'script' ? argv[argv.length - 1] : shownTitle))]);
    return { bin, args: rest };
  }
  if (env.kind !== 'wsl' && env.kind !== 'win32')
    throw new ActionError('unsupported', 'Windows Terminal needs Windows or WSL; set terminal.type: template');
  return { bin: cfg.terminal.bin, args: ['-w', '0', 'new-tab', '--title', shownTitle, '--', ...argv] };
}

export interface LaunchResult { ok: boolean; error?: string }
export type GuiLauncher = (cmd: Cmd) => Promise<LaunchResult>;

/** Start a GUI program and report an immediate failure; otherwise leave it running. */
export const launchDetached: GuiLauncher = (cmd) => new Promise((resolve) => {
  let err = '', done = false;
  const finish = (r: LaunchResult) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
  const child = spawn(cmd.bin, cmd.args, { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const timer = setTimeout(() => { child.stderr?.destroy(); child.unref(); finish({ ok: true }); }, 700);
  child.stderr?.on('data', (c) => { if (err.length < 2000) err += c; });
  child.on('error', (e) => finish({ ok: false, error: `${cmd.bin}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found' : e.message}` }));
  child.on('close', (code) => finish(code === 0 ? { ok: true } : { ok: false, error: err.trim().split('\n')[0] || `${cmd.bin} exited with ${code}` }));
});

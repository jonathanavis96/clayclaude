import { chmod, copyFile, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { HostConfig } from '../config.js';
import { errorLine, type HostExec } from '../actions/exec.js';

export const HOOK_EVENTS = ['Notification', 'Stop', 'PreCompact', 'SessionStart', 'SessionEnd'] as const;
export const HOOK_MARK = '/clayclaude/hook.py';
/**
 * The account's config directory as the hook's shell sees it, the same rule Claude Code itself follows. Never an absolute
 * path: one settings.json is often shared by several accounts (a symlink, or generated from one file), and an absolute
 * path would send every account's events into the first account's events.jsonl.
 */
export const HOOK_DIR = '${CLAUDE_CONFIG_DIR:-$HOME/.claude}';
/** The form earlier versions wrote, with the absolute config directory baked in. Rewritten to hookCommand on the next run. */
const OLD_FORM = /^python3 "\/[^"]*\/clayclaude\/hook\.py" ([A-Za-z]+) 2>\/dev\/null \|\| true$/;

export const hookSource = () => readFileSync(fileURLToPath(new URL('./clayclaude-hook.py', import.meta.url)), 'utf8');

export function hookCommand(event: string): string {
  if (!/^[A-Za-z]+$/.test(event)) throw new Error(`"${event}" is not a hook event name`);
  // Must never fail: a missing hook.py makes python3 exit 2, and exit 2 from a Stop hook blocks the session.
  return `python3 "${HOOK_DIR}${HOOK_MARK}" ${event} 2>/dev/null || true`;
}

type Settings = Record<string, any>;
const ours = (h: any) => typeof h?.command === 'string' && h.command.includes(HOOK_MARK);

/**
 * Add our hook to each event, leaving every other setting and hook untouched, and rewrite the old absolute form to the
 * account-relative one (dropping it instead when the current form is already there). Any command that runs our hook.py
 * counts as installed. Idempotent.
 */
export function planHooks(settings: Settings): { next: Settings; added: string[]; upgraded: string[] } {
  const next: Settings = structuredClone(settings);
  if (next.hooks !== undefined && (typeof next.hooks !== 'object' || next.hooks === null || Array.isArray(next.hooks)))
    throw new Error('settings.json has a "hooks" value that is not an object; refusing to change it');
  next.hooks ??= {};
  const added: string[] = [], upgraded: string[] = [];
  for (const ev of HOOK_EVENTS) {
    let groups = next.hooks[ev] ?? [];
    if (!Array.isArray(groups)) throw new Error(`settings.json hooks.${ev} is not a list; refusing to change it`);
    const has = (cmd: string) => groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => h?.command === cmd));
    let changed = false;
    const emptied = new Set<any>();
    for (const g of groups) {
      if (!Array.isArray(g?.hooks)) continue;
      const kept: any[] = [];
      for (const h of g.hooks) {
        const m = typeof h?.command === 'string' ? OLD_FORM.exec(h.command) : null;
        if (!m) { kept.push(h); continue; }
        changed = true;
        const cmd = hookCommand(m[1]);
        if (!has(cmd)) { h.command = cmd; kept.push(h); }   // first one: rewritten in place, so its position is kept
      }
      if (kept.length === 0 && g.hooks.length > 0) emptied.add(g);
      g.hooks = kept;
    }
    if (changed) {
      groups = groups.filter((g: any) => !emptied.has(g));
      upgraded.push(ev);
    }
    if (!groups.some((g: any) => Array.isArray(g?.hooks) && g.hooks.some(ours))) {
      groups.push({ hooks: [{ type: 'command', command: hookCommand(ev) }] });
      added.push(ev);
    }
    next.hooks[ev] = groups;
  }
  return { next, added, upgraded };
}

/** A small line diff for showing the user what will change. Lines only in `b` are marked +, only in `a` are marked -. */
export function lineDiff(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n');
  const dp = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--)
    dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: string[] = [];
  let i = 0, j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push(`- ${x[i++]}`);
    else out.push(`+ ${y[j++]}`);
  }
  while (i < x.length) out.push(`- ${x[i++]}`);
  while (j < y.length) out.push(`+ ${y[j++]}`);
  return out.join('\n');
}

/* ---------- file access, local or over ssh ---------- */

export interface ConfigIO {
  read(path: string): Promise<string | null>;
  /**
   * Atomic: temp file then rename, writing through a symlink. With `mode`, the file ends with exactly that mode;
   * without it, an existing file keeps its mode and a new file is 0600.
   */
  write(path: string, text: string, mode?: number): Promise<void>;
  copy(src: string, dst: string): Promise<void>;
  mkdirp(dir: string): Promise<void>;
  /** How many names the file has, and where it points if it is a symlink; null if it does not exist. */
  links?(path: string): Promise<{ symlinkTo?: string; names: number } | null>;
}

export function localIO(): ConfigIO {
  return {
    async read(p) { try { return await readFile(p, 'utf8'); } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; } },
    async write(p, text, forced) {
      // settings.json is often a symlink into a dotfiles repo: write through it, never replace the link with a file.
      const target = await realpath(p).catch(() => p);
      let mode = forced ?? 0o600;
      if (forced === undefined) try { mode = (await stat(target)).mode & 0o777; } catch { /* new file */ }
      const tmp = `${target}.tmp`;
      await writeFile(tmp, text, { mode });
      await chmod(tmp, mode);
      await rename(tmp, target);
    },
    copy: (s, d) => copyFile(s, d),
    mkdirp: async (d) => { await mkdir(d, { recursive: true }); },
    async links(p) {
      try {
        const l = await lstat(p);
        if (!l.isSymbolicLink()) return { names: l.nlink };
        return { symlinkTo: await realpath(p).catch(() => undefined), names: (await stat(p).catch(() => l)).nlink };
      } catch (e: any) { if (e.code === 'ENOENT') return null; throw e; }
    },
  };
}

const sh = async (exec: HostExec, host: HostConfig, script: string, args: string[], input?: string) => {
  const r = await exec(host, ['sh', '-c', script, '_', ...args], { input, timeoutMs: 15_000 });
  if (r.code !== 0 && r.code !== 3) throw new Error(`${host.id}: ${errorLine(r.stderr) || `exit ${r.code}`}`);
  return r;
};

export function remoteIO(host: HostConfig, exec: HostExec): ConfigIO {
  return {
    async read(p) { const r = await sh(exec, host, 'cat -- "$1" 2>/dev/null || exit 3', [p]); return r.code === 3 ? null : r.stdout; },
    async write(p, text, mode) {
      await sh(exec, host,
        't=$(readlink -f -- "$1" 2>/dev/null); [ -n "$t" ] || t="$1"; umask 077; cat > "$t.tmp" && if [ -n "$2" ]; then chmod "$2" "$t.tmp"; elif [ -f "$t" ]; then chmod "$(stat -c %a "$t" 2>/dev/null || stat -f %Lp "$t")" "$t.tmp"; fi && mv "$t.tmp" "$t"',
        [p, mode === undefined ? '' : mode.toString(8)], text);
    },
    async copy(s, d) { await sh(exec, host, 'cp -p -- "$1" "$2"', [s, d]); },
    async mkdirp(d) { await sh(exec, host, 'mkdir -p -- "$1"', [d]); },
    async links(p) {
      const r = await sh(exec, host,
        '[ -e "$1" ] || [ -L "$1" ] || exit 3; t=; if [ -L "$1" ]; then t=$(readlink -f -- "$1" 2>/dev/null || readlink -- "$1"); fi; n=$(stat -L -c %h -- "$1" 2>/dev/null || stat -L -f %l -- "$1" 2>/dev/null); printf \'%s\\n%s\\n\' "${n:-1}" "$t"',
        [p]);
      if (r.code === 3) return null;
      const [n, t] = r.stdout.split('\n');
      return { names: Number(n) || 1, ...(t ? { symlinkTo: t } : {}) };
    },
  };
}

/* ---------- preview and apply ---------- */

export interface HookPreview {
  settingsPath: string; changed: boolean; added: string[]; upgraded: string[]; diff: string; nextText: string; existed: boolean;
  /** Set when settings.json is a symlink or has other hard-linked names, so other accounts may share it. */
  shared?: string;
}

const SHARED_OK = 'Sharing is fine: the hook finds each account\'s own directory through CLAUDE_CONFIG_DIR.';

async function sharedNote(io: ConfigIO, settingsPath: string): Promise<string | undefined> {
  const l = await io.links?.(settingsPath);
  if (!l) return undefined;
  if (l.symlinkTo !== undefined) return `${settingsPath} is a symlink to ${l.symlinkTo}, so other accounts may share it; changes are written there and the link is kept. ${SHARED_OK}`;
  if (l.names > 1) return `${settingsPath} is a hard link with ${l.names} names, so other accounts may share it. ${SHARED_OK}`;
  return undefined;
}

const detectIndent = (text: string) => /\n(\t| +)"/.exec(text)?.[1] ?? '  ';

export async function previewHooks(io: ConfigIO, absConfigDir: string): Promise<HookPreview> {
  const settingsPath = `${absConfigDir}/settings.json`;
  const before = await io.read(settingsPath);
  let current: Settings = {};
  if (before !== null && before.trim() !== '') {
    try { current = JSON.parse(before); } catch { throw new Error(`${settingsPath} is not valid JSON; fix it first. Nothing was changed.`); }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) throw new Error(`${settingsPath} is not a JSON object. Nothing was changed.`);
  }
  const { next, added, upgraded } = planHooks(current);
  const changed = added.length > 0 || upgraded.length > 0;
  const nextText = JSON.stringify(next, null, before ? detectIndent(before) : 2) + '\n';
  const shownBefore = before === null ? '' : JSON.stringify(current, null, detectIndent(before)) + '\n';
  const shared = before === null ? undefined : await sharedNote(io, settingsPath);
  return { settingsPath, changed, added, upgraded, diff: changed ? lineDiff(shownBefore, nextText) : '', nextText, existed: before !== null, ...(shared ? { shared } : {}) };
}

const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14);

/**
 * Install (or restore/upgrade) the hook script in this account's own directory, then, only if the hooks are missing or in
 * the old absolute form, back up settings.json and write the new settings last.
 */
export async function applyHooks(io: ConfigIO, absConfigDir: string, now = Date.now()): Promise<{ backup?: string; added: string[]; upgraded: string[] }> {
  const p = await previewHooks(io, absConfigDir);
  const dir = `${absConfigDir}/clayclaude`;
  await io.mkdirp(dir);
  await io.write(`${dir}/hook.py`, hookSource()); // always: idempotent, and the only repair path for a missing or old copy
  if (!p.changed) return { added: [], upgraded: [] };
  let backup: string | undefined;
  if (p.existed) { backup = `${p.settingsPath}.bak-clayclaude-${stamp(now)}`; await io.copy(p.settingsPath, backup); }
  await io.write(p.settingsPath, p.nextText);
  return { backup, added: p.added, upgraded: p.upgraded };
}

export const hookDirOf = (p: string) => dirname(p);

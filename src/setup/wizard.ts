import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ZodError } from 'zod';
import { ADB_SERIAL_RE, DEFAULT_PORT, LAN_HOST_RE, PROFILE_DIR_RE, TMUX_SESSION_RE, UsageUrl, parseConfig, type HostConfig } from '../config.js';
import type { HostExec } from '../actions/exec.js';
import type { PlatformEnv } from '../actions/platform.js';
import { applyHooks, localIO, previewHooks, remoteIO, type ConfigIO } from '../hooks/install.js';
import { applyStatusLine, previewStatusLine } from '../hooks/statusline.js';
import { hotkeyTemplate, installHotkey, renderHotkeyScript, HOTKEY_RE } from '../hotkey/install.js';
import { generateToken } from '../security.js';
import { chooseAdb, configuredAdb, nativeAdbMustNotRun, probeAdb } from '../adbpick.js';
import { chromePaths, parseChromeProfiles } from './chrome.js';
import { serializeConfig, writeConfigFile, type ConfigDraft } from './configwrite.js';
import type { Prompter } from './prompter.js';
import { sshAliases } from './sshconfig.js';
import { NO_INSTALL_NOTE, PIN_SHORTCUT_QUERY, PWA_GUIDANCE, findWebApk, launcherCanPin, parseAdbDevices, runTabletPlan, tabletPlan, webApkQuery } from './tablet.js';

/** Same shape as Task 10's `ProbeFn` in `src/actions/launch.ts` (declared here so setup does not depend on the launcher). */
export type SetupProbe = (host: HostConfig, req: object) => Promise<unknown>;

export interface SetupDeps {
  prompt: Prompter;
  /** The home directory to look in. Tests pass a temp directory; nothing else is read or written. */
  home: string;
  configPath: string;
  platform: PlatformEnv;
  exec: HostExec;
  probe: SetupProbe;
  io?: ConfigIO;
  readText(path: string): Promise<string | null>;
  fileExists(path: string): boolean;
  runLocal(bin: string, argv: string[], opts?: { timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }>;
  /** Full paths of the adb binaries to try (adb on PATH; under WSL also the Windows adb.exe). None: ask, defaulting to "adb". */
  adbCandidates?: () => string[];
  /** Port of the Linux adb server (default 5037). Under WSL a Linux adb is only run while it listens in the Linux socket table. Tests inject one. */
  adbPort?: number;
  /** The Linux socket tables (default /proc/net/tcp and tcp6). Tests feed a fake one. */
  procNetTcp?: () => string;
  winUser?: () => Promise<string | undefined>;
  toWindowsPath?: (p: string) => Promise<string>;
  interfaces?: () => string[];
  now?: () => number;
}

const PALETTE = ['#e8b54a', '#4fd1c5', '#a78bfa', '#f472b6', '#60a5fa', '#a3e635'];
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const titleCase = (s: string) => s.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();

/** A config the loader rejected, described field by field (a ZodError's message is a JSON dump whose first line is "["). */
export function configErrorText(e: unknown): string {
  if (e instanceof ZodError) return e.issues.map((i) => `${i.path.join('.') || '(top level)'}: ${i.message}`).join('; ');
  return e instanceof Error ? e.message.split('\n')[0] : 'invalid';
}

/**
 * One adb server only: run `devices` with each candidate and default to the one that sees the tablet. Setup never
 * starts an adb server: under WSL a Linux adb whose server is down is not run at all.
 */
async function pickAdb(d: SetupDeps): Promise<string> {
  const configured = configuredAdb(await d.readText(d.configPath));
  const def = configured ?? 'adb';
  const cands = d.adbCandidates?.() ?? [];
  if (!cands.length) return def;
  const seen = [];
  for (const c of cands) seen.push(await probeAdb(c, async (bin, argv) => {
    const r = await d.runLocal(bin, argv, { timeoutMs: 5000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split('\n')[0] || `exit ${r.code}`);
    return r.stdout;
  }, { wsl: d.platform.kind === 'wsl', adbPort: d.adbPort, procNetTcp: d.procNetTcp }));
  for (const s of seen) d.prompt.say(`  ${s.path}: ${s.notRunning ? 'Linux adb server not running; not started (it would fight the Windows adb.exe)' : s.error ? `could not run (${s.error})` : s.serials.length ? `sees ${s.serials.join(', ')}` : 'sees no device'}`);
  const pick = chooseAdb(seen, { configured, preferWindows: d.platform.kind === 'wsl' });
  if (pick) return pick;
  d.prompt.say(`  No adb sees an authorised tablet; keeping "${def}". Check which one owns it with ${cands.map((c) => `"${c} devices"`).join(' and ')}.`
    + ' Only one adb server can hold the tablet: never mix adb and adb.exe (README: Troubleshooting).');
  return def;
}

/**
 * Offer the status line bridge (src/hooks/statusline.ts) for one account, or, when it is installed, refresh its hook.py
 * and offer to take it out again. settings.json changes only after the diff is shown and confirmed.
 */
async function statusLineStep(p: Prompter, io: ConfigIO, dir: string, id: string, notes: string[], now: () => number) {
  const cur = await previewStatusLine(io, dir, 'install');
  if (cur.handEdited) { p.say('  The status line command runs the clayclaude bridge but was edited by hand; leaving it alone.'); return; }
  const showDiff = (x: { settingsPath: string; diff: string; shared?: string }) => {
    if (x.shared) p.say(`  ${x.shared}`);
    p.say(`  Changes to ${x.settingsPath}:\n${x.diff.split('\n').map((l) => '    ' + l).join('\n')}`);
  };
  if (cur.installed) {
    await applyStatusLine(io, dir, 'install', now()); // settings.json unchanged; hook.py rewritten (repair)
    p.say(`  The status line bridge is installed. ${cur.previous === null ? 'There was no status line before it, so it shows nothing.' : `It keeps running your status line: ${cur.previous}`}`);
    if (!(await p.confirm('  Remove the status line bridge and restore your previous status line?', false))) return;
    const rm = await previewStatusLine(io, dir, 'remove');
    showDiff(rm);
    if (await p.confirm('  Apply these changes? (a backup is saved first)', false)) {
      const r = await applyStatusLine(io, dir, 'remove', now());
      p.say(`  Done.${r.backup ? ` Backup: ${r.backup}` : ''}`);
      notes.push(`status line bridge removed for ${id}`);
    }
    return;
  }
  p.say('  The status line bridge lets the board read each session\'s real context window, which Claude Code gives only to'
    + ' its status line. It takes the status line setting and runs your own status line inside it, unchanged.');
  p.say(cur.previous === null
    ? '  You have no status line now; with the bridge Claude Code shows an empty one.'
    : `  Your status line command, which keeps running: ${cur.previous}`);
  if (!(await p.confirm('  Install the status line bridge?', false))) { notes.push(`status line bridge skipped for ${id}`); return; }
  showDiff(cur);
  if (await p.confirm('  Apply these changes? (a backup is saved first)', false)) {
    const r = await applyStatusLine(io, dir, 'install', now());
    p.say(`  Done.${r.backup ? ` Backup: ${r.backup}` : ''} Run setup again to remove it; that restores your previous status line exactly.`);
    notes.push(`status line bridge installed for ${id}`);
  }
}

interface Found { host: HostConfig; dir: { path: string; name: string; email: string | null; sessionFiles: number; hasCredentials: boolean }; home: string }

/** The `port:` of an existing config file, if it has a usable one. The rest of the file need not be valid. */
function configuredPort(text: string | null): number | undefined {
  if (!text) return undefined;
  let doc: unknown;
  try { doc = parseYaml(text); } catch { return undefined; }
  const n = (doc as { port?: unknown } | null)?.port;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n < 65536 ? n : undefined;
}

export async function runSetup(d: SetupDeps): Promise<{ draft: ConfigDraft; written: string; backup?: string; notes: string[] }> {
  const p = d.prompt;
  const io = d.io ?? localIO();
  const now = d.now ?? Date.now;
  const notes: string[] = [];
  // Re-running setup keeps a port the person already chose (e.g. one outside a range Windows has reserved).
  const port = configuredPort(await d.readText(d.configPath)) ?? DEFAULT_PORT;
  const draft: ConfigDraft = { port };

  p.say('clayclaude setup. Nothing is changed until you confirm each step.\n');

  /* 1. hosts */
  const aliases = sshAliases((await d.readText(join(d.home, '.ssh', 'config'))) ?? '');
  const chosen = aliases.length ? await p.multi('Which ssh hosts also run Claude Code sessions you want on the board?', aliases.map((a) => ({ value: a, label: a })), []) : [];
  const extra = (await p.ask('Other ssh host aliases, comma separated (Enter for none):', '')).split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s));
  const hosts: HostConfig[] = [{ id: 'local', tmuxSession: 'clayclaude', repoRoots: ['~/code'], claudeBin: 'claude' }];
  /** Ask until the answer passes the config's rule for that field; after three misses, say so and use the (valid) default. */
  const askValid = async (q: string, def: string, ok: (v: string) => boolean, rule: string) => {
    for (let i = 0; i < 3; i++) {
      const v = await p.ask(q, def);
      if (ok(v)) return v;
      p.say(`  ${rule}`);
    }
    p.say(`  Using "${def}".`);
    return def;
  };
  const tmuxName = async (q: string) => {
    const v = await p.ask(q, 'clayclaude');
    if (TMUX_SESSION_RE.test(v)) return v;
    p.say('  tmux session names may use letters, digits, space, _ and -. Using "clayclaude".');
    return 'clayclaude';
  };
  hosts[0].tmuxSession = await tmuxName('tmux session name for new sessions started on this PC:');
  hosts[0].repoRoots = (await p.ask('Folders that hold your repos on this PC (comma separated):', '~/code')).split(',').map((s) => s.trim()).filter(Boolean);
  for (const alias of new Set([...chosen, ...extra])) {
    if (alias === 'local') { p.say('  "local" is the name of this PC on the board; add that ssh host under another alias.'); continue; }
    const tmuxSession = await tmuxName(`tmux session name for new sessions on ${alias}:`);
    const repoRoots = (await p.ask(`Folders that hold repos on ${alias} (comma separated):`, '~/code')).split(',').map((s) => s.trim()).filter(Boolean);
    hosts.push({ id: alias, ssh: alias, tmuxSession, repoRoots, claudeBin: 'claude' });
  }

  /* 2. discover Claude config directories */
  const found: Found[] = [];
  for (const host of hosts) {
    try {
      const r = (await d.probe(host, { mode: 'discover' })) as { ok: boolean; home: string; dirs: Found['dir'][] };
      for (const dir of r.dirs) found.push({ host, dir, home: r.home });
      p.say(`${host.id}: found ${r.dirs.length} Claude config director${r.dirs.length === 1 ? 'y' : 'ies'}.`);
    } catch (e) {
      p.say(`${host.id}: could not look (${e instanceof Error ? e.message.split('\n')[0] : 'error'}). Skipping this host.`);
    }
  }

  /* chrome profiles, loaded lazily */
  let chrome: { bin?: string; profiles: ReturnType<typeof parseChromeProfiles> } | undefined;
  const loadChrome = async () => {
    if (chrome) return chrome;
    const winUser = d.platform.kind === 'wsl' ? await d.winUser?.() : undefined;
    const paths = chromePaths({ platform: d.platform.kind, home: d.home, winUser });
    let profiles: ReturnType<typeof parseChromeProfiles> = [];
    for (const lp of paths.localState) { const t = await d.readText(lp); if (t) { profiles = parseChromeProfiles(t); break; } }
    chrome = { bin: paths.bin.find((b) => d.fileExists(b)), profiles };
    return chrome;
  };

  /* 3. accounts */
  const accounts: Record<string, unknown>[] = [];
  const browsers: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of found) {
    const who = `${f.dir.name} on ${f.host.id}${f.dir.email ? ` (${f.dir.email})` : ''}, ${f.dir.sessionFiles} session files`;
    if (!(await p.confirm(`Add ${who}?`, true))) continue;
    let id = slug(f.dir.name.replace(/^\.claude-?/, '')) || 'main';
    if (used.has(id)) id = `${slug(f.host.id)}-${id}`;
    used.add(id);
    const label = await p.ask('  Label shown on the board:', titleCase(f.dir.name.replace(/^\.claude-?/, '')) || 'Main');
    let colour = await p.ask('  Colour (hex):', PALETTE[accounts.length % PALETTE.length]);
    if (!/^#[0-9a-fA-F]{3,8}$/.test(colour)) { p.say('  That is not a hex colour; using the default.'); colour = PALETTE[accounts.length % PALETTE.length]; }
    const provider = await p.choose('  Where do usage figures come from?', [
      { value: 'oauth', label: 'Ask Anthropic directly using this account\'s login (oauth)' },
      { value: 'http', label: 'Read them from another dashboard\'s /usage URL (http)' },
      { value: 'none', label: 'Hide the usage meter (none)' }], 'oauth');
    let usage: Record<string, unknown> = { provider };
    if (provider === 'oauth') {
      const other = await p.confirm('  Is another tool (for example a usage dashboard) already refreshing this account\'s login token?', false);
      usage = { provider, refresh: !other };
      if (!other) p.say('  Only one program may refresh a token. If you add such a tool later, set usage.refresh: false here.');
    } else if (provider === 'http') {
      const url = await askValid('  /usage URL:', 'http://localhost:8790/usage', (v) => UsageUrl.safeParse(v).success, 'That is not a URL (for example http://localhost:8790/usage).');
      usage = { provider, url, key: await p.ask('  Key for this account in that response:', id) };
    }
    const openType = await p.choose('  What should "Open" do for this account\'s sessions?', [
      { value: 'chrome', label: 'Open the session page in a Chrome profile' },
      { value: 'app', label: 'Open it in the Claude desktop app' },
      { value: 'tmux', label: 'Only attach to the tmux pane in a terminal' }], d.platform.kind === 'wsl' || d.platform.kind === 'win32' ? 'chrome' : 'tmux');
    let open: Record<string, unknown> = { type: openType };
    if (openType === 'chrome') {
      const c = await loadChrome();
      if (!c.bin) { const b = await p.ask('  Path to chrome (not found automatically):', ''); if (b) browsers.chrome = b; } else browsers.chrome = c.bin;
      const profileDirectory = c.profiles.length
        ? await p.choose('  Which Chrome profile?', c.profiles.map((x) => ({ value: x.dir, label: `${x.name}${x.email ? ` <${x.email}>` : ''} (${x.dir})` })), c.profiles[0].dir)
        : await askValid('  Chrome profile directory (for example "Profile 2"):', 'Default', (v) => PROFILE_DIR_RE.test(v),
          'A profile directory is up to 64 letters, digits, spaces, _ . and -, as in "Profile 2".');
      open = { type: 'chrome', profileDirectory, incognito: await p.confirm('  Open in an incognito window?', false) };
    }
    const underHome = f.host.ssh ? f.dir.path.startsWith(f.home + '/') : f.dir.path.startsWith(d.home + '/');
    const configDir = underHome ? '~' + f.dir.path.slice((f.host.ssh ? f.home : d.home).length) : f.dir.path;
    accounts.push({ id, label, colour, host: f.host.id, configDir, usage, open });

    /* 4. hooks, per account */
    if (await p.confirm('  Install the clayclaude hooks into this account\'s settings.json? (they let the board tell "needs you" from "finished")', true)) {
      try {
        const aio = f.host.ssh ? remoteIO(f.host, d.exec) : io;
        const prev = await previewHooks(aio, f.dir.path);
        if (prev.shared) p.say(`  ${prev.shared}`);
        if (!prev.changed) {
          // settings.json already points at the hook (e.g. it is shared from a dotfiles repo, or this is an upgrade),
          // but hook.py itself may be missing or old. applyHooks rewrites only hook.py in that case.
          await applyHooks(aio, f.dir.path, now());
          p.say('  Hooks are already installed in settings.json; the hook script was refreshed.');
          notes.push(`hook script refreshed for ${id}`);
        }
        else {
          p.say(`  Changes to ${prev.settingsPath}:\n${prev.diff.split('\n').map((l) => '    ' + l).join('\n')}`);
          if (await p.confirm('  Apply these changes? (a backup is saved first)', false)) {
            const r = await applyHooks(aio, f.dir.path, now());
            p.say(`  Done.${r.backup ? ` Backup: ${r.backup}` : ''}`);
            notes.push(`hooks installed for ${id}`);
          } else notes.push(`hooks skipped for ${id}`);
        }
      } catch (e) { p.say(`  Could not install hooks: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`); }
    }

    /* 4b. the status line bridge, per account: only with consent, shown first */
    try {
      const aio = f.host.ssh ? remoteIO(f.host, d.exec) : io;
      await statusLineStep(p, aio, f.dir.path, id, notes, now);
    } catch (e) { p.say(`  Could not change the status line: ${e instanceof Error ? e.message.split('\n')[0] : 'error'}`); }
  }
  if (!accounts.length) { p.say('\nNo accounts were added, so no config was written. Run setup again when you are ready.'); return { draft, written: '', notes }; }
  draft.hosts = hosts.map((h) => ({ id: h.id, ...(h.ssh ? { ssh: h.ssh } : {}), tmuxSession: h.tmuxSession, repoRoots: h.repoRoots }));
  draft.accounts = accounts;
  if (Object.keys(browsers).length) draft.browsers = browsers;

  /* 5. tablet */
  const tablet: Record<string, unknown> = { adb: 'adb', scrcpy: 'scrcpy' };
  if (await p.confirm('\nSet up the Android tablet over USB now?', true)) {
    const adb = await p.ask('  Path to adb:', await pickAdb(d));
    tablet.adb = adb;
    // `devices` starts a server when none is up; under WSL a Linux one would fight the Windows adb.exe, so skip it.
    const nativeDown = await nativeAdbMustNotRun(adb, { wsl: d.platform.kind === 'wsl', adbPort: d.adbPort, procNetTcp: d.procNetTcp });
    const dev = nativeDown ? { code: 1, stdout: '', stderr: '' } : await d.runLocal(adb, ['devices']).catch(() => ({ code: 127, stdout: '', stderr: 'adb not found' }));
    const authorised = parseAdbDevices(dev.stdout).filter((x) => x.state === 'device');
    const ready = authorised.filter((x) => ADB_SERIAL_RE.test(x.serial));
    for (const x of authorised) if (!ready.includes(x)) p.say(`  Skipping ${x.serial}: clayclaude only accepts serials of up to 64 letters, digits, _ : . and -.`);
    if (nativeDown) p.say(`  ${adb} is a Linux adb and its server is not running; setup does not start one under WSL (it would fight the Windows adb.exe over the tablet). Use the Windows adb.exe, then run setup again. (Settings are saved anyway.)`);
    else if (!ready.length) p.say('  No authorised tablet found. Plug it in, enable USB debugging, accept the prompt on the tablet, then run setup again. (Settings are saved anyway.)');
    else {
      const serial = ready.length === 1 ? ready[0].serial : await p.choose('  Which device?', ready.map((x) => ({ value: x.serial, label: x.serial })), ready[0].serial);
      tablet.serial = serial;
      const steps = tabletPlan({ adb, serial, port, screenTimeoutMs: 1_800_000, chromePackage: 'com.android.chrome' });
      p.say('  This will run:\n' + steps.map((s) => `    ${s.title}: adb ${s.argv.join(' ')}`).join('\n'));
      if (await p.confirm('  Run these now?', true)) {
        for (const r of await runTabletPlan(adb, steps, d.runLocal)) p.say(`    ${r.ok ? 'ok  ' : 'FAIL'} ${r.title}${r.error ? ': ' + r.error : ''}`);
        // The install itself is a tap in Chrome's menu that adb cannot find reliably, so the person does it; we only check.
        const pin = await d.runLocal(adb, ['-s', serial, ...PIN_SHORTCUT_QUERY]).catch(() => ({ code: 1, stdout: '', stderr: '' }));
        if (!launcherCanPin(pin.stdout)) p.say('\n' + NO_INSTALL_NOTE);
        else {
          p.say('\n' + PWA_GUIDANCE(port));
          if (await p.confirm('  Check now whether the board is installed?', true)) {
            const q = await d.runLocal(adb, ['-s', serial, ...webApkQuery(port)]).catch(() => ({ code: 1, stdout: '', stderr: '' }));
            const app = findWebApk(q.stdout);
            p.say(app ? `  Installed (${app}). It opens full screen whenever the tablet is plugged in.`
              : '  Not installed. That is fine: the board opens in Chrome and goes full screen by itself whenever the tablet is plugged in.');
          }
        }
      }
    }
  }
  draft.tablet = tablet;

  /* 6. hotkey (Windows only) */
  if ((d.platform.kind === 'wsl' || d.platform.kind === 'win32') && await p.confirm('\nInstall the AutoHotkey hotkey that hands your keyboard and mouse to the tablet?', false)) {
    const hotkey = await p.ask('  Hotkey (AutoHotkey syntax, # is Win, + is Shift):', '#+t');
    if (!HOTKEY_RE.test(hotkey)) p.say('  That is not a valid hotkey; skipping the hotkey.');
    else {
      const winUser = d.platform.kind === 'wsl' ? await d.winUser?.() : undefined;
      const base = d.platform.kind === 'wsl' ? `/mnt/c/Users/${winUser ?? 'USER'}` : d.home;
      const sep = d.platform.kind === 'wsl' ? '/' : '\\';
      const scrcpy = await p.ask('  Path to scrcpy:', 'scrcpy');
      const target = await p.ask('  Where should the script be written?', `${base}${sep}clayclaude${sep}clayclaude-hotkey.ahk`);
      const winPath = d.toWindowsPath ?? (async (x: string) => x);
      const text = renderHotkeyScript(hotkeyTemplate(), {
        adb: await winPath(String(tablet.adb)), scrcpy: await winPath(scrcpy), serial: tablet.serial as string | undefined,
        url: `http://localhost:${port}/`, chromePackage: 'com.android.chrome', hotkey,
      });
      const startup = await p.confirm('  Also start it when you sign in to Windows?', false);
      const startupPath = startup ? `${base}${sep}AppData${sep}Roaming${sep}Microsoft${sep}Windows${sep}Start Menu${sep}Programs${sep}Startup${sep}clayclaude-hotkey.ahk` : undefined;
      await installHotkey(io, target, text, startupPath);
      p.say(`  Wrote ${target}. Double-click it to start it now.`);
      draft.hotkey = hotkey; draft.hotkeyScript = target; (draft.tablet as Record<string, unknown>).scrcpy = scrcpy;
    }
  }

  /* 7. LAN */
  let tokenShown: string | undefined;
  if (await p.confirm('\nAllow other devices on your network to open the board? (off by default; needs a token)', false)) {
    const ips = d.interfaces?.() ?? [];
    const picked = ips.length ? await p.multi('  Which of this PC\'s addresses will devices use?', ips.map((x) => ({ value: x, label: x })), [ips[0]]) : [];
    const more = (await p.ask('  Other host names devices will use (comma separated, Enter for none):', '')).split(',').map((s) => s.trim()).filter((s) => LAN_HOST_RE.test(s));
    const lanHosts = [...picked, ...more];
    if (!lanHosts.length) p.say('  LAN access needs at least one address. Leaving it off.');
    else { tokenShown = generateToken(); draft.lan = { enabled: true, token: tokenShown, hosts: lanHosts }; }
  }

  /* 8. write: only a config the loader accepts */
  const text = serializeConfig(draft);
  try { parseConfig(text, d.home); } catch (e) {
    p.say(`\nThe config would not load (${configErrorText(e)}). Nothing written; please report this.`);
    return { draft, written: '', notes };
  }
  if (!(await p.confirm(`\nWrite the config to ${d.configPath}?`, true))) { p.say('Nothing written.'); return { draft, written: '', notes }; }
  const { backup } = await writeConfigFile(io, d.configPath, text, now());
  p.say(`Wrote ${d.configPath}${backup ? ` (previous file kept as ${backup})` : ''}.`);
  if (tokenShown) p.say(`\nLAN access token (shown once; it is also in the config file):\n  ${tokenShown}\nOpen http://<address>:${port}/ on the device and enter it when asked.`);
  p.say('\nNext: run "clayclaude serve".');
  return { draft, written: d.configPath, backup, notes };
}

/**
 * One adb server only. Under WSL2 the tablet belongs to whichever adb server grabbed it, usually the Windows one
 * (adb.exe); a Linux `adb` run inside WSL starts its own server on WSL's port 5037 that sees no device. `setup` picks
 * the adb that sees the tablet; the daemon only ever runs its configured adb and warns when the other one owns it.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parse } from 'yaml';

export const WSL_INTEROP = '/proc/sys/fs/binfmt_misc/WSLInterop';
const WIN_USERS = '/mnt/c/Users';
const SDK_ADB = ['AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'];
export const ADB_PORT = 5037;

export const isWsl = (env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync) =>
  exists(WSL_INTEROP) || !!env.WSL_DISTRO_NAME;
export const isWindowsAdb = (p: string) => /\.exe$/i.test(p);

function onPath(name: string, pathVar: string | undefined, exists: (p: string) => boolean): string[] {
  return (pathVar ?? '').split(':').filter(Boolean).map((d) => join(d, name)).filter((p) => exists(p));
}

/** `adb` on PATH, and under WSL the Windows SDK adb.exe of each Windows user and `adb.exe` on PATH. Full paths, no duplicates. */
export function adbCandidates(o: { wsl: boolean; pathVar?: string; exists?: (p: string) => boolean; listDir?: (p: string) => string[]; usersRoot?: string }): string[] {
  const exists = o.exists ?? existsSync;
  const out = onPath('adb', o.pathVar, exists).slice(0, 1);
  if (o.wsl) {
    const root = o.usersRoot ?? WIN_USERS;
    let users: string[] = [];
    try { users = (o.listDir ?? readdirSync)(root); } catch { /* no Windows drive */ }
    for (const u of users) { const p = join(root, u, ...SDK_ADB); if (exists(p)) out.push(p); }
    out.push(...onPath('adb.exe', o.pathVar, exists).slice(0, 1));
  }
  return [...new Set(out)];
}

/** Serials in `device` state (authorised) in `adb devices` output. */
export const deviceSerials = (out: string) => [...out.matchAll(/^(\S+)\tdevice\s*$/gm)].map((m) => m[1]);

/** notRunning: a Linux adb under WSL whose server is down, so it was not run at all. */
export interface AdbSeen { path: string; serials: string[]; error?: string; notRunning?: boolean }

const readOr = (p: string) => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };
/** The Linux socket tables (/proc/net/tcp and tcp6). Reading them starts nothing. */
export const readProcNetTcp = () => readOr('/proc/net/tcp') + '\n' + readOr('/proc/net/tcp6');

/**
 * A Linux (non-.exe) adb under WSL whose server is not listening in the Linux socket table must not be run: any adb
 * command, `devices` included, starts a Linux server on 5037 that fights the Windows adb.exe over the tablet. Not a
 * connect to 127.0.0.1:5037: under WSL mirrored networking that port can be the Windows adb.exe server.
 * o.adbPort (default 5037) and o.procNetTcp (default the real tables) are for tests.
 */
export const nativeAdbMustNotRun = async (adb: string, o: { wsl: boolean; adbPort?: number; procNetTcp?: () => string }) =>
  o.wsl && !isWindowsAdb(adb) && !nativeAdbListening((o.procNetTcp ?? readProcNetTcp)(), o.adbPort ?? ADB_PORT);

/**
 * Runs `devices` (only that) with one adb. Under WSL (o.wsl) a Linux adb is run only while its server is already
 * listening (nativeAdbMustNotRun), else reported notRunning without being run; a Windows adb.exe is always asked.
 */
export async function probeAdb(path: string, run: (bin: string, argv: string[]) => Promise<string>, o: { wsl?: boolean; adbPort?: number; procNetTcp?: () => string } = {}): Promise<AdbSeen> {
  if (await nativeAdbMustNotRun(path, { ...o, wsl: !!o.wsl })) return { path, serials: [], notRunning: true };
  try { return { path, serials: deviceSerials(await run(path, ['devices'])) }; }
  catch (e) { return { path, serials: [], error: e instanceof Error ? e.message.split('\n')[0] : String(e) }; }
}

const sameAdb = (configured: string, path: string) => configured === path || (!configured.includes('/') && basename(path) === configured);

/** The adb that sees a device. Two do: the configured one, else (under WSL) the Windows one, else the first. None: undefined. */
export function chooseAdb(seen: AdbSeen[], o: { configured?: string; preferWindows: boolean }): string | undefined {
  const ok = seen.filter((s) => s.serials.length);
  if (ok.length <= 1) return ok[0]?.path;
  return (o.configured ? ok.find((s) => sameAdb(o.configured!, s.path)) : undefined)?.path
    ?? (o.preferWindows ? ok.find((s) => isWindowsAdb(s.path)) : undefined)?.path
    ?? ok[0].path;
}

/** tablet.adb of an existing config file, if it has one. */
export function configuredAdb(text: string | null): string | undefined {
  if (!text) return undefined;
  try { const v = (parse(text) as { tablet?: { adb?: unknown } } | null)?.tablet?.adb; return typeof v === 'string' && v ? v : undefined; }
  catch { return undefined; }
}

/** The candidate of the other kind (Windows adb.exe vs Linux adb) from the configured one, if any. */
export function otherAdb(configured: string, candidates: string[]): string | undefined {
  return candidates.find((c) => !sameAdb(configured, c) && isWindowsAdb(c) !== isWindowsAdb(configured));
}

/** A Linux socket is listening on <port> (5037 by default) in /proc/net/tcp or tcp6 text. */
export const nativeAdbListening = (procNetTcp: string, port: number = ADB_PORT) => {
  const hex = `:${port.toString(16).toUpperCase().padStart(4, '0')}`;
  return procNetTcp.split('\n').some((l) => { const t = l.trim().split(/\s+/); return t[1]?.toUpperCase().endsWith(hex) && t[3] === '0A'; });
};

/** Under WSL, one warning when the other kind of adb server is running alongside the configured one. */
export function adbClashWarning(o: { wsl: boolean; configured: string; nativeListening: boolean; windowsRunning: boolean }): string | undefined {
  if (!o.wsl) return undefined;
  if (isWindowsAdb(o.configured) && o.nativeListening)
    return `clayclaude: warning: a Linux adb server is listening on port 5037 in WSL while tablet.adb is the Windows adb.exe (${o.configured}). Two adb servers fight over the tablet; use only one: stop the Linux one with "adb kill-server" and never run the Linux adb.`;
  if (!isWindowsAdb(o.configured) && o.windowsRunning)
    return `clayclaude: warning: a Windows adb server (adb.exe) is running while tablet.adb is the Linux adb (${o.configured}). Two adb servers fight over the tablet; use only one: set tablet.adb to adb.exe, or stop the Windows one with "adb.exe kill-server".`;
  return undefined;
}

const execOut = (bin: string, argv: string[]) => new Promise<string>((res, rej) => execFile(bin, argv, { timeout: 5000 }, (e, out) => (e ? rej(e) : res(String(out)))));
const linuxServerUp = () => nativeAdbListening(readProcNetTcp());
const windowsServerUp = async () => {
  const tl = existsSync('/mnt/c/Windows/System32/tasklist.exe') ? '/mnt/c/Windows/System32/tasklist.exe' : 'tasklist.exe';
  try { return /^adb\.exe\s/im.test(await execOut(tl, ['/FI', 'IMAGENAME eq adb.exe', '/NH'])); } catch { return false; }
};

/** This machine's candidates. CLAYCLAUDE_ADB_CANDIDATES (colon separated; empty for none) replaces the search: tests set it empty. */
export function systemAdbCandidates(wsl: boolean, env: NodeJS.ProcessEnv = process.env): string[] {
  const list = env.CLAYCLAUDE_ADB_CANDIDATES;
  return list !== undefined ? list.split(':').filter(Boolean) : adbCandidates({ wsl, pathVar: env.PATH });
}

/**
 * The daemon's checks for the real system: the other adb (whose `devices` is only ever run while its server is
 * already up, since `devices` would start one) and the startup clash warning.
 */
export function daemonAdb(configured: string) {
  const wsl = isWsl();
  const bin = otherAdb(configured, systemAdbCandidates(wsl));
  const other = bin ? { bin, serverUp: async () => (isWindowsAdb(bin) ? windowsServerUp() : linuxServerUp()), run: (argv: string[]) => execOut(bin, argv) } : undefined;
  const clash = async () => (wsl ? adbClashWarning({ wsl, configured, nativeListening: isWindowsAdb(configured) && linuxServerUp(), windowsRunning: !isWindowsAdb(configured) && await windowsServerUp() }) : undefined);
  return { other, clash };
}

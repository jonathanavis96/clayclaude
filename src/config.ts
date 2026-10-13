import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { parse } from 'yaml';
import { z } from 'zod';

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 90s, 45m, 3h)`);
  return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as 's' | 'm' | 'h'];
}

/** Field rules setup checks answers against before they reach the config (src/setup/wizard.ts). */
export const TMUX_SESSION_RE = /^[A-Za-z0-9_][A-Za-z0-9_ -]{0,63}$/;
export const PROFILE_DIR_RE = /^[A-Za-z0-9_ .-]{1,64}$/;
export const ADB_SERIAL_RE = /^[\w:.-]{1,64}$/;
export const LAN_HOST_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
/** No user name or password in it: fetch() refuses such a URL and quotes it, password included, in its error. */
export const UsageUrl = z.string().url().refine((u) => { try { const x = new URL(u); return !x.username && !x.password; } catch { return false; } },
  { message: 'the usage URL must not hold a user name or password (put a key in the query string or use a local proxy)' });

/** An environment variable name: it is looked up on the account's host, never expanded by a shell. */
export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/**
 * A file on the account's host: absolute, or `~/...` for that host's home (never `~user`). It reaches the host as
 * JSON data inside the probe request, never through a shell, so any other character is taken literally.
 */
const HostPath = z.string().max(4096).regex(/^(~\/|\/)[^\x00-\x1f\x7f]*$/, 'use an absolute path or ~/... (no control characters)');

const Usage = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('oauth'), refresh: z.boolean().default(true) }),
  z.object({ provider: z.literal('http'), url: UsageUrl, key: z.string() }),
  /** A `claude setup-token` token in `tokenEnv` (the host's environment first, else that one line of `envFile`). */
  z.object({ provider: z.literal('token'), tokenEnv: z.string().regex(ENV_NAME_RE, 'tokenEnv must be a variable name ([A-Za-z_][A-Za-z0-9_]*)'),
    envFile: HostPath.optional(), model: z.string().regex(/^[A-Za-z0-9][\w.-]{0,63}$/).optional() }),
  /** The newest reading in a usage meter's JSON-lines log. */
  z.object({ provider: z.literal('meter-log'), log: HostPath }),
  z.object({ provider: z.literal('none') }),
]);

const Host = z.object({
  id: z.string().min(1),
  /** An ssh config alias or user@host. Never starts with "-", so it cannot be read as an ssh option. */
  ssh: z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.@-]{0,252}$/, 'ssh must be a host alias (letters, digits, . _ @ -), not an option').optional(),
  claudeBin: z.string().regex(/^[A-Za-z0-9_.\/~-]{1,200}$/).default('claude'),
  /** Same rule as a registry tmux ref's session part (src/actions/validate.ts), so a launched session can be answered and attached. */
  tmuxSession: z.string().regex(TMUX_SESSION_RE, 'tmuxSession may use letters, digits, space, _ and -').default('clayclaude'),
  repoRoots: z.array(z.string()).default(['~/code']),
});

const Open = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('chrome'),
    browser: z.string().regex(/^[\w-]{1,32}$/).default('chrome'),
    profileDirectory: z.string().regex(PROFILE_DIR_RE).optional(),
    incognito: z.boolean().default(false),
  }),
  z.object({ type: z.literal('app') }),
  z.object({ type: z.literal('tmux') }),
]);

const Account = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  colour: z.string().regex(/^#[0-9a-fA-F]{3,8}$/),
  host: z.string(),
  configDir: z.string(),
  usage: Usage.default({ provider: 'oauth', refresh: true }),
  open: Open.default({ type: 'tmux' }),
});

/** The daemon's default port. Not 7420: Windows/Hyper-V reserves 7125-7624 after some reboots, which breaks adb reverse under WSL. */
export const DEFAULT_PORT = 8420;

/** The whole config file. Exported so a test can check example.config.yaml documents every key. */
export const ConfigSchema = z.object({
  port: z.number().int().default(DEFAULT_PORT),
  pollMs: z.number().int().min(500).default(2000),
  cacheTtlMinutes: z.number().positive().default(60),
  stoppedRetention: z.string().default('3h'),
  contextWindows: z.record(z.number().int().positive()).default({}),
  hosts: z.array(Host).min(1),
  accounts: z.array(Account).min(1),
  tablet: z.object({
    adb: z.string().default('adb'),
    scrcpy: z.string().default('scrcpy'),
    serial: z.string().regex(ADB_SERIAL_RE).optional(),
    chromePackage: z.string().regex(/^[\w.]{1,100}$/).default('com.android.chrome'),
    kiosk: z.boolean().default(true),
  }).default({}),
  hotkey: z.string().regex(/^[#!^+<>*~$]*([A-Za-z0-9]|F\d{1,2})$/).default('#+t'),
  hotkeyScript: z.string().optional(),
  browsers: z.record(z.string()).default({}),
  terminal: z.object({
    type: z.enum(['wt', 'template']).default('wt'),
    bin: z.string().default('wt.exe'),
    template: z.array(z.string()).optional(),
  }).default({}),
  opener: z.array(z.string()).optional(),
  appLink: z.string().includes('{id}').default('claude://code/{id}'),
  launch: z.object({
    /** Task 46: extra model ids (or the aliases opus, sonnet, haiku, fable) merged into each account's discovered list. */
    models: z.array(z.string().regex(/^[\w.\[\]-]{1,64}$/)).default([]),
    efforts: z.array(z.string().regex(/^[a-z]{2,16}$/)).default(['low', 'medium', 'high', 'xhigh', 'max']),
    /** Task 46: offer the bypassPermissions mode (no permission prompts at all). Dangerous; off unless set. */
    allowBypassPermissions: z.boolean().default(false),
    /** Task 47: the mode + New preselects ('manual' passes no flag). A host whose claude lacks it gets Manual. */
    defaultMode: z.enum(['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions']).default('auto'),
  })
    .default({})
    .refine((l) => l.defaultMode !== 'bypassPermissions' || l.allowBypassPermissions,
      { message: 'launch.defaultMode: bypassPermissions needs launch.allowBypassPermissions: true', path: ['defaultMode'] }),
  lan: z.object({
    enabled: z.boolean().default(false),
    token: z.string().min(24).optional(),
    /** Host names or addresses LAN clients use to reach this PC. Exact match, never a wildcard. */
    hosts: z.array(z.string().regex(LAN_HOST_RE)).default([]),
  })
    .default({})
    .refine((l) => !l.enabled || !!l.token, { message: 'lan.enabled needs lan.token (run clayclaude setup)' })
    .refine((l) => !l.enabled || l.hosts.length > 0, { message: 'lan.enabled needs lan.hosts (the address the tablet or other devices use)' }),
  ui: z.object({
    quickReplies: z.array(z.string().min(1).max(200)).max(12).default(['yes', 'no', 'continue']),
    confirmBeforeSend: z.boolean().default(false),
  }).default({}),
});

export type HostConfig = z.infer<typeof Host>;
export type AccountConfig = z.infer<typeof Account>;
export type Config = Omit<z.infer<typeof ConfigSchema>, 'stoppedRetention'> & {
  stoppedRetentionMs: number;
  contextWindows: Record<string, number> & { default: number };
};

export function parseConfig(text: string, home = homedir()): Config {
  const raw = ConfigSchema.parse(parse(text));
  const hostIds = new Set(raw.hosts.map((h) => h.id));
  for (const a of raw.accounts) {
    if (!hostIds.has(a.host)) throw new Error(`account "${a.id}" uses unknown host "${a.host}"`);
    const host = raw.hosts.find((h) => h.id === a.host)!;
    if (!host.ssh && a.configDir.startsWith('~/')) a.configDir = home + a.configDir.slice(1);
  }
  const { stoppedRetention, ...rest } = raw;
  return {
    ...rest,
    stoppedRetentionMs: parseDuration(stoppedRetention),
    contextWindows: { default: 200000, ...raw.contextWindows },
  };
}

export function loadConfig(path: string): Config {
  return parseConfig(readFileSync(path, 'utf8'));
}

/**
 * A warning when the config holds a LAN token and other users on this machine can read the file (setup writes it
 * 0600, but a hand-edited or copied file may not be). Null when there is nothing to say. Never includes the token.
 */
export function tokenFileWarning(path: string, cfg: Config): string | null {
  if (!cfg.lan.token || process.platform === 'win32') return null;
  let mode: number;
  try { mode = statSync(path).mode & 0o777; } catch { return null; }
  if (!(mode & 0o077)) return null;
  return `${path} holds the LAN token but is readable by other users (mode ${mode.toString(8).padStart(3, '0')}); run: chmod 600 ${path}`;
}

#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { loadConfig, tokenFileWarning, type Config } from './config.js';
import { Collector } from './collector.js';
import { DismissedStore } from './dismissed.js';
import { NicknameStore, adoptLaunchName } from './nicknames.js';
import { UsagePoller } from './usage.js';
import { startServer } from './server.js';
import { AdbReverse } from './adb.js';
import { daemonAdb } from './adbpick.js';
import { KioskLauncher, createKioskRoute, kioskWants } from './kiosk.js';
import { TabletSleep, createScreenRoute } from './tablet-sleep.js';
import { dispatch, USAGE } from './commands/index.js';
import { createClayRoutes } from './clay/routes.js';
import { createActionService } from './actions/service.js';
import { PendingLaunches } from './actions/pending.js';
import { makeExec } from './actions/exec.js';
import { createActionRoutes } from './actions/routes.js';
import { runProbe } from './probe/run.js';
import { killChildren } from './children.js';
import { unsupportedPlatformWarning } from './actions/platform.js';
import { buildReport } from './build-info.js';

const [cmd, ...rest] = process.argv.slice(2);
/** Startup errors are the user's to fix (a config typo, a port in use): one plain line, not a stack trace. */
const fail = (msg: string): never => { console.error(`clayclaude: ${msg}`); process.exit(1); };

if (await dispatch(cmd, rest)) process.exit(process.exitCode ?? 0);
if (cmd !== 'serve') {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
const SERVE_USAGE = 'usage: clayclaude serve [--config <path>]';

let configPath = join(homedir(), '.config/clayclaude/config.yaml');
for (let i = 0; i < rest.length; i++) {
  if (rest[i] !== '--config') fail(`unknown option "${rest[i]}"\n${SERVE_USAGE}`);
  const v = rest[++i];
  if (!v || v.startsWith('-')) fail(`--config needs a path\n${SERVE_USAGE}`);
  configPath = v;
}

function readConfig(path: string): Config {
  try { return loadConfig(path); }
  catch (e: any) {
    if (e?.code === 'ENOENT') return fail(`no config file at ${path} (copy example.config.yaml there, or pass --config <path>)`);
    if (e instanceof ZodError) return fail(`invalid config ${path}:\n` + e.issues.map((i) => `  ${i.path.join('.') || '(top level)'}: ${i.message}`).join('\n'));
    return fail(`cannot read config ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const cfg = readConfig(configPath);
const modeWarning = tokenFileWarning(configPath, cfg);
if (modeWarning) console.warn(`clayclaude: ${modeWarning}`);
const platformWarning = unsupportedPlatformWarning();
if (platformWarning) console.warn(platformWarning);
const usage = new UsagePoller(cfg);
// Sessions cleared from the board (spec §5.1) stay hidden across restarts: state.json beside the config (0600).
const dismissed = new DismissedStore(join(dirname(configPath), 'state.json'));
// Board nicknames (Task 41) share that file, under their own key.
const names = new NicknameStore(join(dirname(configPath), 'state.json'));
// A cleared session seen live again is un-cleared, so when it stops it shows as a normal stopped row (T39).
// Panes started with + New until Claude registers them, so a folder-trust question can be answered from the tablet (Task 40).
// A name given in + New becomes the registered session's board name, unless Claude took it as its own (Task 42a).
const pending = new PendingLaunches({ cfg, exec: makeExec(), onRegistered: (l, s) => void adoptLaunchName(names, l, s) });
const collector = new Collector(cfg, { exhausted: (id) => usage.isExhausted(id), hidden: (k) => dismissed.has(k), pending,
  resumed: (k) => { dismissed.remove([k]).catch((e) => console.warn(`clayclaude: could not save state.json: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`)); } });
const webRoot = fileURLToPath(new URL('../web/dist/', import.meta.url));
if (!existsSync(join(webRoot, 'index.html'))) console.warn(`clayclaude: no board build in ${webRoot} (run npm run build); the board will answer 404`);
const startFailed = (e: any) => fail(e?.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use (is clayclaude already running?)`
  : e?.code === 'EACCES' ? `no permission to listen on port ${cfg.port}`
  : `cannot start the server on port ${cfg.port}: ${e instanceof Error ? e.message : String(e)}`);
const actions = createActionService({
  cfg, sessions: () => collector.sessions(), probe: (h, r) => runProbe(h, r, { timeoutMs: 15_000 }),
  clear: { store: dismissed, files: (k) => collector.registryFiles(k), changed: () => collector.refilter() }, names,
  pending: { store: pending, changed: () => collector.refilter() },
  statePath: join(dirname(configPath), 'state.json'),   // each account's model list for + New (Task 46)
});
const clayRoutes = createClayRoutes({ webRoot });   // spec §7.3 "Baked by PC": /clay/status and /clay/sheet
let kiosk: KioskLauncher | undefined;   // set once the server knows its port
// The tablet dims, then sleeps, with no prompt typed for a while, and wakes at the next one (tablet-sleep.ts).
let tablet: string | undefined;
const { dimAfterMinutes, dimPercent, sleepAfterMinutes } = cfg.tablet;
const sleeper = new TabletSleep({ adbBin: cfg.tablet.adb, serial: () => tablet, sessions: () => collector.sessions(),
  defaults: { dimAfterMinutes, dimPercent, sleepAfterMinutes }, statePath: join(dirname(configPath), 'state.json') });
const handlers = [createKioskRoute(() => kiosk), createScreenRoute(() => sleeper), createActionRoutes(actions, { mode: 'live', publicConfig: () => actions.publicConfig() }), clayRoutes.handler];
const srv = await startServer({ cfg, collector, usage, webRoot, handlers, names }).catch(startFailed);
kiosk = cfg.tablet.kiosk ? new KioskLauncher({ adbBin: cfg.tablet.adb, port: srv.port, chromePackage: cfg.tablet.chromePackage }) : undefined;
const adbCheck = daemonAdb(cfg.tablet.adb);   // one adb server only: the daemon runs its configured adb and never another
const adb = new AdbReverse(cfg.tablet.adb, srv.port, {
  other: adbCheck.other,
  onConnect: (serial) => {
    if (!kioskWants(cfg.tablet.serial, serial)) return;
    tablet = serial;
    // The kiosk launch wakes the screen, which counts as activity; without it, any step due is sent now.
    if (kiosk) { void sleeper.woke(); void kiosk.launch(serial); } else void sleeper.tick();
  },
});
usage.start(); collector.start(); adb.start(); sleeper.start();
void adbCheck.clash().then((w) => { if (w) console.warn(w); });
console.log(`clayclaude on http://127.0.0.1:${srv.port}`);
const build = buildReport(webRoot, fileURLToPath(new URL('../', import.meta.url)));
console.log(build.line);
if (build.warning) console.warn(`clayclaude: warning: ${build.warning}`);
if (cfg.lan.enabled) console.log(`LAN access on for: ${cfg.lan.hosts.join(', ')} (token required)`);
// killChildren: an ssh still waiting on a hung host would otherwise outlive the daemon.
const shutdown = async () => { await sleeper.stop(); adb.stop(); collector.stop(); usage.stop(); killChildren(); await clayRoutes.close(); await srv.close(); process.exit(0); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); process.on('SIGHUP', shutdown); // HUP: the terminal or tmux pane it ran in closed

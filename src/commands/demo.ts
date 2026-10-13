import { fileURLToPath } from 'node:url';
import { createDemo, type ScenarioName } from '../demo/index.js';
import { createActionRoutes } from '../actions/routes.js';
import { AdbReverse } from '../adb.js';
import { KioskLauncher, createKioskRoute, kioskWants } from '../kiosk.js';
import { startServer } from '../server.js';
import { createClayRoutes } from '../clay/routes.js';
import { DEFAULT_PORT } from '../config.js';
import { listenError, userError } from './fail.js';
import { buildReport } from '../build-info.js';

export interface DemoArgs { port: number; scenario: ScenarioName; speed: number; adb: boolean; kiosk: boolean; sessions?: number }

/**
 * The demo's default port: one above the daemon's default (8420), so `clayclaude demo` next to a running daemon just
 * works. A fixed port (not "any free one") keeps `--adb` and the tablet URL predictable; if 8421 is taken too, the
 * demo stops with a plain "port 8421 is already in use" and the --port hint.
 */
export const DEMO_PORT = DEFAULT_PORT + 1;

export const DEMO_USAGE = `usage: clayclaude demo [--port N (default ${DEMO_PORT})] [--scenario board|gallery] [--speed N] [--sessions N] [--adb] [--kiosk]`;

/** Throws on anything it does not know: a typo such as `--prot` must not quietly fall back to the default port. */
export function parseDemoArgs(args: string[]): DemoArgs {
  const out: DemoArgs = { port: DEMO_PORT, scenario: 'board', speed: 1, adb: false, kiosk: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--adb') { out.adb = true; continue; }
    if (a === '--kiosk') { out.kiosk = true; out.adb = true; continue; }   // opens the board full screen on the tablet; implies --adb
    if (a !== '--port' && a !== '--speed' && a !== '--scenario' && a !== '--sessions') throw new Error(`unknown option "${a}"`);
    const v = args[++i];
    if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
    if (a === '--port') out.port = Number(v);
    else if (a === '--speed') out.speed = Number(v);
    else if (a === '--sessions') out.sessions = Number(v);
    else out.scenario = v as ScenarioName;
  }
  if (!Number.isInteger(out.port) || out.port < 0 || out.port > 65535) throw new Error('--port must be 0-65535');
  if (!Number.isFinite(out.speed) || out.speed <= 0 || out.speed > 600) throw new Error('--speed must be between 0 and 600 (demo minutes per real minute)');
  if (out.scenario !== 'board' && out.scenario !== 'gallery') throw new Error('--scenario must be board or gallery');
  if (out.sessions !== undefined && !(Number.isInteger(out.sessions) && out.sessions >= 1 && out.sessions <= 60)) throw new Error('--sessions must be a whole number from 1 to 60');
  return out;
}

/** `clayclaude demo`: a fixture board with no hosts and no credentials. Every action is simulated. */
export async function runDemo(args: string[]): Promise<void> {
  let a: DemoArgs;
  try { a = parseDemoArgs(args); } catch (e) { return userError((e as Error).message, DEMO_USAGE); }
  const demo = createDemo({ scenario: a.scenario, speed: a.speed, sessions: a.sessions });
  const webRoot = fileURLToPath(new URL('../../web/dist/', import.meta.url));
  const clayRoutes = createClayRoutes({ webRoot });
  let srv: Awaited<ReturnType<typeof startServer>>;
  let kiosk: KioskLauncher | undefined;   // set once the server knows its port
  try {
    srv = await startServer({
      cfg: { ...demo.cfg, port: a.port }, collector: demo.collector as never, usage: demo.usage as never, webRoot, port: a.port, names: demo.names,
      handlers: [createKioskRoute(() => kiosk), createActionRoutes(demo.api, { mode: 'demo', publicConfig: demo.publicConfig }), clayRoutes.handler],
    });
  } catch (e) {
    demo.stop(); await clayRoutes.close();
    return userError(listenError(e, a.port, 'is clayclaude already running? pick another with --port'));
  }
  // Its own Chrome tab (application id), so a demo never takes over the real board's tab.
  kiosk = a.kiosk ? new KioskLauncher({ adbBin: demo.cfg.tablet.adb, port: srv.port, chromePackage: demo.cfg.tablet.chromePackage, appId: 'clayclaude-demo' }) : undefined;
  const adb = a.adb ? new AdbReverse(demo.cfg.tablet.adb, srv.port, {
    onConnect: kiosk ? (serial) => { if (kioskWants(demo.cfg.tablet.serial, serial)) void kiosk.launch(serial); } : undefined,
  }) : undefined;
  demo.collector.start(); adb?.start();
  console.log(`clayclaude demo (${a.scenario}${a.scenario === 'board' && a.speed !== 1 ? `, ${a.speed}x` : ''}) on http://127.0.0.1:${srv.port}`);
  const build = buildReport(webRoot, fileURLToPath(new URL('../../', import.meta.url)));
  console.log(build.line);
  if (build.warning) console.warn(`clayclaude: warning: ${build.warning}`);
  console.log('Simulated data only: no hosts, no credentials, and nothing is run when you tap Open, Attach, Answer, Message or Start.');
  await new Promise<void>((resolve) => {
    const stop = async () => { adb?.stop(); demo.stop(); await clayRoutes.close(); await srv.close(); resolve(); };
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
  });
}

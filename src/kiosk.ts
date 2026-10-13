import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import type { RouteHandler } from './server.js';
import { isLoopback, tokenEqual } from './security.js';

/**
 * Kiosk by default (spec §5.4). On each connect of the tablet (AdbReverse's `onConnect`), once:
 * wake the screen, keep it on while charging, then open the board full screen: the installed WebAPK if there is
 * one, otherwise Chrome plus one injected tap on the board's "tap to start" overlay (web/src/kiosk.ts), which
 * covers the whole page while it is not full screen. A real `input tap` is a trusted gesture, so the overlay's
 * click handler may call requestFullscreen() and lock the orientation (measured on the tablet, 2026-10-12).
 * Every launch is logged. Nothing is retried: the next attempt is the next connect.
 *
 * After the launch the board asks for the tap itself (Task 35, `pageTap` via POST /api/kiosk/tap) whenever it is not
 * full screen: after a reload, a tab switch, Back or a swipe, a rotation. The same checks apply (never on a lock
 * screen, only with Chrome in front), taps are kept apart, and a run of them stops, so a page that cannot go full
 * screen never drives a tap loop.
 *
 * Only the page the launch opened may ask. The launch URL carries a random key in its fragment (`#kiosk=<key>`,
 * new for each daemon run), and the page sends it back. Loopback alone is not enough: any site can navigate a desktop
 * browser on this PC to http://localhost:<port>/#kiosk (the board page itself is allowed, security.ts), and that page
 * reaches the daemon over loopback just as the tablet does through adb reverse.
 *
 * One board tab per port. Chrome reuses the tab opened under the same application id only while it remembers that
 * tab (not after Chrome restarts, nor once the board was typed into), so each daemon restart could leave one more
 * board tab behind. After opening Chrome the launch therefore closes, through Chrome's DevTools socket, every other
 * page whose URL is this port's kiosk URL (`http://localhost:<port>/#kiosk…`) with an older key: never a tab of
 * another port or site, and nothing until the tab it just opened is listed.
 */

export type AdbRun = (args: string[]) => Promise<string>;

export interface KioskOpts {
  adbBin: string;
  port: number;
  chromePackage: string;
  run?: AdbRun;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  /** Wait between the Chrome launch and the tap, so the page and its overlay are up (load took < 1 s on the tablet). */
  settleMs?: number;
  /** Chrome's application id for the tab: the demo uses its own, so it never takes over the real board's tab. */
  appId?: string;
  now?: () => number;
  /** The launch key (test seam); by default 16 random bytes in hex, new for each launcher. */
  key?: string;
  /** HTTP GET on the adb host, where `adb forward` binds the DevTools socket (test seam; see hostGet). */
  devtoolsGet?: (url: string) => Promise<string>;
}

export type PageTapResult =
  | { tapped: true; at: [number, number] }
  | { tapped: false; reason: 'no-device' | 'locked' | 'not-in-front' | 'limited' | 'failed'; error?: string }
  | { tapped: false; reason: 'busy' | 'too-soon'; retryMs: number };

/** Shortest gap between two taps on a device. */
export const TAP_GAP_MS = 3000;
/** At most this many taps per TAP_WINDOW_MS on a device; a page that keeps asking past that is stuck, not starting. */
export const TAP_MAX = 8;
export const TAP_WINDOW_MS = 120_000;

export type KioskResult =
  | { via: 'webapk'; component: string }
  | { via: 'chrome'; tapped: true; at: [number, number] }
  | { via: 'chrome'; tapped: false; reason: 'locked' | 'not-in-front' }
  | { via: 'failed'; step: string; error: string }
  | { via: 'busy' };

/** Chrome reuses the tab opened with the same application id, so replugs do not pile up tabs. */
export const KIOSK_APP_ID = 'clayclaude';
/** stay_on_while_plugged_in bits: 1 AC, 2 USB, 4 wireless. */
export const STAY_ON_ALL = 7;

/**
 * The board's kiosk URL, with the launch key when given. A fragment, not a query: no character the device shell would
 * treat specially (the key is hex), and a fragment never reaches a server or a Referer.
 */
export const kioskUrl = (port: number, key?: string) => `http://localhost:${port}/#kiosk${key ? `=${key}` : ''}`;

/** The configured serial only; with none configured, any device that is not an emulator. */
export const kioskWants = (configured: string | undefined, serial: string) =>
  configured ? serial === configured : !serial.startsWith('emulator-');

/** The WebAPK activity among `cmd package query-activities --brief` lines, or undefined. */
export function findWebApk(out: string): string | undefined {
  return out.split(/\r?\n/).map((l) => l.trim()).find((l) => /^org\.chromium\.webapk\.\w+\/\S+$/.test(l));
}

/** The value to write so the screen stays on while charging, or undefined when it already does. */
export function stayOnValue(current: string): number | undefined {
  const v = Number.parseInt(current.trim(), 10);
  const cur = Number.isInteger(v) && v >= 0 ? v : 0;
  return (cur & STAY_ON_ALL) === STAY_ON_ALL ? undefined : cur | STAY_ON_ALL;
}

export function parseWmSize(out: string): { w: number; h: number } | undefined {
  const m = /Override size:\s*(\d+)x(\d+)/.exec(out) ?? /Physical size:\s*(\d+)x(\d+)/.exec(out);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined;
}

/**
 * Half the short side, on both axes: inside the screen in either orientation and well below Chrome's toolbar,
 * so it always lands on the overlay, which covers the whole page. Layout never decides where the tap goes.
 */
export function tapPoint(size: { w: number; h: number }): [number, number] {
  const s = Math.round(Math.min(size.w, size.h) / 2);
  return [s, s];
}

/** From `dumpsys window`: is a lock screen up, and is Chrome the focused window. */
export function windowState(dump: string, chromePackage: string): { locked: boolean; chromeInFront: boolean; focus: string } {
  const focus = /mCurrentFocus=(.*)/.exec(dump)?.[1]?.trim() ?? '';
  return { locked: /isKeyguardShowing=true/.test(dump), chromeInFront: focus.includes(` ${chromePackage}/`), focus };
}

/**
 * Windows curl.exe when the adb is a Windows adb.exe under WSL, named directly or through a link on PATH: its forward
 * binds on Windows, which WSL (NAT networking) cannot reach on 127.0.0.1. Undefined everywhere else, where the
 * forward is on this host.
 */
export function hostCurl(adbBin: string, platform: NodeJS.Platform = process.platform, pathEnv = process.env.PATH ?? ''): string | undefined {
  if (platform !== 'linux') return undefined;
  const real = (p: string) => { try { return realpathSync(p); } catch { return undefined; } };
  const bin = adbBin.includes('/') ? real(adbBin) ?? adbBin : pathEnv.split(':').filter(Boolean).map((d) => real(join(d, adbBin))).find(Boolean);
  return bin && /\.exe$/i.test(bin) ? '/mnt/c/Windows/System32/curl.exe' : undefined;
}

/** A GET on the adb host (the DevTools forward), with a short timeout. */
function hostGet(adbBin: string): (url: string) => Promise<string> {
  return async (url) => {
    const curl = hostCurl(adbBin);
    if (curl) return new Promise((res, rej) => execFile(curl, ['-s', '-f', '--max-time', '5', url], { timeout: 8000 }, (e, out) => (e ? rej(e) : res(out))));
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status} from ${url}`);
    return r.text();
  };
}

/**
 * The DevTools ids of the older board tabs for this port: pages at exactly `http://localhost:<port>/#kiosk` or
 * `#kiosk=<other key>`. None while no page shows the current launch's URL, so the board always keeps a tab.
 */
export function staleKioskTabs(list: unknown, port: number, key: string): string[] {
  const pages = (Array.isArray(list) ? list : []).filter((t): t is { id: string; url: string } =>
    !!t && typeof t === 'object' && (t as { type?: unknown }).type === 'page' && typeof (t as { id?: unknown }).id === 'string' && typeof (t as { url?: unknown }).url === 'string');
  if (!pages.some((t) => t.url === kioskUrl(port, key))) return [];
  return pages.filter((t) => {
    if (t.url === kioskUrl(port, key)) return false;
    let u: URL;
    try { u = new URL(t.url); } catch { return false; }
    return u.protocol === 'http:' && u.host === `localhost:${port}` && u.pathname === '/' && u.search === '' && /^#kiosk(=[0-9a-f]*)?$/.test(u.hash);
  }).map((t) => t.id);
}

/** `am start` reports a failed launch on stdout and may still exit 0. */
const amFailed = (out: string) => /^(Error|Exception)\b/m.test(out);

export class KioskLauncher {
  private run: AdbRun;
  private log: (msg: string) => void;
  private sleep: (ms: number) => Promise<void>;
  private get: (url: string) => Promise<string>;
  private settleMs: number;
  private inFlight = new Set<string>();
  private now: () => number;
  /** The device the kiosk last opened the board on: the one a page's request comes from (there is one tablet). */
  private device?: string;
  private taps = new Map<string, number[]>();
  private limitedLogged = new Set<string>();
  /** The launch key in the kiosk URL; a tap request must carry it (see the top of this file). */
  readonly key: string;

  constructor(private o: KioskOpts) {
    this.key = o.key ?? randomBytes(16).toString('hex');
    this.now = o.now ?? Date.now;
    this.run = o.run ?? ((args) => new Promise((res, rej) => execFile(o.adbBin, args, { timeout: 10_000, maxBuffer: 8 << 20 }, (e, out) => (e ? rej(e) : res(out)))));
    this.log = o.log ?? ((m) => console.log(m));
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.get = o.devtoolsGet ?? hostGet(o.adbBin);
    this.settleMs = o.settleMs ?? 3000;
  }

  /** One launch on a device that has just connected. Never throws and never retries. */
  async launch(serial: string): Promise<KioskResult> {
    if (this.inFlight.has(serial)) return { via: 'busy' };
    this.inFlight.add(serial);
    this.device = serial;
    const sh = (...args: string[]) => this.run(['-s', serial, 'shell', ...args]);
    const say = (m: string) => this.log(`clayclaude: kiosk on ${serial}: ${m}`);
    const url = kioskUrl(this.o.port, this.key);
    let step = 'wake';
    try {
      await sh('input', 'keyevent', 'KEYCODE_WAKEUP');
      step = 'stay-awake';
      const next = stayOnValue(await sh('settings', 'get', 'global', 'stay_on_while_plugged_in'));
      if (next !== undefined) {
        await sh('settings', 'put', 'global', 'stay_on_while_plugged_in', String(next));
        say(`screen stays on while charging (stay_on_while_plugged_in ${next})`);
      }
      // Removes a swipe lock screen; a PIN lock screen stays (and is detected before any tap).
      await sh('wm', 'dismiss-keyguard').catch(() => '');

      step = 'find-webapk';
      const webapk = findWebApk(await sh('cmd', 'package', 'query-activities', '--brief',
        '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', url).catch(() => ''));
      if (webapk) {
        step = 'launch-webapk';
        try {
          const out = await sh('am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url, '-n', webapk);
          if (amFailed(out)) throw new Error(out.trim().split(/\r?\n/).find((l) => amFailed(l)) ?? 'am start failed');
          say(`launched the installed app ${webapk}`);
          return { via: 'webapk', component: webapk };
        } catch (e) {
          say(`the installed app did not start (${msg(e)}); using Chrome`);
        }
      }

      step = 'launch-chrome';
      const out = await sh('am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url,
        '-e', 'com.android.browser.application_id', this.o.appId ?? KIOSK_APP_ID, '-p', this.o.chromePackage);
      if (amFailed(out)) throw new Error(out.trim().split(/\r?\n/).find((l) => amFailed(l)) ?? 'am start failed');
      await this.sleep(this.settleMs);
      await this.closeStaleTabs(serial, say);

      step = 'check-screen';
      const w = windowState(await sh('dumpsys', 'window'), this.o.chromePackage);
      if (w.locked) {
        say('opened the board in Chrome behind the lock screen; after unlocking, tap the board once to go full screen');
        return { via: 'chrome', tapped: false, reason: 'locked' };
      }
      if (!w.chromeInFront) {
        say(`opened the board in Chrome, but ${w.focus || 'another window'} is in front; no tap sent`);
        return { via: 'chrome', tapped: false, reason: 'not-in-front' };
      }
      step = 'tap';
      const size = parseWmSize(await sh('wm', 'size'));
      if (!size) throw new Error('cannot read the screen size from wm size');
      const at = tapPoint(size);
      await sh('input', 'tap', String(at[0]), String(at[1]));
      this.tapped(serial);
      say(`opened the board in Chrome and tapped "tap to start" at ${at[0]},${at[1]}`);
      return { via: 'chrome', tapped: true, at };
    } catch (e) {
      say(`failed at ${step}: ${msg(e)}`);
      return { via: 'failed', step, error: msg(e) };
    } finally {
      this.inFlight.delete(serial);
    }
  }

  /** Close this port's older board tabs (see the top of this file). Never throws: a failure is logged and the launch goes on. */
  private async closeStaleTabs(serial: string, say: (m: string) => void): Promise<void> {
    let fwd: string | undefined;
    try {
      const out = (await this.run(['-s', serial, 'forward', 'tcp:0', 'localabstract:chrome_devtools_remote'])).trim();
      if (!/^\d+$/.test(out)) throw new Error(`adb forward tcp:0 printed ${JSON.stringify(out)}`);
      fwd = `tcp:${out}`;
      const base = `http://127.0.0.1:${out}`;
      const stale = staleKioskTabs(JSON.parse(await this.get(`${base}/json/list`)), this.o.port, this.key);
      for (const id of stale) await this.get(`${base}/json/close/${encodeURIComponent(id)}`);
      if (stale.length) say(`closed ${stale.length} older board tab${stale.length === 1 ? '' : 's'} for port ${this.o.port}`);
    } catch (e) {
      say(`could not close older board tabs: ${msg(e)}`);
    } finally {
      if (fwd) await this.run(['-s', serial, 'forward', '--remove', fwd]).catch(() => '');
    }
  }

  /** The request carries this launcher's key (constant time). */
  owns(given: unknown): boolean { return typeof given === 'string' && given !== '' && tokenEqual(given, this.key); }

  private tapped(serial: string) { this.taps.set(serial, [...(this.taps.get(serial) ?? []), this.now()]); }

  /** The board is showing "Tap to start" and asks for its tap. Never throws. */
  async pageTap(): Promise<PageTapResult> {
    const serial = this.device;
    if (!serial) return { tapped: false, reason: 'no-device' };
    if (this.inFlight.has(serial)) return { tapped: false, reason: 'busy', retryMs: this.settleMs + 1000 };   // the launch taps
    const t = this.now();
    const recent = (this.taps.get(serial) ?? []).filter((x) => t - x < TAP_WINDOW_MS);
    this.taps.set(serial, recent);
    const last = recent.at(-1);
    if (last !== undefined && t - last < TAP_GAP_MS) return { tapped: false, reason: 'too-soon', retryMs: TAP_GAP_MS - (t - last) };
    const say = (m: string) => this.log(`clayclaude: kiosk on ${serial}: ${m}`);
    if (recent.length >= TAP_MAX) {
      if (!this.limitedLogged.has(serial)) say(`the board asked for too many taps (${TAP_MAX} in ${TAP_WINDOW_MS / 60_000} minutes); not tapping for now`);
      this.limitedLogged.add(serial);
      return { tapped: false, reason: 'limited' };
    }
    this.limitedLogged.delete(serial);
    this.inFlight.add(serial);
    const sh = (...args: string[]) => this.run(['-s', serial, 'shell', ...args]);
    try {
      const w = windowState(await sh('dumpsys', 'window'), this.o.chromePackage);
      if (w.locked) return { tapped: false, reason: 'locked' };
      if (!w.chromeInFront) return { tapped: false, reason: 'not-in-front' };
      const size = parseWmSize(await sh('wm', 'size'));
      if (!size) throw new Error('cannot read the screen size from wm size');
      const at = tapPoint(size);
      await sh('input', 'tap', String(at[0]), String(at[1]));
      this.tapped(serial);
      say(`the board is not full screen; tapped "tap to start" at ${at[0]},${at[1]}`);
      return { tapped: true, at };
    } catch (e) {
      say(`tap for the board failed: ${msg(e)}`);
      return { tapped: false, reason: 'failed', error: msg(e) };
    } finally {
      this.inFlight.delete(serial);
    }
  }
}

/**
 * POST /api/kiosk/tap: the kiosk board asks for its "tap to start" tap (Task 35). Only from the tablet, which reaches
 * the daemon over adb reverse (loopback), only with the board's X-Clayclaude header (a cross-site form cannot
 * set it), and only from the page the launch opened: X-Clayclaude-Kiosk carries the key from its URL. Not there when
 * the kiosk is off, so the page stops asking.
 */
export function createKioskRoute(kiosk: () => Pick<KioskLauncher, 'owns' | 'pageTap'> | undefined): RouteHandler {
  return async (req, res, url) => {
    if (req.method !== 'POST' || url.pathname !== '/api/kiosk/tap') return false;
    const k = kiosk();
    if (!k) return false;
    req.resume?.();   // the body ("{}") carries nothing
    const reply = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    if (!isLoopback(req.socket.remoteAddress) || req.headers['x-clayclaude'] !== '1' || !k.owns(req.headers['x-clayclaude-kiosk'])) { reply(403, { tapped: false, reason: 'forbidden' }); return true; }
    reply(200, await k.pageTap());
    return true;
  };
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

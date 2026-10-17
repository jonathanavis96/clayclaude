import { execFile } from 'node:child_process';
import type { RouteHandler } from './server.js';
import type { Session } from './types.js';
import type { AdbRun } from './kiosk.js';
import { readState, writeStateKey } from './dismissed.js';

/**
 * The tablet dims, then sleeps, when nobody is typing to Claude. With no new prompt in any session (Session.lastPromptAt;
 * headless helpers do not count) for `dimAfterMinutes` the screen brightness drops to `dimPercent`, and after
 * `sleepAfterMinutes` the screen goes off (KEYCODE_SLEEP). The next prompt typed anywhere wakes it (KEYCODE_WAKEUP, then
 * `wm dismiss-keyguard`, which clears a swipe lock screen; a PIN lock screen would stay up) and puts the brightness and
 * its auto/manual mode back as they were. 0 minutes turns that step off.
 *
 * The defaults come from the config (tablet.*); the board's Settings change them (GET/POST /api/screen), kept in
 * state.json under `screen`. The daemon start counts as activity, so a restart never dims or sleeps at once. Only a change
 * of step is sent: a failed adb call is logged and not retried until the next change.
 *
 * The step and the brightness from before a dim are kept in state.json too (`screenState`), so a daemon that stopped
 * without putting the screen back (a crash) does it on its next start. A clean stop puts the screen back itself.
 */
export interface ScreenPrefs { dimAfterMinutes: number; dimPercent: number; sleepAfterMinutes: number }

type Step = 'awake' | 'dim' | 'asleep';
const RANK: Record<Step, number> = { awake: 0, dim: 1, asleep: 2 };
const MAX_MINUTES = 24 * 60;

/** A whole number of minutes, 0 (off) to a day; a brightness of 1 to 100 %. Anything else is undefined. */
const minutes = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= MAX_MINUTES ? v : undefined);
const percent = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 100 ? v : undefined);

/** `over`'s valid keys on top of `base`; undefined when `over` is not an object or has a bad value. */
export function mergeScreenPrefs(base: ScreenPrefs, over: unknown): ScreenPrefs | undefined {
  if (!over || typeof over !== 'object' || Array.isArray(over)) return undefined;
  const o = over as Record<string, unknown>;
  const out = { ...base };
  for (const [k, check] of [['dimAfterMinutes', minutes], ['dimPercent', percent], ['sleepAfterMinutes', minutes]] as const) {
    if (o[k] === undefined) continue;
    const v = check(o[k]);
    if (v === undefined) return undefined;
    out[k] = v;
  }
  return out;
}

export interface TabletSleepOpts {
  adbBin: string;
  /** The tablet to drive, once one has connected; nothing is sent while undefined. */
  serial: () => string | undefined;
  sessions: () => Session[];
  /** The config's values; state.json's `screen` key, when valid, is laid over them. */
  defaults: ScreenPrefs;
  /** state.json; no file means the board's changes last until the daemon stops. */
  statePath?: string;
  run?: AdbRun;
  now?: () => number;
  log?: (msg: string) => void;
  intervalMs?: number;
}

export class TabletSleep {
  private run: AdbRun;
  private now: () => number;
  private log: (msg: string) => void;
  private seen?: number;
  private lastActive = 0;
  private step: Step = 'awake';
  /** Brightness and mode from before the dim, to put back on wake. */
  private saved?: { brightness: string; mode: string };
  private p: ScreenPrefs;
  private timer?: NodeJS.Timeout;
  /** One step change at a time: a tick that lands while adb is still busy waits for it. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private o: TabletSleepOpts) {
    this.run = o.run ?? ((args) => new Promise((res, rej) => execFile(o.adbBin, args, { timeout: 10_000 }, (e, out) => (e ? rej(e) : res(out)))));
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.log(m));
    const st = o.statePath ? readState(o.statePath) : {};
    this.p = mergeScreenPrefs(o.defaults, st.screen) || { ...o.defaults };
    const ss = st.screenState as { step?: unknown; brightness?: unknown; mode?: unknown } | null | undefined;
    if (ss && (ss.step === 'dim' || ss.step === 'asleep')) {
      if (typeof ss.brightness === 'string' && typeof ss.mode === 'string') this.saved = { brightness: ss.brightness, mode: ss.mode };
      this.step = 'asleep';   // as far as is known: the first tick with a tablet wakes it and puts the brightness back
    }
  }

  start() { this.timer = setInterval(() => void this.tick(), this.o.intervalMs ?? 30_000); this.timer.unref(); void this.tick(); }
  /** Stops the ticks and puts the screen back (awake, at its old brightness) if it is dimmed or asleep. */
  async stop(): Promise<void> {
    clearInterval(this.timer);
    const back = () => this.go('awake', 0);
    this.chain = this.chain.then(back, back);
    await this.chain;
  }

  prefs(): ScreenPrefs { return { ...this.p }; }

  /** New settings from the board: saved, then applied at once. Returns the settings now in force, or undefined if invalid. */
  async setPrefs(over: unknown): Promise<ScreenPrefs | undefined> {
    const next = mergeScreenPrefs(this.p, over);
    if (!next) return undefined;
    const redim = this.step === 'dim' && next.dimPercent !== this.p.dimPercent;
    this.p = next;
    if (this.o.statePath) {
      try { writeStateKey(this.o.statePath, 'screen', next); }
      catch (e) { this.log(`clayclaude: could not save state.json: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
    }
    // Already dimmed: the new percentage applies now, not at the next dim.
    if (redim) this.chain = this.chain.then(() => this.dimTo(), () => this.dimTo());
    await this.tick();
    return this.prefs();
  }

  /** The screen was woken some other way (the kiosk launch on connect): count it as activity. */
  woke(): Promise<unknown> { this.lastActive = Math.max(this.lastActive, this.now()); return this.tick(); }

  /** Moves to the step the idle time calls for; returns the step it moved to, if any. */
  tick(): Promise<Step | undefined> {
    const r = this.chain.then(() => this.advance(), () => this.advance());
    this.chain = r;
    return r;
  }

  private async advance(): Promise<Step | undefined> {
    const now = this.now();
    const latest = Math.max(0, ...this.o.sessions().filter((s) => !s.background).map((s) => s.lastPromptAt ?? 0));
    if (this.seen === undefined) { this.seen = latest; this.lastActive = Math.max(this.lastActive, latest, now); }
    if (latest > this.seen) { this.seen = latest; this.lastActive = Math.max(this.lastActive, latest); }
    const idle = now - this.lastActive;
    const { dimAfterMinutes: dim, sleepAfterMinutes: sleep } = this.p;
    const want: Step = sleep > 0 && idle >= sleep * 60_000 ? 'asleep' : dim > 0 && idle >= dim * 60_000 ? 'dim' : 'awake';
    return this.go(want, idle);
  }

  private async go(want: Step, idle: number): Promise<Step | undefined> {
    if (want === this.step) return undefined;
    // No tablet yet: the step is not taken, so the first tick after it connects sends it.
    const serial = this.o.serial();
    if (!serial) return undefined;
    const from = this.step;
    this.step = want;
    const sh = this.shell(serial);
    try {
      if (from === 'asleep') { await sh('input', 'keyevent', 'KEYCODE_WAKEUP'); await sh('wm', 'dismiss-keyguard').catch(() => ''); }
      if (want === 'dim' && !this.saved) {
        this.saved = { brightness: (await sh('settings', 'get', 'system', 'screen_brightness')).trim(), mode: (await sh('settings', 'get', 'system', 'screen_brightness_mode')).trim() };
        await sh('settings', 'put', 'system', 'screen_brightness_mode', '0');
        await sh('settings', 'put', 'system', 'screen_brightness', this.dimLevel());
      }
      if (want === 'awake' && this.saved) {
        const s = this.saved;
        this.saved = undefined;
        if (/^\d+$/.test(s.brightness)) await sh('settings', 'put', 'system', 'screen_brightness', s.brightness);
        if (/^\d+$/.test(s.mode)) await sh('settings', 'put', 'system', 'screen_brightness_mode', s.mode);
      }
      if (want === 'asleep') await sh('input', 'keyevent', 'KEYCODE_SLEEP');
      this.keep();
      this.log(`clayclaude: tablet ${serial}: ${want === 'asleep' ? 'screen off' : want === 'dim' ? `dimmed to ${this.p.dimPercent}%` : 'screen on'} (${RANK[want] > RANK[from] ? `no prompt for ${Math.round(idle / 60_000)} min` : 'prompt typed or settings changed'})`);
    } catch (e) {
      this.log(`clayclaude: tablet ${serial}: ${from} → ${want} failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
    return want;
  }

  private keep() {
    if (!this.o.statePath) return;
    try { writeStateKey(this.o.statePath, 'screenState', this.step === 'awake' ? null : { step: this.step, ...this.saved }); }
    catch (e) { this.log(`clayclaude: could not save state.json: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
  }

  private shell(serial: string) { return (...args: string[]) => this.run(['-s', serial, 'shell', ...args]); }
  private dimLevel() { return String(Math.max(1, Math.round(255 * this.p.dimPercent / 100))); }

  /** Sets the dimmed brightness again, while dimmed. */
  private async dimTo(): Promise<void> {
    const serial = this.o.serial();
    if (this.step !== 'dim' || !serial) return;
    try { await this.shell(serial)('settings', 'put', 'system', 'screen_brightness', this.dimLevel()); }
    catch (e) { this.log(`clayclaude: tablet ${serial}: dim to ${this.p.dimPercent}% failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
  }
}

/** GET /api/screen: the settings in force. POST /api/screen with some of their keys: changes them. */
export function createScreenRoute(sleeper: () => Pick<TabletSleep, 'prefs' | 'setPrefs'> | undefined): RouteHandler {
  return async (req, res, url) => {
    if (url.pathname !== '/api/screen') return false;
    const reply = (code: number, body: unknown) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
    const s = sleeper();
    if (req.method === 'GET') { reply(200, s ? { enabled: true, ...s.prefs() } : { enabled: false }); return true; }
    if (req.method !== 'POST') { reply(405, { ok: false }); return true; }
    if (req.headers['x-clayclaude'] !== '1' || !String(req.headers['content-type'] ?? '').startsWith('application/json')) { req.resume(); reply(403, { ok: false }); return true; }
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1024) { reply(413, { ok: false }); return true; } }
    let body: unknown;
    try { body = JSON.parse(raw); } catch { reply(400, { ok: false }); return true; }
    if (!s) { reply(409, { ok: false }); return true; }
    const p = await s.setPrefs(body);
    reply(p ? 200 : 400, p ? { ok: true, ...p } : { ok: false });
    return true;
  };
}

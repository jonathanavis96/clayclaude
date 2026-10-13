import { execFile } from 'node:child_process';
import { deviceSerials } from './adbpick.js';

/** Another adb (the other kind: Windows adb.exe vs Linux adb). Only its `devices` is ever run, and only while its server is up. */
export interface OtherAdb { bin: string; serverUp: () => Promise<boolean>; run: (argv: string[]) => Promise<string> }

export class AdbReverse {
  private timer?: NodeJS.Timeout;
  private run: (args: string[]) => Promise<string>;
  private log: (msg: string) => void;
  private onConnect?: (serial: string) => void;
  /**
   * Serials connected with the reverse in place. A serial that leaves `adb devices` and comes back connects again, and
   * so does one whose reverse had to be applied again: a replug or `adb reconnect` that is over within one tick keeps
   * the serial listed but drops every reverse on the device.
   */
  private connected = new Set<string>();
  private other?: OtherAdb;
  private now: () => number;
  constructor(private adbBin: string, private port: number, opts: { run?: (args: string[]) => Promise<string>; intervalMs?: number; log?: (msg: string) => void; onConnect?: (serial: string) => void; other?: OtherAdb; now?: () => number } = {}) {
    this.run = opts.run ?? ((args) => new Promise((res, rej) => execFile(this.adbBin, args, { timeout: 5000 }, (e, out) => (e ? rej(e) : res(out)))));
    this.intervalMs = opts.intervalMs ?? 3000;
    this.log = opts.log ?? ((m) => console.log(m));
    this.onConnect = opts.onConnect;
    this.other = opts.other;
    this.now = opts.now ?? Date.now;
  }
  private intervalMs: number;

  private running = false;
  /** adb itself could not run last tick (wrong path, not installed); logged once, not every 3 s. */
  private adbFailing = false;
  /** When this stretch of "no device" began, and whether the other adb was asked about it (once per stretch). */
  private noDeviceSince?: number;
  private otherAsked = false;

  /** Ensures the reverse on every attached device, each addressed by serial so a second device or an emulator cannot make adb refuse. */
  async tick(): Promise<'applied' | 'present' | 'no-device' | 'busy'> {
    if (this.running) return 'busy'; // the adb timeout (5 s) is longer than the interval (3 s)
    this.running = true;
    try {
      let devices: string;
      try { devices = await this.run(['devices']); }
      catch (e) {
        if (!this.adbFailing) this.log(`clayclaude: cannot run adb (${this.adbBin}): ${e instanceof Error ? e.message : String(e)}`);
        this.adbFailing = true;
        await this.noDevice();
        return 'no-device';
      }
      this.adbFailing = false;
      const serials = deviceSerials(devices);
      if (!serials.length) { this.connected.clear(); await this.noDevice(); return 'no-device'; }
      this.noDeviceSince = undefined; this.otherAsked = false;
      const spec = `tcp:${this.port}`;
      // `reverse --list` lines read "<transport> <remote> <local>"; match both ends exactly, so tcp:742 never matches tcp:7420.
      const has = (list: string) => list.split(/\r?\n/).some((l) => { const t = l.trim().split(/\s+/); return t.at(-2) === spec && t.at(-1) === spec; });
      let applied = false;
      const ok: string[] = [];
      const reapplied = new Set<string>();
      for (const s of serials) {
        try { // one device failing must not stop the others
          if (!has(await this.run(['-s', s, 'reverse', '--list']))) {
            await this.run(['-s', s, 'reverse', spec, spec]);
            applied = true;
            reapplied.add(s);
            this.log(`clayclaude: adb reverse ${spec} applied on ${s}`);
          }
          ok.push(s);
        } catch { /* try the next device */ }
      }
      // A device whose reverse failed this tick stays connected if it already was; it connects once the reverse is in place.
      const before = this.connected;
      this.connected = new Set([...serials.filter((s) => before.has(s)), ...ok]);
      for (const s of ok) {
        if (before.has(s) && !reapplied.has(s)) continue;
        try { this.onConnect?.(s); } catch (e) { this.log(`clayclaude: device-connect handler failed on ${s}: ${e instanceof Error ? e.message : String(e)}`); }
      }
      return !ok.length ? 'no-device' : applied ? 'applied' : 'present';
    } finally { this.running = false; }
  }
  /** After 30 s with no device, ask the other adb once whether it has the tablet. Never kill-server or start-server: no fight. */
  private async noDevice() {
    const t = this.now();
    this.noDeviceSince ??= t;
    const o = this.other;
    if (!o || this.otherAsked || t - this.noDeviceSince < 30_000) return;
    this.otherAsked = true;
    try {
      if (!(await o.serverUp())) return; // no server, no device; `devices` would start one
      const theirs = deviceSerials(await o.run(['devices']));
      if (theirs.length) this.log(`clayclaude: warning: ${this.adbBin} sees no device, but ${o.bin} sees ${theirs.join(', ')}: another adb server owns the tablet. Use one adb only: set tablet.adb to ${o.bin} in the config, or run "${o.bin} kill-server" so ${this.adbBin} can take it.`);
    } catch { /* the other adb could not tell; say nothing */ }
  }
  start() { if (this.timer) return; this.log(`clayclaude: using adb ${this.adbBin}`); void this.tick(); this.timer = setInterval(() => void this.tick(), this.intervalMs); }
  stop() { clearInterval(this.timer); this.timer = undefined; }
}

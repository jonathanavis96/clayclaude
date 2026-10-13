import { describe, it, expect } from 'vitest';
import { KioskLauncher, createKioskRoute, findWebApk, hostCurl, kioskUrl, kioskWants, parseWmSize, stayOnValue, tapPoint, windowState } from '../src/kiosk.js';
const KEY = '0123456789abcdef0123456789abcdef'; // gitleaks:allow (a fake test key)
import { parseConfig } from '../src/config.js';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Outputs captured from the real tablet (Android 15 Go, Chrome 131), 2026-10-12. */
const CHROME_FRONT = '  mCurrentFocus=Window{ce85884 u0 com.android.chrome/org.chromium.chrome.browser.ChromeTabbedActivity}\n    isKeyguardShowing=false\n';
const LOCKED = '  mCurrentFocus=Window{684560b u0 NotificationShade}\n    isKeyguardShowing=true\n';
const LAUNCHER_FRONT = '  mCurrentFocus=Window{3615122 u0 com.android.launcher3/com.android.launcher3.Launcher3QuickStepGo}\n    isKeyguardShowing=false\n';
const CHROME_ONLY = 'priority=0 preferredOrder=0 match=0x208000 specificIndex=-1 isDefault=true\ncom.android.chrome/com.google.android.apps.chrome.IntentDispatcher\n';
const WITH_WEBAPK = '2 activities found:\norg.chromium.webapk.a1b2c3d4/org.chromium.webapk.shell_apk.h2o.H2OMainActivity\ncom.android.chrome/com.google.android.apps.chrome.IntentDispatcher\n';
const AM_OK = 'Starting: Intent { act=android.intent.action.VIEW dat=http://localhost:8420/... }\nStatus: ok\nLaunchState: COLD\n';

/** Tab targets from Chrome's DevTools /json/list (shape as on the tablet). */
const tab = (id: string, url: string, type = 'page') => ({ id, type, url, title: '', webSocketDebuggerUrl: `ws://127.0.0.1/devtools/page/${id}` });

function fakeAdb(o: { stayOn?: string; activities?: string; window?: string; am?: string; amWebApk?: string; failOn?: string; tabs?: unknown[] } = {}) {
  const calls: string[] = [];
  /** The DevTools HTTP endpoints behind `adb forward tcp:0` (which prints the port it picked: 9333 here). */
  const get = async (url: string) => {
    calls.push(`GET ${url}`);
    if (o.failOn && url.includes(o.failOn)) throw new Error('connection refused');
    if (url === 'http://127.0.0.1:9333/json/list') return JSON.stringify(o.tabs ?? [tab('NEW', `http://localhost:8420/#kiosk=${KEY}`)]);
    if (url.startsWith('http://127.0.0.1:9333/json/close/')) return 'Target is closing';
    throw new Error(`unexpected GET ${url}`);
  };
  const run = async (args: string[]) => {
    const line = args.join(' ');
    calls.push(line);
    if (o.failOn && line.includes(o.failOn)) throw new Error('device offline');
    const sh = args.slice(3).join(' ');   // after "-s <serial> shell"
    if (sh === 'settings get global stay_on_while_plugged_in') return `${o.stayOn ?? '0'}\n`;
    if (sh.startsWith('cmd package query-activities')) return o.activities ?? CHROME_ONLY;
    if (sh.startsWith('am start') && sh.includes(' -n ')) return o.amWebApk ?? AM_OK;
    if (sh.startsWith('am start')) return o.am ?? AM_OK;
    if (sh === 'dumpsys window') return o.window ?? CHROME_FRONT;
    if (sh === 'wm size') return 'Physical size: 800x1280\n';
    if (line.endsWith('forward tcp:0 localabstract:chrome_devtools_remote')) return '9333\r\n';
    return '';
  };
  return { calls, run, get };
}

const make = (f: ReturnType<typeof fakeAdb>, logs: string[] = []) =>
  new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'com.android.chrome', run: f.run, devtoolsGet: f.get, log: (m) => logs.push(m), sleep: async () => {}, key: KEY });

describe('kiosk helpers', () => {
  it('builds the kiosk URL with a fragment, never a query, carrying the launch key when there is one', () => {
    expect(kioskUrl(8420)).toBe('http://localhost:8420/#kiosk');
    expect(kioskUrl(8420, KEY)).toBe(`http://localhost:8420/#kiosk=${KEY}`);
  });
  it('makes a fresh random key per launcher, of characters the device shell takes literally', () => {
    const a = new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'c' }), b = new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'c' });
    expect(a.key).toMatch(/^[0-9a-f]{32}$/);
    expect(a.key).not.toBe(b.key);
    expect(a.owns(a.key)).toBe(true);
    expect(a.owns(b.key)).toBe(false);
    expect(a.owns(undefined)).toBe(false);
    expect(a.owns('')).toBe(false);
  });
  it('picks the configured serial, or any non-emulator device', () => {
    expect(kioskWants('TAB1', 'TAB1')).toBe(true);
    expect(kioskWants('TAB1', 'TAB2')).toBe(false);
    expect(kioskWants(undefined, 'TAB2')).toBe(true);
    expect(kioskWants(undefined, 'emulator-5554')).toBe(false);
  });
  it('finds a WebAPK activity and ignores Chrome', () => {
    expect(findWebApk(CHROME_ONLY)).toBeUndefined();
    expect(findWebApk('No activities found\n')).toBeUndefined();
    expect(findWebApk(WITH_WEBAPK.replace(/\n/g, '\r\n'))).toBe('org.chromium.webapk.a1b2c3d4/org.chromium.webapk.shell_apk.h2o.H2OMainActivity');
  });
  it('adds the AC, USB and wireless bits to stay_on_while_plugged_in only when one is missing', () => {
    expect(stayOnValue('0\n')).toBe(7);
    expect(stayOnValue('2')).toBe(7);
    expect(stayOnValue('8')).toBe(15);           // keeps the dock bit
    expect(stayOnValue('7')).toBeUndefined();
    expect(stayOnValue('15\r\n')).toBeUndefined();
    expect(stayOnValue('null')).toBe(7);
  });
  it('taps at half the short side, inside the screen in either orientation', () => {
    expect(parseWmSize('Physical size: 800x1280\n')).toEqual({ w: 800, h: 1280 });
    expect(parseWmSize('Physical size: 800x1280\nOverride size: 600x960\n')).toEqual({ w: 600, h: 960 });
    expect(parseWmSize('error')).toBeUndefined();
    expect(tapPoint({ w: 800, h: 1280 })).toEqual([400, 400]);
    expect(tapPoint({ w: 1280, h: 800 })).toEqual([400, 400]);
  });
  it('reads the lock screen and the focused window from dumpsys window', () => {
    expect(windowState(CHROME_FRONT, 'com.android.chrome')).toMatchObject({ locked: false, chromeInFront: true });
    expect(windowState(LOCKED, 'com.android.chrome')).toMatchObject({ locked: true, chromeInFront: false });
    expect(windowState(LAUNCHER_FRONT, 'com.android.chrome')).toMatchObject({ locked: false, chromeInFront: false });
    expect(windowState(CHROME_FRONT, 'com.chrome.beta').chromeInFront).toBe(false);
  });
  it('is on by default in the config', () => {
    const c = parseConfig('hosts: [{id: local}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ~/.claude}]\n', '/home/u');
    expect(c.tablet.kiosk).toBe(true);
    expect(parseConfig('hosts: [{id: local}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ~/.claude}]\ntablet: {kiosk: false}\n', '/home/u').tablet.kiosk).toBe(false);
  });
});

describe('KioskLauncher', () => {
  it('without a WebAPK: wakes, keeps the screen on, opens Chrome on the kiosk URL and taps once', async () => {
    const f = fakeAdb();
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'chrome', tapped: true, at: [400, 400] });
    expect(f.calls).toEqual([
      '-s TAB1 shell input keyevent KEYCODE_WAKEUP',
      '-s TAB1 shell settings get global stay_on_while_plugged_in',
      '-s TAB1 shell settings put global stay_on_while_plugged_in 7',
      '-s TAB1 shell wm dismiss-keyguard',
      `-s TAB1 shell cmd package query-activities --brief -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d http://localhost:8420/#kiosk=${KEY}`,
      `-s TAB1 shell am start -W -a android.intent.action.VIEW -d http://localhost:8420/#kiosk=${KEY} -e com.android.browser.application_id clayclaude -p com.android.chrome`,
      '-s TAB1 forward tcp:0 localabstract:chrome_devtools_remote',
      'GET http://127.0.0.1:9333/json/list',
      '-s TAB1 forward --remove tcp:9333',
      '-s TAB1 shell dumpsys window',
      '-s TAB1 shell wm size',
      '-s TAB1 shell input tap 400 400',
    ]);
    expect(f.calls.filter((c) => c.includes('input tap'))).toHaveLength(1);
    expect(logs).toEqual([
      'clayclaude: kiosk on TAB1: screen stays on while charging (stay_on_while_plugged_in 7)',
      'clayclaude: kiosk on TAB1: opened the board in Chrome and tapped "tap to start" at 400,400',
    ]);
  });

  it('leaves stay_on_while_plugged_in alone when it already covers USB charging', async () => {
    const f = fakeAdb({ stayOn: '15' });
    await make(f).launch('TAB1');
    expect(f.calls.some((c) => c.includes('settings put'))).toBe(false);
  });

  it('with a WebAPK: starts it by component and taps nothing', async () => {
    const f = fakeAdb({ activities: WITH_WEBAPK });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'webapk', component: 'org.chromium.webapk.a1b2c3d4/org.chromium.webapk.shell_apk.h2o.H2OMainActivity' });
    expect(f.calls.at(-1)).toBe(`-s TAB1 shell am start -W -a android.intent.action.VIEW -d http://localhost:8420/#kiosk=${KEY} -n org.chromium.webapk.a1b2c3d4/org.chromium.webapk.shell_apk.h2o.H2OMainActivity`);
    expect(f.calls.some((c) => c.includes('input tap') || c.includes('-p com.android.chrome'))).toBe(false);
    expect(logs.at(-1)).toContain('launched the installed app org.chromium.webapk.a1b2c3d4');
  });

  it('falls back to Chrome when the WebAPK does not start', async () => {
    const f = fakeAdb({ activities: WITH_WEBAPK, amWebApk: 'Starting: Intent {...}\nError: Activity class does not exist.\n' });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'chrome', tapped: true, at: [400, 400] });
    expect(logs.some((l) => l.includes('did not start (Error: Activity class does not exist.); using Chrome'))).toBe(true);
  });

  it('never taps on a lock screen (a tap there could press a PIN key)', async () => {
    const f = fakeAdb({ window: LOCKED });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'chrome', tapped: false, reason: 'locked' });
    expect(f.calls.some((c) => c.includes('input tap') || c.includes('wm size'))).toBe(false);
    expect(logs.at(-1)).toContain('behind the lock screen');
  });

  it('never taps when another app is in front', async () => {
    const f = fakeAdb({ window: LAUNCHER_FRONT });
    expect(await make(f).launch('TAB1')).toEqual({ via: 'chrome', tapped: false, reason: 'not-in-front' });
    expect(f.calls.some((c) => c.includes('input tap'))).toBe(false);
  });

  it('logs a failure once and does not retry', async () => {
    const f = fakeAdb({ failOn: 'am start' });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'failed', step: 'launch-chrome', error: 'device offline' });
    expect(f.calls.filter((c) => c.includes('am start'))).toHaveLength(1);
    expect(logs).toEqual([
      'clayclaude: kiosk on TAB1: screen stays on while charging (stay_on_while_plugged_in 7)',
      'clayclaude: kiosk on TAB1: failed at launch-chrome: device offline',
    ]);
  });

  it('treats an "Error:" from am start as a failed launch', async () => {
    const f = fakeAdb({ am: 'Starting: Intent {...}\nError: Activity not started, unable to resolve Intent\n' });
    expect(await make(f).launch('TAB1')).toMatchObject({ via: 'failed', step: 'launch-chrome' });
    expect(f.calls.some((c) => c.includes('input tap'))).toBe(false);
  });

  it('ignores a second connect of the same serial while the first launch runs', async () => {
    let release!: () => void;
    const f = fakeAdb();
    const k = new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'com.android.chrome', run: f.run, devtoolsGet: f.get, log: () => {},
      sleep: () => new Promise<void>((r) => { release = r; }) });
    const first = k.launch('TAB1');
    await new Promise((r) => setTimeout(r, 0));
    expect(await k.launch('TAB1')).toEqual({ via: 'busy' });
    release();
    expect((await first).via).toBe('chrome');
    expect(f.calls.filter((c) => c.includes('am start'))).toHaveLength(1);
  });

  it('closes the older board tabs for its own port after opening Chrome, so restarts never pile up tabs', async () => {
    const f = fakeAdb({ tabs: [
      tab('NEW', `http://localhost:8420/#kiosk=${KEY}`),
      tab('OLD1', 'http://localhost:8420/#kiosk=ffffffffffffffffffffffffffffffff'),
      tab('OLD2', 'http://localhost:8420/#kiosk'),
      tab('PORT', 'http://localhost:8437/#kiosk=ffffffffffffffffffffffffffffffff'),   // another daemon's board
      tab('PLAIN', 'http://localhost:8420/'),                                         // opened by hand, not by a launch
      tab('IP', 'http://127.0.0.1:8420/#kiosk=ffffffffffffffffffffffffffffffff'),
      tab('SITE', 'https://example.com/#kiosk=ffffffffffffffffffffffffffffffff'),
      tab('PATH', 'http://localhost:8420/other#kiosk=ffffffffffffffffffffffffffffffff'),
      tab('SW', 'http://localhost:8420/#kiosk=ffffffffffffffffffffffffffffffff', 'service_worker'),
      tab('BAD', 'not a url'),
    ] });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'chrome', tapped: true, at: [400, 400] });
    expect(f.calls.filter((c) => c.startsWith('GET ') || c.includes(' forward '))).toEqual([
      '-s TAB1 forward tcp:0 localabstract:chrome_devtools_remote',
      'GET http://127.0.0.1:9333/json/list',
      'GET http://127.0.0.1:9333/json/close/OLD1',
      'GET http://127.0.0.1:9333/json/close/OLD2',
      '-s TAB1 forward --remove tcp:9333',
    ]);
    expect(f.calls.indexOf('-s TAB1 forward --remove tcp:9333')).toBeLessThan(f.calls.indexOf('-s TAB1 shell dumpsys window'));
    expect(logs).toContain('clayclaude: kiosk on TAB1: closed 2 older board tabs for port 8420');
  });

  it('closes nothing while the tab it just opened is not listed, so the board is never left without a tab', async () => {
    const f = fakeAdb({ tabs: [tab('OLD1', 'http://localhost:8420/#kiosk=ffffffffffffffffffffffffffffffff')] });
    expect((await make(f).launch('TAB1')).via).toBe('chrome');
    expect(f.calls.filter((c) => c.includes('/json/close/'))).toEqual([]);
  });

  it('a DevTools failure is logged, still removes the forward, and the launch still taps', async () => {
    const f = fakeAdb({ failOn: '/json/list' });
    const logs: string[] = [];
    expect(await make(f, logs).launch('TAB1')).toEqual({ via: 'chrome', tapped: true, at: [400, 400] });
    expect(f.calls).toContain('-s TAB1 forward --remove tcp:9333');
    expect(logs).toContain('clayclaude: kiosk on TAB1: could not close older board tabs: connection refused');
  });

  it('reaches the DevTools forward with Windows curl.exe when the adb is a Windows adb.exe under WSL (the forward binds on Windows)', () => {
    expect(hostCurl('/mnt/c/Android/platform-tools/adb.exe', 'linux')).toBe('/mnt/c/Windows/System32/curl.exe');
    expect(hostCurl('C:\\Android\\adb.exe', 'win32')).toBeUndefined();
    expect(hostCurl('adb', 'darwin')).toBeUndefined();
    // a plain `adb` on PATH that links to adb.exe (tools/tablet.sh run-locked puts such a link first on PATH)
    const dir = mkdtempSync(join(tmpdir(), 'kiosk-adb-'));
    try {
      mkdirSync(join(dir, 'win')); mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'linux'));
      writeFileSync(join(dir, 'win', 'adb.exe'), ''); symlinkSync(join(dir, 'win', 'adb.exe'), join(dir, 'bin', 'adb'));
      writeFileSync(join(dir, 'linux', 'adb'), '');
      expect(hostCurl('adb', 'linux', `${join(dir, 'nothing')}:${join(dir, 'bin')}`)).toBe('/mnt/c/Windows/System32/curl.exe');
      expect(hostCurl(join(dir, 'bin', 'adb'), 'linux')).toBe('/mnt/c/Windows/System32/curl.exe');
      expect(hostCurl('adb', 'linux', join(dir, 'linux'))).toBeUndefined();
      expect(hostCurl('adb', 'linux', join(dir, 'nothing'))).toBeUndefined();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** Task 35: the board asks the daemon for its tap whenever it is not full screen (load, reload, rotation, a tab switch). */
describe('KioskLauncher.pageTap', () => {
  const mk = (f: ReturnType<typeof fakeAdb>, o: { logs?: string[]; now?: () => number; appId?: string } = {}) =>
    new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'com.android.chrome', run: f.run, devtoolsGet: f.get, log: (m) => o.logs?.push(m),
      sleep: async () => {}, now: o.now, appId: o.appId });
  const taps = (f: ReturnType<typeof fakeAdb>) => f.calls.filter((c) => c.includes('input tap'));

  it('taps the "tap to start" cover on the device the kiosk opened, after checking the screen', async () => {
    let t = 0;
    const f = fakeAdb(); const logs: string[] = [];
    const k = mk(f, { logs, now: () => t });
    await k.launch('TAB1');
    t = 60_000; f.calls.length = 0;
    expect(await k.pageTap()).toEqual({ tapped: true, at: [400, 400] });
    expect(f.calls).toEqual(['-s TAB1 shell dumpsys window', '-s TAB1 shell wm size', '-s TAB1 shell input tap 400 400']);
    expect(logs.at(-1)).toBe('clayclaude: kiosk on TAB1: the board is not full screen; tapped "tap to start" at 400,400');
  });

  it('taps nothing before the kiosk has opened the board on a device', async () => {
    const f = fakeAdb();
    expect(await mk(f).pageTap()).toEqual({ tapped: false, reason: 'no-device' });
    expect(f.calls).toEqual([]);
  });

  it('never taps on a lock screen or over another app', async () => {
    let t = 0;
    for (const window of [LOCKED, LAUNCHER_FRONT]) {
      const f = fakeAdb({ window });
      const k = mk(f, { now: () => t });
      await k.launch('TAB1'); t += 60_000;
      expect(await k.pageTap()).toEqual({ tapped: false, reason: window === LOCKED ? 'locked' : 'not-in-front' });
      expect(taps(f)).toEqual([]);
    }
  });

  it('waits while a launch is running (the launch taps), and asks the page to come back', async () => {
    let release!: () => void;
    const f = fakeAdb();
    const k = new KioskLauncher({ adbBin: 'adb', port: 8420, chromePackage: 'com.android.chrome', run: f.run, devtoolsGet: f.get, log: () => {},
      sleep: () => new Promise<void>((r) => { release = r; }), settleMs: 3000 });
    const first = k.launch('TAB1');
    await new Promise((r) => setTimeout(r, 0));
    expect(await k.pageTap()).toMatchObject({ tapped: false, reason: 'busy', retryMs: 4000 });
    release(); await first;
    expect(taps(f)).toHaveLength(1);
  });

  it('keeps taps apart and stops after a run of them, so a page that cannot go full screen never drives a tap loop', async () => {
    let t = 0;
    const f = fakeAdb(); const logs: string[] = [];
    const k = mk(f, { logs, now: () => t });
    await k.launch('TAB1');                                        // the launch's own tap counts
    t = 1000;
    expect(await k.pageTap()).toEqual({ tapped: false, reason: 'too-soon', retryMs: 2000 });
    t = 3000;
    expect((await k.pageTap()).tapped).toBe(true);
    for (let i = 0; i < 10; i++) { t += 3000; await k.pageTap(); }
    expect(taps(f)).toHaveLength(8);                               // 8 in two minutes, then no more
    expect(await k.pageTap()).toEqual({ tapped: false, reason: 'limited' });
    expect(logs.filter((l) => l.includes('too many'))).toHaveLength(1);
    t += 120_000;
    expect((await k.pageTap()).tapped).toBe(true);
  });

  it('opens Chrome under the configured application id (the demo uses its own, so it never takes over the board tab)', async () => {
    const f = fakeAdb();
    await mk(f, { appId: 'clayclaude-demo' }).launch('TAB1');
    expect(f.calls.some((c) => c.includes('-e com.android.browser.application_id clayclaude-demo -p'))).toBe(true);
  });
});

describe('kiosk tap route', () => {
  const req = (o: { method?: string; path?: string; addr?: string; header?: boolean; key?: string | null } = {}) => ({
    method: o.method ?? 'POST', url: o.path ?? '/api/kiosk/tap', socket: { remoteAddress: o.addr ?? '127.0.0.1' },
    headers: { ...(o.header === false ? {} : { 'x-clayclaude': '1' }), ...(o.key === null ? {} : { 'x-clayclaude-kiosk': o.key ?? KEY }) },
  });
  const owns = (k: unknown) => k === KEY;
  const res = () => { const r = { code: 0, body: '', writeHead(c: number) { r.code = c; return r; }, end(b: string) { r.body = b; } }; return r; };
  const call = async (k: { pageTap: () => Promise<unknown> } | undefined, o: Parameters<typeof req>[0] = {}) => {
    const r = res(); const q = req(o);
    const handled = await createKioskRoute(() => k as never)(q as never, r as never, new URL(q.url, 'http://x'));
    return { handled, code: r.code, body: r.body ? JSON.parse(r.body) : undefined };
  };

  it('POST /api/kiosk/tap from the tablet (over adb reverse: loopback) asks the launcher for a tap', async () => {
    const k = { owns, pageTap: async () => ({ tapped: true, at: [400, 400] }) };
    expect(await call(k)).toEqual({ handled: true, code: 200, body: { tapped: true, at: [400, 400] } });
  });
  it('refuses a request without the X-Clayclaude header, or from the LAN', async () => {
    let n = 0; const k = { owns, pageTap: async () => { n++; return { tapped: true }; } };
    expect((await call(k, { header: false })).code).toBe(403);
    expect((await call(k, { addr: '192.168.1.20' })).code).toBe(403);
    expect(n).toBe(0);
  });
  it('refuses a page that was not opened by the kiosk launch: no launch key, or another one', async () => {
    // Any site can navigate a desktop browser to http://localhost:<port>/#kiosk (the page itself is allowed), and that
    // page reaches the daemon over loopback too: without the key it must not drive taps on the tablet.
    let n = 0; const k = { owns, pageTap: async () => { n++; return { tapped: true }; } };
    expect((await call(k, { key: null })).code).toBe(403);
    expect((await call(k, { key: '' })).code).toBe(403);
    expect((await call(k, { key: 'f'.repeat(32) })).code).toBe(403);
    expect(n).toBe(0);
  });
  it('leaves other routes alone, and is not there when the kiosk is off', async () => {
    const k = { owns, pageTap: async () => ({ tapped: true }) };
    expect((await call(k, { method: 'GET' })).handled).toBe(false);
    expect((await call(k, { path: '/api/action' })).handled).toBe(false);
    expect((await call(undefined)).handled).toBe(false);
  });
});

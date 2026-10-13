import { STAY_ON_ALL, findWebApk, kioskUrl } from '../kiosk.js';

export interface TabletOpts { adb: string; serial?: string; port: number; screenTimeoutMs: number; chromePackage: string }
export interface TabletStep { title: string; argv: string[] }

export function parseAdbDevices(out: string): { serial: string; state: string }[] {
  return out.split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 2 && /^[\w:.-]+$/.test(p[0])).map((p) => ({ serial: p[0], state: p[1] }));
}

/** The adb commands `setup` runs, in order. Each is shown to the user before it runs. */
export function tabletPlan(o: TabletOpts): TabletStep[] {
  const a = o.serial ? ['-s', o.serial] : [];
  const spec = `tcp:${o.port}`;
  return [
    { title: 'Forward the board port over USB', argv: [...a, 'reverse', spec, spec] },
    { title: 'Screen timeout', argv: [...a, 'shell', 'settings', 'put', 'system', 'screen_off_timeout', String(o.screenTimeoutMs)] },
    { title: 'Turn off auto-rotate', argv: [...a, 'shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0'] },
    { title: 'Lock to landscape', argv: [...a, 'shell', 'settings', 'put', 'system', 'user_rotation', '1'] },
    { title: 'Open the board in Chrome', argv: [...a, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `http://localhost:${o.port}/`, '-p', o.chromePackage] },
    { title: 'Keep the screen on while charging', argv: [...a, 'shell', 'settings', 'put', 'global', 'stay_on_while_plugged_in', String(STAY_ON_ALL)] },
  ];
}

export const PWA_GUIDANCE = (port: number) => [
  'Install the board as an app (this step is manual; Chrome does not let adb do it):',
  `  1. On the tablet, Chrome should now show http://localhost:${port}/ (the daemon must be running: clayclaude serve).`,
  '  2. Tap the three-dot menu, then "Add to Home screen" or "Install app".',
  '  3. Open clayclaude from the home screen. It runs full screen, in landscape, and keeps the screen on.',
  'If Chrome offers neither (seen with Chrome 131 on an Android 15 Go tablet), use the board in the Chrome tab and',
  'double-tap the clock (or any blank space) in its top bar: the board fills the screen.',
  'Chrome only allows that after a tap; double-tap again to leave full screen, or to return after leaving it.',
  'Optional: Settings > Developer options > "Stay awake" keeps the screen on while charging.',
].join('\n');

/** Lists the launcher activity that accepts pinned shortcuts. Chrome offers "Install app" / "Add to Home screen" only when there is one. */
export const PIN_SHORTCUT_QUERY = ['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.content.pm.action.CONFIRM_PIN_SHORTCUT'];
/** True when the query found an activity (a `package/activity` line), false for "No activities found". */
export const launcherCanPin = (out: string) => out.split(/\r?\n/).some((l) => /^[\w.]+\/[\w.$]+$/.test(l.trim()));
/** Finds an installed WebAPK of the board: it registers for the board's URLs. */
export const webApkQuery = (port: number) => ['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.intent.action.VIEW', '-c', 'android.intent.category.BROWSABLE', '-d', kioskUrl(port)];
export { findWebApk };

export const NO_INSTALL_NOTE = [
  'This tablet\'s home screen cannot take apps added from Chrome, so Chrome offers no "Install app" for the board.',
  'Nothing to do: whenever the tablet is plugged in, clayclaude opens the board in Chrome and taps it full screen',
  '(tablet.kiosk in the config; set it to false to turn that off). Home leaves the board; plugging in again brings it back.',
].join('\n');

export async function runTabletPlan(adb: string, steps: TabletStep[], run: (bin: string, argv: string[]) => Promise<{ code: number; stderr: string }>): Promise<{ title: string; ok: boolean; error?: string }[]> {
  const out: { title: string; ok: boolean; error?: string }[] = [];
  for (const s of steps) {
    const r = await run(adb, s.argv);
    out.push({ title: s.title, ok: r.code === 0, ...(r.code === 0 ? {} : { error: r.stderr.trim().split('\n')[0] || `exit ${r.code}` }) });
  }
  return out;
}

import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Software WebGL that works on any PC, GPU or not, and in WSL: the same pixels everywhere. */
export const CHROMIUM_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-dev-shm-usage'];

export interface FindFs { exists(p: string): boolean; list(dir: string): string[] }
const realFs: FindFs = { exists: existsSync, list: (d) => { try { return readdirSync(d); } catch { return []; } } };

/** Playwright revision order: its 4-digit scheme (2021 on) is newer than the old 6-digit Chromium revisions. */
const rank = (dir: string) => { const n = Number(dir.split('-').pop()); return n < 100_000 ? n : -1; };

/**
 * A Chromium or Chrome binary for headless rendering (PC baking, snapshot tests, tools/perf), or null.
 * Order: $CLAYCLAUDE_CHROMIUM, the explicit path, Playwright's browser cache (newest revision first;
 * old 6-digit folders such as `chromium-815036` are from 2020 and go last), then system installs.
 * Nothing is downloaded.
 */
export function findChromium(explicit?: string, home = homedir(), fs: FindFs = realFs): string | null {
  const cands: string[] = [];
  if (process.env.CLAYCLAUDE_CHROMIUM) cands.push(process.env.CLAYCLAUDE_CHROMIUM);
  if (explicit) cands.push(explicit);
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, '.cache', 'ms-playwright');
  const dirs = fs.list(cache).filter((d) => /^chromium(_headless_shell)?-\d+$/.test(d))
    .sort((a, b) => rank(b) - rank(a) || Number(a.includes('headless')) - Number(b.includes('headless')));
  for (const d of dirs) {
    cands.push(join(cache, d, 'chrome-linux64', 'chrome'), join(cache, d, 'chrome-linux', 'chrome'),
      join(cache, d, 'chrome-headless-shell-linux64', 'chrome-headless-shell'),
      join(cache, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
  }
  cands.push('/usr/bin/chromium', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  return cands.find((p) => fs.exists(p)) ?? null;
}

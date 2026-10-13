import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The build stamp (spec §5.1, UI round 4): which version and commit a board bundle was built from, and when. Vite bakes
 * it into the page (`__CLAY_BUILD__`) and writes it to `web/dist/build.json`; the daemon serves that file at
 * `/api/version`. So a page running old code (an old dist, an old tab) can be told apart from a regression (Task 32).
 */
export interface BuildStamp { version: string; commit: string; builtAt: string | null }

export const UNKNOWN_STAMP: BuildStamp = { version: 'unknown', commit: 'unknown', builtAt: null };

/**
 * The checkout's short HEAD, with `-dirty` when it has uncommitted changes; null when `root` is not itself a git
 * checkout. `root/.git` must exist: an npm install sitting inside some other repository must not report that one.
 */
export function checkoutCommit(root: string): string | null {
  if (!existsSync(join(root, '.git'))) return null;
  const git = (...a: string[]) => execFileSync('git', ['-C', root, ...a], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const head = git('rev-parse', '--short=7', 'HEAD');
    return git('status', '--porcelain', '--untracked-files=no') ? `${head}-dirty` : head;
  } catch { return null; }
}

/** The stamp for a build made now from the package at `root`. */
export function makeStamp(root: string, now = new Date()): BuildStamp {
  let version = 'unknown';
  try { version = String(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? 'unknown'); } catch { /* keep unknown */ }
  return { version, commit: checkoutCommit(root) ?? 'unknown', builtAt: now.toISOString() };
}

/** The stamp of the bundle in `webRoot` (its build.json), keeping only the three string fields; null when absent or garbled. */
export function readServedStamp(webRoot: string): BuildStamp | null {
  try {
    const j = JSON.parse(readFileSync(join(webRoot, 'build.json'), 'utf8'));
    if (typeof j?.version !== 'string' || typeof j?.commit !== 'string') return null;
    return { version: j.version, commit: j.commit, builtAt: typeof j.builtAt === 'string' ? j.builtAt : null };
  } catch { return null; }
}

export const stampLine = (s: BuildStamp | null): string =>
  s ? `board build v${s.version} ${s.commit}, built ${s.builtAt ?? 'unknown'}` : 'board build unknown (no build.json)';

const bare = (c: string) => c.replace(/-dirty$/, '');

/**
 * A warning when the bundle being served was built from another commit than the checkout the server runs from: the
 * case that kept an already-fixed bug on the tablet (a demo run with tsx from a fresh checkout over an old web/dist).
 * Null when they match, or when there is no checkout to compare with (an npm install).
 */
export function staleDistWarning(served: BuildStamp | null, checkout: string | null): string | null {
  if (!checkout) return null;
  if (!served) return `no build.json in the board build: it predates build stamps, so it may be stale (checkout is at ${checkout}); run npm run build`;
  if (served.commit === 'unknown' || bare(served.commit) === bare(checkout)) return null;
  return `the board build is from ${served.commit} but this checkout is at ${checkout}: the tablet will show old code; run npm run build`;
}

/** What `serve` and `demo` print at startup: the served bundle's stamp, and a warning when it is stale for this checkout. */
export function buildReport(webRoot: string, pkgRoot: string): { line: string; warning: string | null } {
  const served = readServedStamp(webRoot);
  return { line: stampLine(served), warning: staleDistWarning(served, checkoutCommit(pkgRoot)) };
}

import { describe, it, expect, afterAll, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { buildReport, checkoutCommit, makeStamp, readServedStamp, stampLine, staleDistWarning, UNKNOWN_STAMP } from '../src/build-info.js';
import { buildStampPlugin } from '../web/build-stamp.js';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';

// Spec §5.1 (UI round 4): the page shows its build and the daemon serves it at /api/version, so a stale page (an old
// dist, an old tab) can be told apart from a regression. Task 32: the focus-view bug that kept coming back was a stale
// bundle (the daemon and demo servers served a web/dist built before the fix), not the current code.

const root = mkdtempSync(join(tmpdir(), 'cc-stamp-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...a: string[]) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).trim();

function repo(name: string): string {
  const d = join(root, name);
  mkdirSync(d);
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'clayclaude', version: '1.2.3' }));
  git(d, 'init', '-q'); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '.');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'x');
  return d;
}

describe('build stamp', () => {
  it('records the package version, the short commit, and when it was built', () => {
    const d = repo('clean');
    const s = makeStamp(d, new Date('2026-10-12T19:30:00Z'));
    expect(s).toEqual({ version: '1.2.3', commit: git(d, 'rev-parse', '--short=7', 'HEAD'), builtAt: '2026-10-12T19:30:00.000Z' });
  });
  it('marks a build from uncommitted changes as dirty', () => {
    const d = repo('dirty');
    writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'clayclaude', version: '1.2.4' }));
    expect(makeStamp(d).commit).toMatch(/^[0-9a-f]{7,}-dirty$/);
    expect(checkoutCommit(d)).toMatch(/-dirty$/);
  });
  it('says unknown outside a git checkout (an npm install)', () => {
    const d = join(root, 'npm'); mkdirSync(d);
    writeFileSync(join(d, 'package.json'), JSON.stringify({ version: '0.9.0' }));
    expect(makeStamp(d).commit).toBe('unknown');
    expect(checkoutCommit(d)).toBeNull();
  });
  it('reads the served bundle\'s build.json, and null when it is missing or garbled', () => {
    const w = join(root, 'web'); mkdirSync(w);
    expect(readServedStamp(w)).toBeNull();
    writeFileSync(join(w, 'build.json'), '{nope');
    expect(readServedStamp(w)).toBeNull();
    writeFileSync(join(w, 'build.json'), JSON.stringify({ version: '1', commit: 'abc1234', builtAt: 'x', extra: '<b>' }));
    expect(readServedStamp(w)).toEqual({ version: '1', commit: 'abc1234', builtAt: 'x' });
  });
  it('warns when web/dist was built from another commit than the checkout the server runs from', () => {
    const s = { version: '0.1.0', commit: 'aaaaaaa', builtAt: '2026-10-12T18:59:51.000Z' };
    expect(staleDistWarning(s, 'bbbbbbb')).toMatch(/aaaaaaa.*bbbbbbb.*npm run build/);
    expect(staleDistWarning(s, 'aaaaaaa-dirty')).toBeNull();            // same commit: dirty-ness alone is not stale
    expect(staleDistWarning({ ...s, commit: 'aaaaaaa-dirty' }, 'aaaaaaa')).toBeNull();
    expect(staleDistWarning(s, null)).toBeNull();                        // an npm install: nothing to compare
    expect(staleDistWarning(null, 'bbbbbbb')).toMatch(/no build\.json/);
  });
  it('prints one line a person can compare with the settings panel', () => {
    expect(stampLine({ version: '0.1.0', commit: 'abc1234', builtAt: '2026-10-12T19:30:00.000Z' })).toBe('board build v0.1.0 abc1234, built 2026-10-12T19:30:00.000Z');
    expect(stampLine(null)).toBe('board build unknown (no build.json)');
  });
});

describe('startup report (serve and demo)', () => {
  it('names the served build and warns when web/dist is older than the checkout', () => {
    const d = repo('report');
    const w = join(d, 'dist'); mkdirSync(w);
    expect(buildReport(w, d).warning).toMatch(/no build\.json/);
    writeFileSync(join(w, 'build.json'), JSON.stringify({ version: '1.2.3', commit: '0000000', builtAt: 't' }));
    expect(buildReport(w, d)).toEqual({ line: 'board build v1.2.3 0000000, built t', warning: expect.stringMatching(/from 0000000 but this checkout is at/) });
    writeFileSync(join(w, 'build.json'), JSON.stringify(makeStamp(d)));
    expect(buildReport(w, d).warning).toBeNull();
  });
});

describe('vite build-stamp plugin', () => {
  it('defines __CLAY_BUILD__ and writes the same stamp to build.json in the bundle', () => {
    const s = { version: '1', commit: 'abc1234', builtAt: 't' };
    const p = buildStampPlugin(s) as any;
    expect(p.config().define.__CLAY_BUILD__).toBe(JSON.stringify(s));
    const files: any[] = [];
    p.generateBundle.call({ emitFile: (f: any) => files.push(f) });
    expect(files).toEqual([{ type: 'asset', fileName: 'build.json', source: JSON.stringify(s) }]);
  });
});

describe('vite dev server', () => {
  // A page served from source is `dev` (web/src/build.ts): it must never compare itself with the daemon's build.json
  // through the /api proxy, or every dev page reloads once and then says it is an old build.
  it('leaves __CLAY_BUILD__ undefined, so the page reports itself as dev', async () => {
    const { createServer } = await import('vite');
    const { ROOT } = await import('./helpers/browser.js');
    const server = await createServer({ configFile: join(ROOT, 'web', 'vite.config.ts'), server: { middlewareMode: true, ws: false }, logLevel: 'error' });
    try {
      // In dev, Vite sets each `define` as a global from its /@vite/env module rather than replacing it in the source.
      const env = (await server.transformRequest('/@vite/env'))?.code ?? '';
      expect(env).toContain('__CLAY_EDITOR__');   // the module does carry the dev defines
      expect(env).not.toContain('__CLAY_BUILD__');
    } finally { await server.close(); }
  }, 60_000);
});

describe('daemon', () => {
  const cfg = parseConfig('hosts: [{id: local}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]\n');
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });
  async function boot() {
    const web = mkdtempSync(join(root, 'srv-'));
    writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
    mkdirSync(join(web, 'assets')); writeFileSync(join(web, 'assets', 'main-AbC123.js'), 'x');
    writeFileSync(join(web, 'sw.js'), 'x');
    const s = await startServer({ cfg, collector: Object.assign(new EventEmitter(), { sessions: () => [] }) as any,
      usage: Object.assign(new EventEmitter(), { usage: () => [], publicShape: () => ({}) }) as any, webRoot: web, port: 0 });
    close = s.close;
    return { base: `http://127.0.0.1:${s.port}`, web };
  }
  it('serves the stamp of the bundle it is serving at /api/version, re-read so a rebuild under it shows', async () => {
    const { base, web } = await boot();
    let r = await fetch(base + '/api/version');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(await r.json()).toEqual(UNKNOWN_STAMP);
    writeFileSync(join(web, 'build.json'), JSON.stringify({ version: '0.1.0', commit: 'abc1234', builtAt: '2026-10-12T19:30:00.000Z' }));
    r = await fetch(base + '/api/version');
    expect(await r.json()).toEqual({ version: '0.1.0', commit: 'abc1234', builtAt: '2026-10-12T19:30:00.000Z' });
  });
  it('makes the browser revalidate the page and the worker every load; hashed assets are immutable', async () => {
    const { base } = await boot();
    for (const p of ['/', '/index.html', '/sw.js']) expect((await fetch(base + p)).headers.get('cache-control')).toBe('no-cache');
    expect((await fetch(base + '/assets/main-AbC123.js')).headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });
});

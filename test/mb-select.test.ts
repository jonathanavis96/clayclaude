import { afterAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// tools/mb-select.sh chooses what tools/merge-branch.sh runs under the merge lock. It only looks at which files
// exist in the worktree it is given, so each case builds a small fake tree in a temp dir.
const TOOLS = join(import.meta.dirname, '..', 'tools');
const SELECT = join(TOOLS, 'mb-select.sh');

const TREE = [
  'test/web-settings-layout.test.ts', 'test/web-launcher-layout.test.ts', 'test/web-rows-layout.test.ts',
  'test/web-settings.test.ts', 'test/clay-browser.test.ts', 'test/clay-snapshots.test.ts', 'test/web-focus-clay.test.ts',
  'test/probe-modes.test.ts', 'test/run.test.ts', 'test/hooks.test.ts',
  'web/src/overlay.css', 'web/src/style.css', 'web/src/settings-view.ts', 'web/src/clay/stage.ts',
  'src/server.ts', 'src/probe/probe.py', 'src/hooks/hook.py', 'README.md',
];
const LAYOUT = ['test/web-launcher-layout.test.ts', 'test/web-rows-layout.test.ts', 'test/web-settings-layout.test.ts'];
const EXCLUDES = ['test/clay-browser*', 'test/clay-snapshots*', 'test/*-clay.test.ts', 'test/web-*-layout*.test.ts'];

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function tree(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-mbsel-'));
  dirs.push(d);
  for (const f of TREE) {
    mkdirSync(dirname(join(d, f)), { recursive: true });
    writeFileSync(join(d, f), '');
  }
  return d;
}

function select(changed: string[]) {
  const r = spawnSync('bash', [SELECT, tree()], { input: changed.join('\n') + '\n', encoding: 'utf8' });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  const lines = r.stdout.split('\n').filter(Boolean);
  const of = (k: string) => lines.filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length + 1));
  return { lines, tests: of('test'), related: of('related'), excludes: of('exclude'), heavy: lines.includes('heavy') };
}

describe('tools/mb-select.sh', () => {
  it('runs a branch\'s own new layout test and every web-*-layout test for a CSS change (the p3/t34 landing)', () => {
    // `git diff ae3afd3^1 ae3afd3 --name-only`: it selected nothing before, so the new test never ran.
    const s = select(['docs/media/settings-crop-after.png', 'test/web-settings-layout.test.ts', 'web/src/overlay.css']);
    expect(s.tests[0]).toBe('test/web-settings-layout.test.ts');
    expect([...s.tests].sort()).toEqual(LAYOUT);
    expect(s.related).toEqual([]);
    expect(s.heavy).toBe(false);
    expect(s.excludes).toEqual(EXCLUDES);
  });

  it('always runs a changed browser test, even when nothing under web/src/clay/ changed', () => {
    const s = select(['test/web-focus-clay.test.ts', 'src/server.ts']);
    expect(s.tests).toEqual(['test/web-focus-clay.test.ts']);
    expect(s.related).toEqual(['src/server.ts']);
    expect(s.heavy).toBe(false);
  });

  it('adds the layout tests for a non-clay web/src/*.ts change, and passes it to vitest related', () => {
    const s = select(['web/src/settings-view.ts']);
    expect([...s.tests].sort()).toEqual(LAYOUT);
    expect(s.related).toEqual(['web/src/settings-view.ts']);
    expect(s.excludes).toEqual(EXCLUDES);
  });

  it('includes browser tests in full for a web/src/clay/ change', () => {
    const s = select(['web/src/clay/stage.ts']);
    expect(s.heavy).toBe(true);
    expect(s.excludes).toEqual([]);
    expect(s.related).toEqual(['web/src/clay/stage.ts']);
    expect(s.tests).toEqual([]);
  });

  it('lists a changed test once even when it is also a layout test', () => {
    const s = select(['test/web-rows-layout.test.ts', 'web/src/style.css']);
    expect(s.tests.filter((t) => t === 'test/web-rows-layout.test.ts')).toHaveLength(1);
    expect(s.tests).toHaveLength(3);
  });

  it('keeps the probe and hook .py rules', () => {
    expect(select(['src/probe/probe.py']).tests).toEqual(['test/probe-modes.test.ts', 'test/run.test.ts']);
    expect(select(['src/hooks/hook.py']).tests).toEqual(['test/hooks.test.ts']);
  });

  it('selects nothing for docs-only or deleted paths, and no layout tests for a server-only change', () => {
    expect(select(['docs/notes.md']).lines).toEqual([]);
    expect(select(['test/gone.test.ts']).tests).toEqual([]);
    const s = select(['src/server.ts', 'README.md']);
    expect(s.tests).toEqual([]);
    expect(s.related).toEqual(['src/server.ts']);
  });
});

describe('tools/merge-branch.sh reads the selection', () => {
  // The parsing block, cut out of merge-branch.sh and run on a known selection, so a change to either side that
  // drops tests (as an IFS= read would, by never splitting the kind from the path) fails here, not at a landing.
  const src = readFileSync(join(TOOLS, 'merge-branch.sh'), 'utf8');
  const start = src.indexOf('  tests=() related=() excl=()');
  const end = src.indexOf('done <<< "$sel"');
  it('has the block and calls mb-select.sh', () => {
    expect(src).toContain('"$wt/tools/mb-select.sh" "$wt"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
  });
  it('fills tests, related, excludes and the heavy flag', () => {
    const block = src.slice(start, end + 'done <<< "$sel"'.length);
    const sel = ['test test/web-settings-layout.test.ts', 'test test/a b.test.ts', 'related src/x.ts', 'exclude test/clay-browser*', 'heavy'].join('\n');
    const script = `set -euo pipefail\nsel="$1"\n${block}\nprintf '%s|' "\${tests[@]}"; echo; printf '%s|' "\${related[@]}"; echo; printf '%s|' "\${excl[@]}"; echo; echo "$heavy_ok"\n`;
    const r = spawnSync('bash', ['-s', '--', sel], { input: script, encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.stdout.split('\n')).toEqual([
      'test/web-settings-layout.test.ts|test/a b.test.ts|', 'src/x.ts|', '--exclude|test/clay-browser*|', '1', '',
    ]);
  });
});

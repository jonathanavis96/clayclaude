import { afterAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

// The build branch becomes a public repo, so no commit landed on it may carry AI attribution. tools/merge-branch.sh
// runs tools/mb-strip-trailers.sh right after rebasing the task branch onto build: it drops the AI co-author and
// session trailer lines from the task branch's own commits (build..HEAD) and nothing else.
// The trailers are spelled in parts so that this file never carries one itself.
const CO_AI = ['Co-Authored-By', 'Claude'].join(': ');
const SESSION = ['Claude', 'Session:'].join('-');
const TOOLS = join(import.meta.dirname, '..', 'tools');
const STRIP = join(TOOLS, 'mb-strip-trailers.sh');

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Ann Author', GIT_AUTHOR_EMAIL: 'ann@example.com',
  GIT_COMMITTER_NAME: 'Cid Committer', GIT_COMMITTER_EMAIL: 'cid@example.com',
};

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...ENV, ...env } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

let n = 0;
function commit(cwd: string, file: string, msg: string): string {
  n += 1;
  writeFileSync(join(cwd, file), `${file} ${n}\n`);
  git(cwd, ['add', file]);
  const date = `${1_700_000_000 + n * 1000} +0200`;
  git(cwd, ['commit', '-q', '--cleanup=verbatim', '-m', msg], {
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: `${1_700_000_000 + n * 1000 + 7} +0200`,
  });
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

const BOTH = `${CO_AI} Opus 5.5 <noreply@anthropic.com>\n${SESSION} https://claude.ai/code/session_x`;

function repo() {
  const d = mkdtempSync(join(tmpdir(), 'cc-mbtrail-'));
  dirs.push(d);
  git(d, ['init', '-q', '-b', 'build']);
  commit(d, 'a.txt', 'Base');
  // Already on build: must never be rewritten, trailers and all.
  const buildTip = commit(d, 'b.txt', `Build commit with old trailers\n\n${BOTH}\n`);
  git(d, ['checkout', '-q', '-b', 'task']);
  commit(d, 'c.txt', `Task one\n\nBody line one.\n${CO_AI} Sonnet 4.5 <noreply@anthropic.com>\nSigned-off-by: Ann Author <ann@example.com>\n\n${BOTH}\n\n`);
  commit(d, 'd.txt', 'Task two, no trailers\n\nCo-Authored-By: Jane Human <jane@example.com>\n');
  commit(d, 'e.txt', `Task three\n\n${BOTH}\n`);
  return { d, buildTip };
}

type Info = { msg: string; tree: string; author: string; committer: string };
function info(d: string, range: string): Info[] {
  return git(d, ['rev-list', '--reverse', range]).trim().split('\n').map((c) => ({
    msg: git(d, ['cat-file', 'commit', c]).split('\n\n').slice(1).join('\n\n'),
    tree: git(d, ['rev-parse', `${c}^{tree}`]).trim(),
    author: git(d, ['log', '-1', '--format=%an <%ae> %ad', '--date=raw', c]).trim(),
    committer: git(d, ['log', '-1', '--format=%cn <%ce> %cd', '--date=raw', c]).trim(),
  }));
}

describe('tools/mb-strip-trailers.sh', () => {
  it('strips the Claude trailers from build..HEAD only, keeping everything else', () => {
    const { d, buildTip } = repo();
    const before = info(d, 'build..task');
    const buildBefore = git(d, ['rev-list', 'build']);
    const r = spawnSync('bash', [STRIP, d, 'build'], { encoding: 'utf8', env: ENV });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['merge-branch: removed AI attribution trailers from 2 of 3 commits']);

    const after = info(d, 'build..task');
    expect(after).toHaveLength(3);
    expect(after.map((c) => c.msg)).toEqual([
      'Task one\n\nBody line one.\nSigned-off-by: Ann Author <ann@example.com>\n',
      'Task two, no trailers\n\nCo-Authored-By: Jane Human <jane@example.com>\n',
      'Task three\n',
    ]);
    for (const c of after) { expect(c.msg.toLowerCase()).not.toContain(SESSION.toLowerCase()); expect(c.msg.toLowerCase()).not.toContain(CO_AI.toLowerCase()); }
    expect(after.map((c) => c.tree)).toEqual(before.map((c) => c.tree));
    expect(after.map((c) => c.author)).toEqual(before.map((c) => c.author));
    expect(after.map((c) => c.committer)).toEqual(before.map((c) => c.committer));

    // build untouched, the branch still sits on it, the worktree is clean and on the branch.
    expect(git(d, ['rev-list', 'build'])).toBe(buildBefore);
    expect(git(d, ['rev-parse', 'build']).trim()).toBe(buildTip);
    expect(git(d, ['merge-base', 'build', 'task']).trim()).toBe(buildTip);
    expect(git(d, ['cat-file', 'commit', buildTip])).toContain(SESSION);
    expect(git(d, ['branch', '--show-current']).trim()).toBe('task');
    expect(git(d, ['status', '--porcelain'])).toBe('');
  });

  it('leaves a clean branch alone and says 0', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-mbtrail-'));
    dirs.push(d);
    git(d, ['init', '-q', '-b', 'build']);
    commit(d, 'a.txt', `Base\n\n${BOTH}\n`);
    git(d, ['checkout', '-q', '-b', 'task']);
    const tip = commit(d, 'b.txt', 'Plain\n');
    const r = spawnSync('bash', [STRIP, d, 'build'], { encoding: 'utf8', env: ENV });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('merge-branch: removed AI attribution trailers from 0 of 1 commits\n');
    expect(git(d, ['rev-parse', 'task']).trim()).toBe(tip);
  });

  it('run with build itself checked out, it rewrites nothing: build keeps every commit, trailers and all', () => {
    const { d, buildTip } = repo();
    git(d, ['checkout', '-q', 'build']);
    const before = git(d, ['rev-list', 'build']);
    const r = spawnSync('bash', [STRIP, d, 'build'], { encoding: 'utf8', env: ENV });
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('merge-branch: removed AI attribution trailers from 0 of 0 commits\n');
    expect(git(d, ['rev-list', 'build'])).toBe(before);
    expect(git(d, ['rev-parse', 'build']).trim()).toBe(buildTip);
  });
});

describe('tools/merge-branch.sh strips the trailers', () => {
  const src = readFileSync(join(TOOLS, 'merge-branch.sh'), 'utf8');
  it('runs the strip after the rebase and before the checks and the merge', () => {
    const rebase = src.indexOf('rebase -q build');
    const strip = src.indexOf('"$wt/tools/mb-strip-trailers.sh" "$wt" build');
    const checks = src.indexOf('"$wt/tools/mb-select.sh" "$wt"');
    const merge = src.indexOf('merge --no-ff');
    expect(rebase).toBeGreaterThan(-1);
    expect(strip).toBeGreaterThan(rebase);
    expect(checks).toBeGreaterThan(strip);
    expect(merge).toBeGreaterThan(checks);
  });
  it('documents exit 2 for a failed test selector', () => {
    const header = src.slice(0, src.indexOf('set -euo pipefail'));
    expect(header).toMatch(/2 setup problem[^;]*the test selector failed/);
  });
});

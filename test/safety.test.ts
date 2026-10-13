import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { basename, join, relative } from 'node:path';

const TEST_DIR = import.meta.dirname;
const files = (d: string): string[] => readdirSync(d).flatMap((n) => {
  const p = join(d, n);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.ts') ? [p] : [];
});

describe('test safety harness', () => {
  it('runs every test with a temp HOME, never the real one', () => {
    expect(homedir()).not.toBe(userInfo().homedir);
    expect(homedir().startsWith(tmpdir())).toBe(true);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });
  it('gives each test file its own temp root (removed when the file ends), so temp dirs never pile up in /tmp', () => {
    const root = process.env.CLAYCLAUDE_TEST_TMP;
    expect(root && basename(root)).toMatch(/^cc-run-/);
    expect(tmpdir()).toBe(root);
  });
  it('points the oauth endpoints at a closed local port', () => {
    expect(process.env.CLAYCLAUDE_USAGE_URL).toBe('http://127.0.0.1:9/usage');
    expect(process.env.CLAYCLAUDE_TOKEN_URL).toBe('http://127.0.0.1:9/token');
  });
  it.skipIf(process.env.CLAYCLAUDE_REAL_GUI === '1')('uses a private tmux server', () => {
    expect(process.env.TMUX).toBeUndefined();
    expect(process.env.TMUX_TMPDIR?.startsWith(tmpdir())).toBe(true);
  });
  it('no test kills or respawns tmux sessions except through the guarded helpers', () => {
    const allowed = new Set([join('helpers', 'tmux.ts'), join('setup', 'safety.ts'), 'safety.test.ts']);
    for (const f of files(TEST_DIR)) {
      const rel = relative(TEST_DIR, f);
      if (allowed.has(rel)) continue;
      expect(readFileSync(f, 'utf8'), rel).not.toMatch(/kill-server|kill-session|kill-window|respawn-(pane|window)/);
    }
  });
});

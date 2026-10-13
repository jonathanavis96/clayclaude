/**
 * Loaded before every test file (vitest `setupFiles`). See Plan 3 Task 0: a temp $HOME, a private tmux
 * server and dead oauth endpoints, so no test can reach a real Claude config, tmux session or token.
 */
import { afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { killAllOwn } from '../helpers/tmux.js';

// One temp root per test file, and TMPDIR pointed at it: every mkdtemp(tmpdir()) a test (or a child it starts:
// python, Chromium's profile) makes lands inside it, and afterAll removes the lot. Without it each run left
// thousands of cc-* directories in /tmp. The system temp dir is remembered once, in case a worker runs several files.
const systemTmp = (process.env.CLAYCLAUDE_SYSTEM_TMP ??= tmpdir());
const root = mkdtempSync(join(systemTmp, 'cc-run-'));
process.env.CLAYCLAUDE_TEST_TMP = root;
process.env.TMPDIR = root;

process.env.HOME = mkdtempSync(join(tmpdir(), 'cc-home-'));
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CLAYCLAUDE_USAGE_URL = 'http://127.0.0.1:9/usage';
process.env.CLAYCLAUDE_TOKEN_URL = 'http://127.0.0.1:9/token';
// No test may find (and so run) a real adb: the daemon's other-adb check and setup's adb search see none.
process.env.CLAYCLAUDE_ADB_CANDIDATES = '';

if (process.env.CLAYCLAUDE_REAL_GUI !== '1') {
  delete process.env.TMUX;
  delete process.env.TMUX_PANE;
  process.env.TMUX_TMPDIR = mkdtempSync(join(tmpdir(), 'cc-tmux-'));
}

afterAll(() => {
  killAllOwn();
  process.env.TMPDIR = systemTmp;
  rmSync(root, { recursive: true, force: true, maxRetries: 3 });
});

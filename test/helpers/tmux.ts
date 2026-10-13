import { execFileSync } from 'node:child_process';

/** Every tmux session a test creates is named with this prefix. Nothing else may be killed. */
export const TEST_PREFIX = 'clayclaude-test-';

export const testSessionName = (tag = '') => `${TEST_PREFIX}${tag}${Math.random().toString(36).slice(2, 8)}`;

/** Kill one tmux session, only if the suite owns it by name. Any other name throws. */
export function killOwn(name: string): void {
  if (!name.startsWith(TEST_PREFIX)) throw new Error(`refusing to kill tmux session "${name}": not a ${TEST_PREFIX}* session`);
  try { execFileSync('tmux', ['kill-session', '-t', `=${name}`], { stdio: 'ignore' }); } catch { /* already gone */ }
}

/** Kill every `clayclaude-test-*` session on the current tmux server, and nothing else. */
export function killAllOwn(): void {
  let names: string[];
  try {
    names = execFileSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n');
  } catch { return; } // no server running
  names.filter((n) => n.startsWith(TEST_PREFIX)).forEach(killOwn);
}

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/** Children still running, so a daemon shutdown can take them with it. */
const live = new Set<ChildProcessWithoutNullStreams>();

/**
 * Spawn with piped stdio in a process group of its own, and remember the child until it exits.
 * The group matters when `ssh` on PATH is a wrapper script that does not exec (ssh.exe from WSL, an agent shim):
 * killing only the wrapper would leave the real client, hung on a dead host, running for ever.
 * An ssh ControlPersist master daemonizes into its own session, so killing the group never takes it down.
 */
export function spawnTracked(cmd: string, args: string[]): ChildProcessWithoutNullStreams {
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  if (child.pid === undefined) return child; // failed to spawn; 'error' follows
  live.add(child);
  child.once('exit', () => live.delete(child));
  return child;
}

/** SIGKILL the child's whole process group (falling back to the child alone). */
export function killTree(child: ChildProcessWithoutNullStreams): void {
  live.delete(child);
  if (child.pid !== undefined) {
    try { process.kill(-child.pid, 'SIGKILL'); return; } catch { /* group already gone */ }
  }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}

/** Kill every tracked child (an ssh to a hung host would otherwise outlive the daemon, holding its connection). */
export function killChildren(): void {
  for (const c of [...live]) killTree(c);
}

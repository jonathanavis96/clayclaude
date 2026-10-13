import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PROBE = join(import.meta.dirname, '../../src/probe/probe.py');

/** The interpreter the probe tests run; set CLAYCLAUDE_TEST_PYTHON=python3.8 to check the 3.8 floor. */
export const PYTHON = process.env.CLAYCLAUDE_TEST_PYTHON || 'python3';

export function runProbeSync(req: object, env?: NodeJS.ProcessEnv): any {
  return JSON.parse(execFileSync(PYTHON, [PROBE, JSON.stringify(req)], { encoding: 'utf8', env: env && { ...process.env, ...env } }));
}

export function makeDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-probe-'));
  mkdirSync(join(d, 'sessions'));
  mkdirSync(join(d, 'projects', '-x'), { recursive: true });
  return d;
}

/** Field 22 of /proc/<pid>/stat, or null off Linux. */
export function procStart(pid: number): number | null {
  try {
    const s = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[19]);
  } catch { return null; }
}

export function sleeper() { return spawn('sleep', ['30'], { stdio: 'ignore' }); }

export function writeJson(path: string, o: object) { writeFileSync(path, JSON.stringify(o)); }

/**
 * A directory holding a fake `ssh` that behaves like `ssh [opts] host cmd...`: it drops the options and
 * the host, then runs the joined command through the shell in $FAKE_SSH_CWD, with the script on stdin.
 * $FAKE_SSH_STDOUT is printed first (a chatty .bashrc); $FAKE_SSH_HOLD_STDERR leaves a background
 * process holding stderr open (what a ControlPersist master does on older OpenSSH).
 */
export function fakeSshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cc-fakessh-'));
  writeFileSync(join(dir, 'ssh'), `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "${dir}/argv.log"
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift 2 ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
shift
[ -n "$FAKE_SSH_STDOUT" ] && printf '%s\\n' "$FAKE_SSH_STDOUT"
[ -n "$FAKE_SSH_HOLD_STDERR" ] && { sleep "$FAKE_SSH_HOLD_STDERR" </dev/null >/dev/null & }
cd "\${FAKE_SSH_CWD:-$HOME}" || exit 255
eval "$*"
`, { mode: 0o755 });
  return dir;
}

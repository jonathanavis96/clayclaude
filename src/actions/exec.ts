import { constants } from 'node:os';
import type { HostConfig } from '../config.js';
import { shJoin } from './quote.js';
import { killTree, spawnTracked } from '../children.js';

export interface ExecResult { code: number; stdout: string; stderr: string }
export interface ExecOptions { input?: string; timeoutMs?: number }
/** Run an argv on a host: directly when local, over the multiplexed ssh connection when remote. */
export type HostExec = (host: HostConfig, argv: string[], o?: ExecOptions) => Promise<ExecResult>;

/**
 * The one set of ssh options, shared with the probe (`probeCommand` in src/probe/run.ts), so actions reuse the probe's connection.
 * `%C` = short hash so the socket path stays under 104 bytes.
 * ServerAlive*: whichever command starts the shared master, it notices a dead connection in ~15 s instead of waiting out
 * TCP retries, so a host that comes back (laptop woken, network changed) is not reported offline for many minutes.
 */
export const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=3',
  // Compression: a probe moves ~200 KB of JSON and Python per poll, 4x faster over a slow link (measured 8 s to 2 s at
  // 225 ms). It is fixed when the shared master connection opens, hence the new socket name: an old uncompressed
  // master, kept alive by ControlPersist and every poll, would otherwise be reused for good.
  '-o', 'Compression=yes', '-o', 'ControlMaster=auto', '-o', 'ControlPath=~/.ssh/clayclaude-z-%C', '-o', 'ControlPersist=10m'];

export function execCommand(host: HostConfig, argv: string[], sshBin = 'ssh'): { cmd: string; args: string[] } {
  if (argv.length === 0) throw new Error('empty argv');
  if (!host.ssh) return { cmd: argv[0], args: argv.slice(1) };
  // -T as in the probe: a `RequestTTY force` in ~/.ssh/config would put a pty in the way (it echoes stdin and never
  // passes on EOF, so a remote `cat > file` hangs). `--`: the alias can never be read as an option.
  return { cmd: sshBin, args: ['-T', ...SSH_OPTS, '--', host.ssh, shJoin(argv)] };
}

const MAX_OUT = 1_000_000;

export function makeExec(o: { sshBin?: string } = {}): HostExec {
  return (host, argv, opts = {}) => new Promise((resolve) => {
    const { cmd, args } = execCommand(host, argv, o.sshBin);
    let stdout = '', stderr = '', done = false;
    let code: number | null | undefined, signal: NodeJS.Signals | null = null, outEnded = false, errEnded = false, grace: NodeJS.Timeout | undefined;
    const child = spawnTracked(cmd, args);
    const finish = (r: ExecResult) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      // Let go of the pipes: a grandchild (an ssh ControlPersist master) may hold them open for minutes.
      child.stdout.destroy(); child.stderr.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => { killTree(child); finish({ code: 124, stdout, stderr: stderr || `${host.id}: timed out` }); }, opts.timeoutMs ?? 8000);
    // Settle on exit plus end of stdout, not on 'close' (as runProbe does): older OpenSSH leaves the backgrounded
    // ControlPersist master holding stderr, so 'close' would wait out the timeout and report success as a timeout.
    const settle = () => {
      if (done || code === undefined || !outEnded) return;
      if (!errEnded) { grace ??= setTimeout(() => { errEnded = true; settle(); }, 200); return; }
      finish({ code: code ?? 128 + (constants.signals[signal!] ?? 0), stdout, stderr });
    };
    child.on('error', (e) => finish({ code: 127, stdout, stderr: `${cmd}: ${e.message}` }));
    // Decode as a stream: a multi-byte character split across two reads would otherwise become two U+FFFD.
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => { if (stdout.length < MAX_OUT) stdout += c; });
    child.stderr.on('data', (c: string) => { if (stderr.length < MAX_OUT) stderr += c; });
    child.stdout.on('end', () => { outEnded = true; settle(); });
    child.stderr.on('end', () => { errEnded = true; settle(); });
    child.on('exit', (c, sig) => { code = c; signal = sig; settle(); });
    child.stdin.on('error', () => { /* child exited before reading */ });
    child.stdin.end(opts.input ?? '');
  });
}

export const firstLine = (s: string) => s.trim().split('\n')[0] ?? '';
/** The line of a failed command's stderr to show: the last one, since a remote shell's startup warnings (locale, a missing rc file) come first. */
export const errorLine = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';

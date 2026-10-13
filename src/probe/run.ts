import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { HostConfig } from '../config.js';
import { SSH_OPTS } from '../actions/exec.js';
import { killTree, spawnTracked } from '../children.js';

const PROBE_PATH = fileURLToPath(new URL('./probe.py', import.meta.url));
let probeSource: string | undefined;

export class ProbeError extends Error {
  constructor(public kind: 'timeout' | 'spawn' | 'exit' | 'parse' | 'unsupported', msg: string) { super(msg); }
}

/**
 * Largest probe reply accepted. A real snapshot is a few MB at most (60 clipped lines per transcript); a host that
 * streams without end (a `yes` in a .bashrc, a broken wrapper) would otherwise grow one string until V8 throws
 * "Invalid string length" inside the data handler, which nothing catches, and the daemon dies.
 */
export const MAX_PROBE_OUTPUT = 64 * 1024 * 1024;

export function probeCommand(host: HostConfig, req: object, pythonBin = 'python3') {
  const json = JSON.stringify(req);
  // The request rides on stdin ahead of the script, never in argv: one argv string is capped at 128 KB on Linux
  // (spawn fails with E2BIG, here or in the remote shell), and the `known` map grows with the number of sessions.
  // A JSON string literal is a valid Python string literal (JSON.stringify never writes \/).
  const stdin = `import sys; sys.argv[1:] = [${JSON.stringify(json)}]\n${(probeSource ??= readFileSync(PROBE_PATH, 'utf8'))}`;
  // -I (isolated): no script dir or cwd on sys.path and no PYTHON* env, so a stray ~/json.py on the host cannot shadow the stdlib.
  if (!host.ssh) return { cmd: pythonBin, args: ['-I', '-'], stdin };
  return {
    cmd: 'ssh',
    // -T: a RequestTTY in ~/.ssh/config would otherwise hand the script to an interactive REPL and hang.
    // SSH_OPTS: shared with actions so both multiplex one connection; includes the ServerAlive* keepalive.
    // `--`: a host alias can never be read as an ssh option.
    args: ['-T', ...SSH_OPTS, '--', host.ssh, 'python3', '-I', '-'],
    stdin,
  };
}

/** The probe prints one JSON line; a remote shell startup file (.bashrc echo, conda, nvm) may print text before it. */
function parseOutput<T>(out: string): T {
  try { return JSON.parse(out) as T; } catch { /* fall through */ }
  const lines = out.split('\n').filter((l) => l.trim());
  return JSON.parse(lines[lines.length - 1] ?? '') as T;
}

export function runProbe<T>(host: HostConfig, req: object, opts: { timeoutMs?: number; pythonBin?: string } = {}): Promise<T> {
  const { cmd, args, stdin } = probeCommand(host, req, opts.pythonBin);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let outBytes = 0, err = '', done = false;
    let code: number | null | undefined, signal: NodeJS.Signals | null = null, outEnded = false, errEnded = false, grace: NodeJS.Timeout | undefined;
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnTracked(cmd, args);
    } catch (e) { // E2BIG, EMFILE and friends throw here rather than emitting 'error'
      return reject(new ProbeError('spawn', `${host.id}: ${e instanceof Error ? e.message : String(e)}`));
    }
    const timer = setTimeout(() => { finish(new ProbeError('timeout', `${host.id}: probe timed out`)); killTree(child); }, opts.timeoutMs ?? 10_000);
    const finish = (e: Error | null, v?: T) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(grace);
      // Let go of the pipes: a grandchild (an ssh ControlPersist master) may hold them open for minutes.
      child.stdout.destroy(); child.stderr.destroy();
      chunks.length = 0;
      e ? reject(e) : resolve(v!);
    };
    // Settle on exit plus end of stdout, not on 'close': older OpenSSH leaves the backgrounded ControlPersist master
    // holding stderr, so 'close' would wait for the master to exit. stderr gets a short grace period for the error text.
    const settle = () => {
      if (done || code === undefined || !outEnded) return;
      if (!errEnded) { grace ??= setTimeout(() => { errEnded = true; settle(); }, 200); return; }
      if (code !== 0) {
        const last = err.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? ''; // the real error is last (after a Traceback header or a banner)
        const how = code === null ? `killed by ${signal ?? 'a signal'}` : `exit ${code}`;
        return finish(new ProbeError('exit', `${host.id}: ${how}${last ? `: ${last}` : ''}`));
      }
      let v: T;
      try { v = parseOutput<T>(Buffer.concat(chunks).toString('utf8')); } catch { return finish(new ProbeError('parse', `${host.id}: bad probe output`)); }
      // A host the probe refuses to run on (native Windows) answers every mode this way: fail the call, whatever the mode.
      const u = v as { ok?: unknown; error?: unknown; unsupportedPlatform?: unknown } | null;
      if (u && typeof u === 'object' && u.ok === false && typeof u.unsupportedPlatform === 'string')
        return finish(new ProbeError('unsupported', `${host.id}: ${typeof u.error === 'string' ? u.error : `unsupported platform ${u.unsupportedPlatform}`}`));
      finish(null, v);
    };
    child.on('error', (e) => finish(new ProbeError('spawn', `${host.id}: ${e.message}`)));
    child.stderr.setEncoding('utf8');
    // Raw bytes, decoded once at the end: no split multi-byte characters, and no rope of thousands of small strings.
    child.stdout.on('data', (c: Buffer) => {
      if (done) return;
      outBytes += c.length;
      if (outBytes > MAX_PROBE_OUTPUT) {
        finish(new ProbeError('parse', `${host.id}: probe output too large (over ${MAX_PROBE_OUTPUT >> 20} MB)`));
        killTree(child);
        return;
      }
      chunks.push(c);
    });
    child.stderr.on('data', (c: string) => { err = (err + c).slice(-8192); });
    child.stdout.on('end', () => { outEnded = true; settle(); });
    child.stderr.on('end', () => { errEnded = true; settle(); });
    child.on('exit', (c, sig) => { code = c; signal = sig; settle(); });
    // If the child exits before reading all of stdin, the write fails with EPIPE; unhandled, that would kill the daemon.
    // The exit code still reaches 'exit' above.
    child.stdin.on('error', () => {});
    child.stdin.end(stdin);
  });
}

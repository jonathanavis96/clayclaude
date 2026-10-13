import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { makeExec } from '../actions/exec.js';
import { detectPlatform } from '../actions/platform.js';
import { isWsl, systemAdbCandidates } from '../adbpick.js';
import { runProbe } from '../probe/run.js';
import { InputClosed, readlinePrompter } from '../setup/prompter.js';
import { runSetup } from '../setup/wizard.js';
import { userError } from './fail.js';

const run = (bin: string, argv: string[], cwd?: string, timeoutMs = 30_000) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
  execFile(bin, argv, { timeout: timeoutMs, cwd, maxBuffer: 4_000_000 }, (e, stdout, stderr) =>
    resolve({ code: e ? ((e as NodeJS.ErrnoException & { code?: number | string }).code === 'ENOENT' ? 127 : Number((e as { code?: number }).code) || 1) : 0, stdout: String(stdout), stderr: String(stderr || (e?.message ?? '')) }));
});

export const SETUP_USAGE = 'usage: clayclaude setup [--config <path>]';

/** Throws on an unknown option or a --config with no path, so setup never runs against a file the user did not mean. */
export function parseSetupArgs(args: string[], home = homedir()): { configPath: string } {
  let configPath = join(home, '.config', 'clayclaude', 'config.yaml');
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '--config') throw new Error(`unknown option "${args[i]}"`);
    const v = args[++i];
    if (!v || v.startsWith('-')) throw new Error('--config needs a path');
    configPath = v;
  }
  return { configPath };
}

export async function runSetupCommand(args: string[]): Promise<void> {
  let configPath: string;
  try { configPath = parseSetupArgs(args).configPath; } catch (e) { return userError((e as Error).message, SETUP_USAGE); }
  const platform = detectPlatform();
  const prompt = readlinePrompter();
  try {
    await runSetup({
      prompt, home: homedir(), configPath, platform,
      exec: makeExec(), probe: (h, r) => runProbe(h, r, { timeoutMs: 30_000 }),
      readText: async (p) => { try { return await readFile(p, 'utf8'); } catch { return null; } },
      fileExists: existsSync,
      runLocal: (bin, argv, o) => run(bin, argv, undefined, o?.timeoutMs),
      adbCandidates: () => systemAdbCandidates(platform.kind === 'wsl' || isWsl()),
      winUser: async () => (platform.kind === 'wsl' ? (await run('cmd.exe', ['/c', 'echo', '%USERNAME%'], '/mnt/c')).stdout.trim() || undefined : undefined),
      toWindowsPath: async (p) => (platform.kind === 'wsl' && p.startsWith('/') ? (await run('wslpath', ['-w', p])).stdout.trim() || p : p),
      interfaces: () => Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address),
    });
  } catch (e) {
    if (!(e instanceof InputClosed)) throw e;
    prompt.say('\nSetup stopped before it finished. Steps you confirmed were applied; nothing after them was changed.');
    process.exitCode = 1;
  } finally { prompt.close(); }
}

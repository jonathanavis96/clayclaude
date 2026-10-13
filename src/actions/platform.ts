import { readFileSync } from 'node:fs';

export interface PlatformEnv { kind: 'wsl' | 'win32' | 'darwin' | 'linux'; distro?: string }

export function detectPlatform(): PlatformEnv {
  if (process.platform === 'win32') return { kind: 'win32' };
  if (process.platform === 'darwin') return { kind: 'darwin' };
  try {
    if (/microsoft/i.test(readFileSync('/proc/version', 'utf8'))) return { kind: 'wsl', distro: process.env.WSL_DISTRO_NAME };
  } catch { /* not linux */ }
  return { kind: 'linux' };
}

/** Said once at start-up on native Windows: the probe refuses such a host, and local actions run bash and tmux. */
export function unsupportedPlatformWarning(platform: NodeJS.Platform = process.platform): string | null {
  return platform === 'win32'
    ? 'clayclaude: native Windows is not supported; run Claude Code and clayclaude under WSL2 (the probe will not watch this machine, and attaching and launching need bash and tmux)'
    : null;
}

/**
 * Under WSL a Linux process starts a Windows .exe through an interop socket in /run/WSL. Each terminal session has its
 * own, and a process that has none in WSL_INTEROP and no session above it, such as a systemd user service, falls back
 * to the boot socket (1_interop, a link to 2_interop). When that socket hangs, every .exe the daemon starts hangs too,
 * while the same command works from any terminal, and a restart lands on the same socket. Nothing tells a hung socket
 * from a good one except running something through it, so the daemon moves on when adb fails. Children inherit
 * process.env, so moving WSL_INTEROP moves every .exe the daemon starts.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export interface InteropEntry { name: string; mtimeMs: number; kind: 'socket' | 'link' | 'other' }

const readEntries = (dir: string): InteropEntry[] => readdirSync(dir).map((name) => {
  const s = lstatSync(join(dir, name));
  return { name, mtimeMs: s.mtimeMs, kind: s.isSocket() ? 'socket' : s.isSymbolicLink() ? 'link' : 'other' };
});

/** Sockets whose session process is alive, newest first. Skips the 1_interop link: it is the boot socket under another name. */
export function liveInteropSockets(o: { dir?: string; read?: (dir: string) => InteropEntry[]; pidAlive?: (pid: number) => boolean } = {}): string[] {
  const dir = o.dir ?? '/run/WSL';
  const pidAlive = o.pidAlive ?? ((pid) => existsSync(`/proc/${pid}`));
  let entries: InteropEntry[];
  try { entries = (o.read ?? readEntries)(dir); } catch { return []; } // no such directory: not WSL
  return entries
    .filter((e) => { const m = /^(\d+)_interop$/.exec(e.name); return !!m && e.kind === 'socket' && pidAlive(Number(m[1])); })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((e) => join(dir, e.name));
}

/** Walks WSL_INTEROP through the live sockets while the configured command keeps failing. */
export class InteropPicker {
  private tried = new Set<string>();
  constructor(private env: NodeJS.ProcessEnv = process.env, private list: () => string[] = liveInteropSockets) {}

  /** Moves to the next socket not yet tried in this stretch. Undefined at the end of a pass; the next call starts a new one. */
  next(): string | undefined {
    if (this.env.WSL_INTEROP) this.tried.add(this.env.WSL_INTEROP);
    const socket = this.list().find((s) => !this.tried.has(s));
    if (!socket) { this.tried.clear(); return undefined; }
    this.tried.add(socket);
    this.env.WSL_INTEROP = socket;
    return socket;
  }

  /** The command works: the socket in use is good, so the next failure starts afresh. */
  reset() { this.tried.clear(); }
}

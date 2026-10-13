import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** More than any board will ever clear; past it the oldest keys go (their registry files are long gone anyway). */
export const MAX_DISMISSED = 5000;

/**
 * Sessions the user cleared from the board (spec §5.1, UI round 4), by session key (`host:account:sessionId`).
 * Kept in the daemon's state.json (mode 0600, beside the config: `~/.config/clayclaude/state.json` by default) so a
 * cleared session stays hidden across restarts. Other keys in that file are kept as they are.
 */
export class DismissedStore {
  private keys: string[] = [];
  private set = new Set<string>();
  private max: number;
  /** Writes run one after another, so two quick clears cannot lose each other's keys. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private path: string, opts: { max?: number } = {}) {
    this.max = opts.max ?? MAX_DISMISSED;
    const st = readState(this.path);
    const list = Array.isArray(st.dismissed) ? st.dismissed.filter((k): k is string => typeof k === 'string') : [];
    this.keys = [...new Set(list)].slice(-this.max);
    this.set = new Set(this.keys);
  }

  has(key: string): boolean { return this.set.has(key); }

  /** Adds keys (already present ones keep their place) and saves. Resolves once the file is written. */
  add(keys: string[]): Promise<void> {
    for (const k of keys) if (!this.set.has(k)) { this.keys.push(k); this.set.add(k); }
    if (this.keys.length > this.max) { for (const k of this.keys.splice(0, this.keys.length - this.max)) this.set.delete(k); }
    return this.save();
  }

  /**
   * Un-clears keys (T39: a cleared session seen live again shows as a normal stopped row once it stops) and saves.
   * With nothing to remove it writes nothing and resolves once the writes already queued are done.
   */
  remove(keys: string[]): Promise<void> {
    const drop = keys.filter((k) => this.set.has(k));
    if (!drop.length) return this.chain;
    for (const k of drop) this.set.delete(k);
    this.keys = this.keys.filter((k) => this.set.has(k));
    return this.save();
  }

  private save(): Promise<void> {
    const snapshot = [...this.keys];
    const write = () => this.write(snapshot);
    this.chain = this.chain.then(write, write);
    return this.chain;
  }

  private write(dismissed: string[]): void { writeStateKey(this.path, 'dismissed', dismissed); }
}

/** state.json as an object; {} when it is missing, corrupt or not an object. */
export function readState(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/**
 * Sets one key of state.json, keeping the others (the cleared list and the board's nicknames share the file). The
 * whole read-modify-rename runs synchronously, so two stores in one daemon can never interleave and lose a key.
 */
export function writeStateKey(path: string, key: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  // A leftover tmp file (a crash), or a link someone planted there, is removed, and the new one is created
  // exclusively (O_EXCL never follows a link): the write can never land on another file.
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify({ ...readState(path), [key]: value }, null, 1) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(tmp, 0o600); // the mode above is masked by the umask
  renameSync(tmp, path);
}

import { EventEmitter } from 'node:events';
import { readState, writeStateKey } from './dismissed.js';
import type { Session } from './types.js';
import { fail, type Fail, type Result } from './actions/types.js';

/** Longest board nickname, in characters (code points). */
export const MAX_NICKNAME = 40;
/** More names than any board will ever hold; past it the oldest go. */
export const MAX_NICKNAMES = 1000;

/** Bidi embeddings, overrides and isolates: a U+202E in a name would show its text reversed and disguise it. */
const BIDI = /[\u202A-\u202E\u2066-\u2069]/u;
/** Control characters, and the line and paragraph separators, become spaces. */
const CONTROL = /[\p{Cc}\u2028\u2029]/gu;
/**
 * A character that shows something on its own (Task 42a): not white space, not a format or default-ignorable character
 * (zero-width spaces and joiners, the BOM, soft hyphen, Hangul fillers, variation selectors, tags), not a mark that
 * only decorates the character before it, and not the blank braille pattern.
 */
const VISIBLE = /[^\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Mn}\p{Me}\u2800]/u;

export type Cleaned = { ok: true; name: string } | { ok: false; message: string };

/**
 * A nickname as the board will show it: control characters become spaces, runs of space collapse, the ends are trimmed,
 * and it must then be 1 to MAX_NICKNAME characters with no direction override. HTML is left as text: the board escapes
 * every name where it reaches the DOM.
 */
export function cleanNickname(raw: unknown): Cleaned {
  if (typeof raw !== 'string') return { ok: false, message: 'A name must be text' };
  if (BIDI.test(raw)) return { ok: false, message: 'A name cannot contain text-direction override characters' };
  const name = raw.replace(CONTROL, ' ').replace(/\s+/gu, ' ').trim();
  const n = [...name].length;
  if (n < 1 || n > MAX_NICKNAME) return { ok: false, message: `A name must be 1 to ${MAX_NICKNAME} characters` };
  if (!VISIBLE.test(name)) return { ok: false, message: 'A name needs at least one visible character' };
  return { ok: true, name };
}

/**
 * Board nicknames (Task 41), by session key (`host:account:sessionId`, the key the cleared list uses), kept under
 * `nicknames` in the daemon's state.json beside it, with the same safe write. A nickname is the board's own: it never
 * reaches the session, its tmux window or Claude's own session name. With a null path it lives in memory (the demo).
 * Emits 'update' whenever a name changes, so the board gets the new state at once.
 */
export class NicknameStore extends EventEmitter {
  private names = new Map<string, string>();
  private max: number;
  /** Writes run one after another, so two quick renames cannot lose each other. */
  private chain: Promise<void> = Promise.resolve();

  constructor(private path: string | null, opts: { max?: number } = {}) {
    super();
    this.max = opts.max ?? MAX_NICKNAMES;
    const raw = path ? readState(path).nicknames : undefined;
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [k, v] of Object.entries(raw)) {
        const c = cleanNickname(v);
        if (c.ok && k.length <= 300) this.names.set(k, c.name);
      }
      this.trim();
    }
  }

  get(key: string): string | undefined { return this.names.get(key); }
  all(): Record<string, string> { return Object.fromEntries(this.names); }

  /**
   * Sets a name that has already passed cleanNickname, and saves. Resolves once the file is written. If the write
   * fails it rejects and the name is rolled back (Task 42a), unless a later change replaced it meanwhile.
   */
  set(key: string, name: string): Promise<void> {
    const prev = this.names.get(key);
    this.names.delete(key);   // to the end: the newest are kept past the cap
    this.names.set(key, name);
    this.trim();
    return this.save(() => {
      if (this.names.get(key) !== name) return;
      if (prev === undefined) this.names.delete(key); else this.names.set(key, prev);
    });
  }

  /** Drops the names of these keys (Reset, or the session was cleared). With none to drop it writes nothing. A failed write puts them back. */
  remove(keys: string[]): Promise<void> {
    const drop = keys.filter((k) => this.names.has(k)).map((k) => [k, this.names.get(k)!] as const);
    if (!drop.length) return this.chain;
    for (const [k] of drop) this.names.delete(k);
    return this.save(() => { for (const [k, v] of drop) if (!this.names.has(k)) this.names.set(k, v); });
  }

  /** The sessions as the board shows them: a nickname replaces `name`, and the session's own name moves to `derivedName`. */
  apply(list: Session[]): Session[] {
    if (!this.names.size) return list;
    return list.map((s) => {
      const nick = this.names.get(s.key);
      return nick === undefined ? s : { ...s, name: nick, derivedName: s.name };
    });
  }

  private trim() { for (const k of this.names.keys()) { if (this.names.size <= this.max) break; this.names.delete(k); } }

  /**
   * Writes the names as they are now, then tells listeners. A failed write tells nobody: `undo` rolls the change back in
   * memory (Task 42a), so the board never shows a name that is not saved, and the promise rejects.
   */
  private save(undo: () => void): Promise<void> {
    if (!this.path) { this.emit('update'); return this.chain; }
    const path = this.path, snapshot = this.all();
    const write = () => {
      try { writeStateKey(path, 'nicknames', snapshot); } catch (e) { undo(); throw e; }
      this.emit('update');
    };
    const done = this.chain.then(write, write);
    this.chain = done.catch(() => {});   // one failed write must not fail the ones queued after it
    return done;
  }
}

/**
 * A + New launch named on the tablet (Task 42a), once Claude registers its session: the name becomes the session's
 * board nickname, unless Claude already took it as its own name (`claude --name`), or the board has a name for it.
 * A name that cannot be saved is left: the session still shows under Claude's name.
 */
export async function adoptLaunchName(names: NicknameStore, l: { nickname?: string }, s: Session): Promise<void> {
  if (!l.nickname || l.nickname === s.name || names.get(s.key) !== undefined) return;
  await names.set(s.key, l.nickname).catch(() => {});
}

/**
 * The rename action (Task 41), shared with the demo: checks the name and sets or clears the nickname. Saving the
 * session's own name back is a Reset. Nothing reaches the session: no keys, no tmux rename.
 */
export async function renameIn(names: NicknameStore, s: Session | Fail | undefined, name: string | null): Promise<Result<{ message: string; name: string }>> {
  if (!s) return fail('unknown_session', 'that session is no longer listed');
  if ('ok' in s) return s;
  try {
    if (name === null) { await names.remove([s.key]); return { ok: true, message: `Name reset to ${s.name}`, name: s.name }; }
    const c = cleanNickname(name);
    if (!c.ok) return fail('bad_request', c.message);
    if (c.name === s.name) { await names.remove([s.key]); return { ok: true, message: `Name reset to ${s.name}`, name: s.name }; }
    await names.set(s.key, c.name);
    return { ok: true, message: `Renamed to ${c.name}`, name: c.name };
  } catch (e) { return fail('failed', `could not save the name: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`); }
}

/**
 * Memory and storage budgets for baked sheets (sized for a 3 GB Android Go tablet).
 * - Decoded sheets (ImageBitmaps) are capped at DECODED_BUDGET. Sheets a mounted character is
 *   showing are pinned and never evicted; unpinned ones go least recently used first.
 * - Stored sheets (IndexedDB, PNG) are capped at STORED_BUDGET. Other renderer versions go
 *   first, then least recently used.
 */
export const DECODED_BUDGET = 48 * 1024 * 1024;
export const STORED_BUDGET = 40 * 1024 * 1024;

interface Slot<T> { value: T; bytes: number; pins: number; used: number }

export class DecodedCache<T> {
  private m = new Map<string, Slot<T>>();
  private clock = 0;
  private total = 0;
  constructor(private budget: number, private free: (v: T) => void) {}

  get(key: string): T | undefined {
    const s = this.m.get(key);
    if (!s) return undefined;
    s.used = ++this.clock;
    return s.value;
  }
  has(key: string): boolean { return this.m.has(key); }
  set(key: string, value: T, bytes: number): void {
    const old = this.m.get(key);
    if (old) { this.total -= old.bytes; this.free(old.value); }
    this.m.set(key, { value, bytes, pins: old?.pins ?? 0, used: ++this.clock });
    this.total += bytes;
    this.evict(key); // never the sheet just loaded: its sprite has not pinned it yet
  }
  pin(key: string): void { const s = this.m.get(key); if (s) s.pins++; }
  unpin(key: string): void { const s = this.m.get(key); if (s && s.pins > 0) { s.pins--; this.evict(); } }
  get bytes(): number { return this.total; }
  keys(): string[] { return [...this.m.keys()]; }
  /** Drop least-recently-used unpinned entries (except `keep`) until the total fits the budget. */
  private evict(keep?: string): void {
    if (this.total <= this.budget) return;
    const free = [...this.m.entries()].filter(([k, s]) => s.pins === 0 && k !== keep).sort((a, b) => a[1].used - b[1].used);
    for (const [k, s] of free) {
      if (this.total <= this.budget) break;
      this.m.delete(k);
      this.total -= s.bytes;
      this.free(s.value);
    }
  }
  /** Remove an entry without freeing its value (it may already be unusable). */
  delete(key: string): void { const s = this.m.get(key); if (s) { this.m.delete(key); this.total -= s.bytes; } }
  clear(): void { for (const s of this.m.values()) this.free(s.value); this.m.clear(); this.total = 0; }
}

export interface StoredEntry { key: string; bytes: number; lastUsed: number; version: string }

/** Keys to delete from storage: every other version, then least recently used until under budget. Pure. */
export function planEviction(entries: StoredEntry[], version: string, budget: number): string[] {
  const drop = entries.filter((e) => e.version !== version).map((e) => e.key);
  const keep = entries.filter((e) => e.version === version).sort((a, b) => a.lastUsed - b.lastUsed);
  let total = keep.reduce((n, e) => n + e.bytes, 0);
  for (const e of keep) {
    if (total <= budget) break;
    drop.push(e.key);
    total -= e.bytes;
  }
  return drop;
}

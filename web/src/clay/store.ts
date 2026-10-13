import { planEviction, STORED_BUDGET, type StoredEntry } from './budget.js';

/** Persistent sheets keyed by `keyString(SheetKey)`, plus small JSON records (the Auto choice). */
export interface SheetStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, png: Blob, version: string): Promise<void>;
  keys(): Promise<string[]>;
  /** Drop other versions, then least-recently-used sheets over the budget. */
  prune(version: string, budget?: number): Promise<void>;
  getRecord<T>(name: string): Promise<T | null>;
  putRecord(name: string, value: unknown): Promise<void>;
  close(): void;
}

/** In-memory store: used when IndexedDB is unavailable and in tests. */
export class MemoryStore implements SheetStore {
  private m = new Map<string, StoredEntry & { png: Blob }>();
  private recs = new Map<string, unknown>();
  private clock = 0;
  async get(key: string) { const e = this.m.get(key); if (!e) return null; e.lastUsed = ++this.clock; return e.png; }
  async put(key: string, png: Blob, version: string) { this.m.set(key, { key, png, bytes: png.size, lastUsed: ++this.clock, version }); }
  async keys() { return [...this.m.keys()]; }
  async prune(version: string, budget = STORED_BUDGET) { for (const k of planEviction([...this.m.values()], version, budget)) this.m.delete(k); }
  async getRecord<T>(name: string) { return (this.recs.get(name) as T) ?? null; }
  async putRecord(name: string, value: unknown) { this.recs.set(name, value); }
  close() {}
}

const DB = 'clayclaude-clay';
const req = <T>(r: IDBRequest<T>): Promise<T> => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });

/**
 * IndexedDB: `sheets` (key -> PNG Blob), `meta` (key -> {bytes, lastUsed, version}) and `records`
 * (name -> JSON). Reading a sheet rewrites only its small meta row.
 */
export async function openIdbStore(idb: IDBFactory = indexedDB): Promise<SheetStore> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const open = idb.open(DB, 1);
    open.onupgradeneeded = () => {
      open.result.createObjectStore('sheets');
      open.result.createObjectStore('meta', { keyPath: 'key' });
      open.result.createObjectStore('records');
    };
    open.onsuccess = () => res(open.result);
    open.onerror = () => rej(open.error);
    open.onblocked = () => rej(new Error('IndexedDB blocked'));
  });
  return {
    async get(key) {
      const tx = db.transaction(['sheets', 'meta'], 'readwrite');
      const png = (await req(tx.objectStore('sheets').get(key))) as Blob | undefined;
      if (png) {
        const meta = (await req(tx.objectStore('meta').get(key))) as StoredEntry | undefined;
        if (meta) tx.objectStore('meta').put({ ...meta, lastUsed: Date.now() });
      }
      await done(tx);
      return png ?? null;
    },
    async put(key, png, version) {
      const tx = db.transaction(['sheets', 'meta'], 'readwrite');
      tx.objectStore('sheets').put(png, key);
      tx.objectStore('meta').put({ key, bytes: png.size, lastUsed: Date.now(), version } satisfies StoredEntry);
      await done(tx);
    },
    async keys() { return (await req(db.transaction('meta').objectStore('meta').getAllKeys())) as string[]; },
    async prune(version, budget = STORED_BUDGET) {
      const entries = (await req(db.transaction('meta').objectStore('meta').getAll())) as StoredEntry[];
      const drop = planEviction(entries, version, budget);
      if (!drop.length) return;
      const tx = db.transaction(['sheets', 'meta'], 'readwrite');
      for (const k of drop) { tx.objectStore('sheets').delete(k); tx.objectStore('meta').delete(k); }
      await done(tx);
    },
    async getRecord<T>(name: string) { return ((await req(db.transaction('records').objectStore('records').get(name))) as T) ?? null; },
    async putRecord(name, value) { const tx = db.transaction('records', 'readwrite'); tx.objectStore('records').put(value, name); await done(tx); },
    close() { db.close(); },
  };
}

/** IndexedDB if it opens, else memory. Never throws. */
export async function openStore(): Promise<SheetStore> {
  try { return await openIdbStore(); } catch { return new MemoryStore(); }
}

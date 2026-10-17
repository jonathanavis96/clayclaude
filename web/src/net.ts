import type { Fail, Result } from '../../src/actions/types.js';

export type Fetch = typeof fetch;

const netFail = (message: string): Fail => ({ ok: false, error: 'failed', message });

/** POST an action. The browser adds Origin; the header and JSON type are what the daemon requires of every write. */
export async function postAction<T extends object = object>(body: object, f: Fetch = fetch): Promise<Result<T>> {
  try {
    const r = await f('/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clayclaude': '1' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    if (j && typeof j === 'object' && 'ok' in j) return j as Result<T>;
    return netFail(`unexpected reply (${r.status})`);
  } catch {
    return netFail('Cannot reach the daemon. Is the tablet still connected?');
  }
}

export async function getJson<T>(path: string, f: Fetch = fetch): Promise<T | null> {
  try {
    const r = await f(path, { headers: { 'x-clayclaude': '1' } });
    return r.ok || r.status < 500 ? ((await r.json()) as T) : null;
  } catch { return null; }
}

/** POST JSON to a daemon route other than /api/action; null when the daemon is unreachable or the reply is not JSON. */
export async function postJson<T>(path: string, body: object, f: Fetch = fetch): Promise<T | null> {
  try {
    const r = await f(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-clayclaude': '1' }, body: JSON.stringify(body) });
    return (await r.json()) as T;
  } catch { return null; }
}

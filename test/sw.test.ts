import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// The board's service worker (web/public/sw.js). Chrome sends a navigation that a service worker re-fetches with
// Sec-Fetch-Dest: empty, and the request guard lets a cross-site navigation (an Android VIEW intent: kiosk, hotkey,
// open-url) through only as a document. So navigations must reach the network without the worker.
const src = readFileSync(new URL('../web/public/sw.js', import.meta.url), 'utf8');

function load() {
  const listeners: Record<string, (e: unknown) => void> = {};
  const fetched: unknown[] = [];
  const self = { addEventListener: (t: string, f: (e: unknown) => void) => { listeners[t] = f; }, skipWaiting: () => {}, clients: { claim: async () => {} } };
  runInNewContext(src, { self, fetch: (r: unknown) => { fetched.push(r); return Promise.resolve('net'); } });
  const dispatch = (request: { mode: string; url: string }) => {
    let responded = false;
    listeners.fetch({ request, respondWith: () => { responded = true; } });
    return responded;
  };
  return { listeners, fetched, dispatch };
}

describe('service worker', () => {
  it('leaves navigations to the browser, so they reach the server as documents', () => {
    const { dispatch, fetched } = load();
    for (const url of ['http://localhost:8420/', 'http://localhost:8420/clay-lab.html?view=gallery'])
      expect(dispatch({ mode: 'navigate', url })).toBe(false);
    expect(fetched).toEqual([]);
  });
  it('still answers other requests from the network, and installs and claims at once', () => {
    const { dispatch, fetched, listeners } = load();
    expect(dispatch({ mode: 'cors', url: 'http://localhost:8420/api/state' })).toBe(true);
    expect(dispatch({ mode: 'no-cors', url: 'http://localhost:8420/assets/x.js' })).toBe(true);
    expect(fetched).toHaveLength(2);
    expect(Object.keys(listeners).sort()).toEqual(['activate', 'fetch', 'install']);
  });
  it('never caches: no Cache Storage, so it can never serve an old bundle to an open tab (Task 32)', () => {
    expect(src).not.toMatch(/\bcaches\b|cache\.put|respondWith\(\s*caches/);
  });
});

// Release QA round 2, security track: written before its fix.
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { UsagePoller } from '../src/usage.js';

const httpCfg = (url: string) => parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: w, label: W, colour: "#4fd1c5", host: local, configDir: /c/w, usage: {provider: http, url: "${url}", key: work}}
`);

describe('usage http provider: no URL secrets in the log', () => {
  const url = 'https://dash.example.test/usage?token=SECRET-QUERY-1';
  const run = async (fetchFn: unknown) => {
    const logs: string[] = [];
    const p = new UsagePoller(httpCfg(url), { probe: async () => ({ ok: true, accounts: [] }), fetchFn: fetchFn as typeof fetch, log: (m) => logs.push(m) });
    await p.pollOnce();
    return logs.join('\n');
  };
  it('an HTTP error status', async () => {
    const log = await run(async () => new Response('', { status: 500 }));
    expect(log).toContain('HTTP 500');
    expect(log).not.toContain('SECRET-QUERY-1');
  });
  it('a 429', async () => {
    const log = await run(async () => new Response('', { status: 429 }));
    expect(log).toContain('429');
    expect(log).not.toContain('SECRET-QUERY-1');
  });
  it('a fetch error that quotes the URL', async () => {
    const log = await run(async (u: string) => { throw new TypeError(`fetch failed for ${u}`); });
    expect(log).toContain('fetch failed');
    expect(log).not.toContain('SECRET-QUERY-1');
  });
  it('a missing key', async () => {
    const log = await run(async () => new Response('{}'));
    expect(log).not.toContain('SECRET-QUERY-1');
  });
  // fetch() refuses a URL with credentials and quotes the whole URL, password included, in its error.
  it('refuses a URL with a user name or password at config load', () => {
    expect(() => httpCfg('https://me:SECRET-PW@dash.example.test/usage')).toThrow(/user name or password/);
    expect(() => httpCfg('https://me@dash.example.test/usage')).toThrow(/user name or password/);
    expect(() => httpCfg('https://dash.example.test/usage')).not.toThrow();
  });
});

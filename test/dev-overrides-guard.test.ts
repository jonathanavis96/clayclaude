import { describe, it, expect, afterEach } from 'vitest';
import { createServer, request, type Server } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { overridesHandler } from '../web/clay-overrides-plugin.js';

// The pose editor's Save endpoint on the Vite dev server writes web/src/clay/overrides.json. A form or a no-cors
// fetch on any other site can POST a JSON-shaped text/plain body without a preflight, so the endpoint takes writes
// from the editor's own origin only.
describe('dev Save endpoint: same origin only', () => {
  let srv: Server | undefined;
  afterEach(() => new Promise<void>((r) => (srv ? srv.close(() => r()) : r())));

  async function start() {
    const file = join(mkdtempSync(join(tmpdir(), 'cc-ovr-')), 'overrides.json');
    writeFileSync(file, '{}\n');
    srv = createServer((req, res) => overridesHandler(file)(req, res, () => { res.statusCode = 404; res.end(); }));
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    return { file, port: (srv.address() as { port: number }).port };
  }
  const post = (port: number, headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
    const body = JSON.stringify({ W2: { pose: { mouthOpen: 0.2 } } });
    const r = request({ host: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'content-type': 'text/plain', ...headers } }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    r.on('error', reject); r.end(body);
  });

  it('refuses a cross-origin or cross-site POST and leaves the file alone', async () => {
    const { file, port } = await start();
    const host = `127.0.0.1:${port}`;
    expect(await post(port, { host, origin: 'https://evil.example' })).toBe(403);
    expect(await post(port, { host, origin: 'http://127.0.0.1:1' })).toBe(403);
    expect(await post(port, { host, origin: 'null' })).toBe(403);
    expect(await post(port, { host, 'sec-fetch-site': 'cross-site' })).toBe(403);
    expect(await post(port, { host, 'sec-fetch-site': 'same-site' })).toBe(403);
    expect(readFileSync(file, 'utf8')).toBe('{}\n');
  });
  it('takes the editor\'s own same-origin Save', async () => {
    const { file, port } = await start();
    const host = `127.0.0.1:${port}`;
    expect(await post(port, { host, origin: `http://${host}`, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' })).toBe(200);
    expect(readFileSync(file, 'utf8')).toContain('mouthOpen');
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { connect } from 'node:net';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';

const cfgText = `
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]
`;
class FakeCollector extends EventEmitter { sessions() { return []; } }
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return {}; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

/** Sends bytes exactly as written (no client-side path normalisation) and returns the raw response. */
const rawHttp = (port: number, text: string) => new Promise<string>((resolve, reject) => {
  const s = connect(port, '127.0.0.1');
  let out = '';
  s.on('data', (c) => (out += c)); s.on('end', () => resolve(out)); s.on('error', reject);
  s.write(text);
});

describe('static files: path traversal', () => {
  it('never serves a file outside the web root, however the path is spelled', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'cc-trav-'));
    const web = join(parent, 'dist');
    mkdirSync(web); mkdirSync(web + '-evil');
    writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
    writeFileSync(join(parent, 'secret.txt'), 'TOPSECRET');
    writeFileSync(join(web + '-evil', 'x.txt'), 'TOPSECRET');
    const s = await startServer({ cfg: parseConfig(cfgText), collector: new FakeCollector() as any, usage: new FakeUsage() as any, webRoot: web, port: 0 });
    close = s.close;
    const paths = ['/../secret.txt', '/%2e%2e/secret.txt', '/%2e%2e%2fsecret.txt', '/%252e%252e/secret.txt', '/..%5csecret.txt',
      '/%5c..%5csecret.txt', '/..\\secret.txt', '/.%2e/secret.txt', '/%2E%2E/secret.txt', '/%c0%ae%c0%ae/secret.txt',
      `/../${basename(web)}-evil/x.txt`, `/%2e%2e/${basename(web)}-evil/x.txt`, `/${encodeURIComponent(join(parent, 'secret.txt'))}`,
      `//${parent.slice(1)}/secret.txt`, '/index.html%00.txt', '/%00', '/..%00/secret.txt'];
    for (const p of paths) {
      const r = await rawHttp(s.port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
      expect(r, p).not.toContain('TOPSECRET');
      expect(r.split('\r\n')[0], p).not.toContain(' 200 ');
    }
    expect(await rawHttp(s.port, 'GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n')).toContain('<h1>board</h1>');
  });
});

async function boot() {
  const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  const s = await startServer({ cfg: parseConfig(cfgText), collector: new FakeCollector() as any, usage: new FakeUsage() as any, webRoot: web, port: 0 });
  close = s.close;
  return s.port;
}
const wsStatus = (port: number, origin: string) => new Promise<number>((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin } });
  ws.on('unexpected-response', (_q, res) => { res.resume(); resolve(res.statusCode!); });
  ws.on('open', () => { ws.close(); resolve(101); });
  ws.on('error', () => resolve(-1));
});

describe('cross-origin reads from another local port', () => {
  it('refuses a websocket whose Origin is a page on another port of an allowed host', async () => {
    const port = await boot();
    // A page served by any other local web server (a dev server, a downloaded repo's preview) must not read the board.
    for (const origin of ['http://localhost:3000', `http://127.0.0.1:${port + 1}`, 'http://[::1]:8080'])
      expect(await wsStatus(port, origin), origin).toBe(403);
    expect(await wsStatus(port, `http://127.0.0.1:${port}`)).toBe(101);
  });
  it('refuses a GET whose Origin is a page on another port of an allowed host', async () => {
    const port = await boot();
    const r = await rawHttp(port, `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:3000\r\nConnection: close\r\n\r\n`);
    expect(r.split('\r\n')[0]).toContain(' 403 ');
    const ok = await rawHttp(port, `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    expect(ok.split('\r\n')[0]).toContain(' 200 ');
  });
});

describe('framing', () => {
  it('forbids framing the board, so a page on another local port cannot clickjack its buttons', async () => {
    const port = await boot();
    // Sec-Fetch-Site only stops cross-site frames; http://localhost:3000 framing http://localhost:<port> is same-site.
    const r = await rawHttp(port, `GET / HTTP/1.1\r\nHost: localhost:${port}\r\nSec-Fetch-Site: same-site\r\nSec-Fetch-Dest: iframe\r\nConnection: close\r\n\r\n`);
    const head = r.split('\r\n\r\n')[0].toLowerCase();
    expect(head).toContain('x-frame-options: deny');
    expect(head).toContain("frame-ancestors 'none'");
    expect(head).toContain('x-content-type-options: nosniff');
  });
});

describe('websocket input', () => {
  it('closes a client that sends a large frame instead of buffering it (the board never sends anything)', async () => {
    const port = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: `http://127.0.0.1:${port}` });
    await new Promise<void>((r) => ws.on('open', () => r()));
    const code = await new Promise<number>((r) => { ws.on('close', (c) => r(c)); ws.send(Buffer.alloc(1024 * 1024)); });
    expect(code).toBe(1009); // message too big
  });
});

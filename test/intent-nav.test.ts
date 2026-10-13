import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';

// The request guard, end to end through the real server: Chrome on Android marks a page opened by a VIEW intent
// (kiosk launch, the hotkey, `tablet.sh open-url`) cross-site, so the guard must let a top-level navigation to
// one of the app's own pages through, and nothing else from another site.
const cfgText = `
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]
`;
class FakeCollector extends EventEmitter { sessions() { return []; } }
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return {}; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function serve() {
  const web = mkdtempSync(join(tmpdir(), 'cc-intent-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  writeFileSync(join(web, 'clay-lab.html'), '<h1>lab</h1>');
  mkdirSync(join(web, 'assets')); writeFileSync(join(web, 'assets', 'x.js'), 'x');
  // Stand-ins for the clay routes (src/clay/routes.ts): `/gallery` redirects to the lab, `/clay/*` and `/__clay/*` answer.
  const clay = (req: IncomingMessage, res: ServerResponse, url: URL) => {
    if (url.pathname === '/gallery' && req.method === 'GET') { res.writeHead(302, { location: '/clay-lab.html?view=gallery' }); res.end(); return true; }
    if (url.pathname.startsWith('/clay/') || url.pathname.startsWith('/__clay/')) { res.writeHead(200); res.end('clay'); return true; }
    return false;
  };
  const s = await startServer({ cfg: parseConfig(cfgText), collector: new FakeCollector() as any, usage: new FakeUsage() as any, webRoot: web, port: 0, handlers: [clay] });
  close = s.close;
  return s.port;
}

const hit = (port: number, path: string, method: string, headers: Record<string, string>) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const r = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
    let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
  });
  r.on('error', reject); r.end();
});

// What Chrome 131 on Android sent for `am start -a VIEW -d http://127.0.0.1:<port>/` (measured on the test tablet).
const intent = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document', 'sec-fetch-user': '?1', accept: 'text/html' };

describe('cross-site top-level navigations (Android intents)', () => {
  const refused = { status: 403, body: JSON.stringify({ ok: false, error: 'forbidden', message: 'cross-site request refused' }) };
  it("serves the app's own pages to a GET or HEAD navigation: /, a static .html page, /gallery", async () => {
    const port = await serve();
    expect(await hit(port, '/', 'GET', intent)).toEqual({ status: 200, body: '<h1>board</h1>' });
    expect(await hit(port, '/index.html', 'GET', intent)).toEqual({ status: 200, body: '<h1>board</h1>' });
    expect(await hit(port, '/clay-lab.html?view=gallery', 'GET', intent)).toEqual({ status: 200, body: '<h1>lab</h1>' });
    expect(await hit(port, '/gallery', 'GET', intent)).toMatchObject({ status: 302 });
    for (const path of ['/', '/index.html', '/clay-lab.html']) expect((await hit(port, path, 'HEAD', intent)).status).toBe(200);
    expect((await hit(port, '/gallery', 'HEAD', intent)).status).not.toBe(403);
  });
  it('refuses a navigation to anything else: the API, usage, health, the clay routes, auth, static assets, a missing page', async () => {
    const port = await serve();
    for (const path of ['/api/state', '/usage', '/healthz', '/clay/sheet?account=me&kind=idle', '/clay/status', '/__clay/overrides', '/auth', '/assets/x.js', '/missing.html', '/ws'])
      for (const method of ['GET', 'HEAD']) expect((await hit(port, path, method, intent)).status, `${method} ${path}`).toBe(403);
    expect(await hit(port, '/api/state', 'GET', intent)).toEqual(refused);
  });
  it('refuses a cross-site frame, embed or object, a cross-site POST navigation, and cross-site fetches', async () => {
    const port = await serve();
    for (const dest of ['iframe', 'embed', 'object']) for (const path of ['/', '/clay-lab.html'])
      expect(await hit(port, path, 'GET', { ...intent, 'sec-fetch-dest': dest })).toEqual(refused);
    for (const path of ['/', '/api/action', '/auth'])
      expect(await hit(port, path, 'POST', { ...intent, origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' })).toEqual(refused);
    for (const mode of ['cors', 'no-cors'])
      expect(await hit(port, '/api/state', 'GET', { ...intent, 'sec-fetch-mode': mode, 'sec-fetch-dest': 'empty' })).toEqual(refused);
  });
  it('refuses a websocket from another site', async () => {
    const port = await serve();
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'websocket', 'sec-fetch-dest': 'websocket' } });
      ws.on('unexpected-response', (_req, res) => { resolve(res.statusCode ?? 0); ws.terminate(); });
      ws.on('open', () => { resolve(101); ws.close(); });
      ws.on('error', () => {});
    });
    expect(status).toBe(403);
  });
});

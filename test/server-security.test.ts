import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { networkInterfaces } from 'node:os';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { generateToken } from '../src/security.js';

const TOKEN = generateToken();
const base = `
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]
`;
class FakeCollector extends EventEmitter { sessions() { return [{ key: 'k', state: 'working' }]; } }
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return {}; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function boot(lan: boolean) {
  const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  const cfg = parseConfig(base + (lan ? `lan: {enabled: true, token: "${TOKEN}", hosts: ["${lanIp}"]}\n` : ''));
  const s = await startServer({ cfg, collector: new FakeCollector() as any, usage: new FakeUsage() as any, webRoot: web, port: 0,
    handlers: [(req, res, url) => { if (url.pathname === '/api/action') { res.writeHead(200); res.end('did it'); return true; } return false; }] });
  close = s.close;
  return s.port;
}
const raw = (port: number, o: { host?: string; origin?: string; method?: string; path?: string; address?: string; headers?: Record<string, string> }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const r = request({ host: o.address ?? '127.0.0.1', port, path: o.path ?? '/api/state', method: o.method ?? 'GET',
      headers: { ...(o.host ? { host: o.host } : {}), ...(o.origin ? { origin: o.origin } : {}), ...o.headers } }, (res) => {
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject); r.end();
  });
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

const ACTION = '/api/action';
const json = { 'content-type': 'application/json', 'x-clayclaude': '1' };

describe('server security (loopback mode)', () => {
  it('serves loopback requests', async () => {
    const port = await boot(false);
    expect((await raw(port, {})).status).toBe(200);
  });
  it('refuses a rebinding Host name before any handler runs', async () => {
    const port = await boot(false);
    for (const host of ['evil.example', `evil.example:${port}`, `localhost.evil.example:${port}`]) {
      const r = await raw(port, { host, method: 'POST', path: ACTION, origin: `http://${host}`, headers: json });
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('did it');
    }
  });
  it('action routes refuse a cross-origin POST, a POST with no Origin, and a mismatched Origin', async () => {
    const port = await boot(false);
    const post = (origin?: string) => raw(port, { method: 'POST', path: ACTION, origin, headers: json });
    for (const origin of ['https://evil.example', 'http://localhost:' + port, 'null', undefined]) {
      const r = await post(origin);
      expect(r.status).toBe(403);
      expect(r.body).not.toContain('did it');
    }
    expect((await post(`http://127.0.0.1:${port}`)).body).toBe('did it');
  });
  it('sends no CORS headers and does not answer preflights', async () => {
    const port = await boot(false);
    const r = await new Promise<{ status: number; acao?: string }>((resolve, reject) => {
      const q = request({ host: '127.0.0.1', port, path: ACTION, method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } },
        (res) => { res.resume(); resolve({ status: res.statusCode!, acao: res.headers['access-control-allow-origin'] as string | undefined }); });
      q.on('error', reject); q.end();
    });
    expect(r.status).toBe(403);
    expect(r.acao).toBeUndefined();
  });
  it('refuses a websocket upgrade from a foreign origin or Host, accepts the board\'s own', async () => {
    const port = await boot(false);
    const bad = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: 'http://evil.example' } });
    await new Promise<void>((r) => { bad.on('error', () => r()); bad.on('open', () => r()); });
    expect(bad.readyState).not.toBe(WebSocket.OPEN);
    const rebind = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { host: 'evil.example' } });
    await new Promise<void>((r) => { rebind.on('error', () => r()); rebind.on('open', () => r()); });
    expect(rebind.readyState).not.toBe(WebSocket.OPEN);
    const good = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { origin: `http://127.0.0.1:${port}` } });
    await new Promise<void>((r) => good.on('open', () => r()));
    good.close();
  });
  it('/api/state never contains a token', async () => {
    const port = await boot(false);
    expect((await raw(port, {})).body).not.toMatch(/token/i);
  });
});

describe.skipIf(!lanIp)('server security (LAN mode)', () => {
  it('requires the token from a LAN client on every route, and only on a configured host name', async () => {
    const port = await boot(true);
    const lanReq = (o: object) => raw(port, { address: lanIp, host: `${lanIp}:${port}`, ...o });
    expect((await lanReq({})).status).toBe(401);
    expect((await lanReq({ path: '/' })).status).toBe(401);
    expect((await lanReq({ path: '/healthz' })).status).toBe(401);
    expect((await lanReq({ headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await lanReq({ host: `other.example:${port}`, headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(403);
    const page = await lanReq({ path: '/', headers: { accept: 'text/html' } });
    expect(page.status).toBe(401);
    expect(page.body).toContain('access token');
    expect(page.body).not.toContain(TOKEN);
    expect((await raw(port, {})).status).toBe(200);
  });
  it('a LAN action POST needs the token and a matching Origin', async () => {
    const port = await boot(true);
    const origin = `http://${lanIp}:${port}`;
    const post = (h: Record<string, string>, o?: string) => raw(port, { address: lanIp, host: `${lanIp}:${port}`, method: 'POST', path: ACTION, origin: o, headers: { ...json, ...h } });
    expect((await post({}, origin)).status).toBe(401);
    expect((await post({ authorization: `Bearer ${TOKEN}` })).status).toBe(403);
    expect((await post({ authorization: `Bearer ${TOKEN}` }, 'https://evil.example')).status).toBe(403);
    expect((await post({ authorization: `Bearer ${TOKEN}` }, origin)).body).toBe('did it');
  });
  it('rejects a LAN websocket without the token', async () => {
    const port = await boot(true);
    const ws = new WebSocket(`ws://${lanIp}:${port}/ws`);
    await new Promise<void>((r) => { ws.on('error', () => r()); ws.on('open', () => r()); });
    expect(ws.readyState).not.toBe(WebSocket.OPEN);
    const ok = new WebSocket(`ws://${lanIp}:${port}/ws`, { headers: { authorization: `Bearer ${TOKEN}` } });
    await new Promise<void>((r) => ok.on('open', () => r()));
    ok.close();
  });
  it('refuses a LAN websocket with a malformed token cookie and keeps serving', async () => {
    const port = await boot(true);
    const ws = new WebSocket(`ws://${lanIp}:${port}/ws`, { headers: { cookie: 'cc_token=%E0%A4%A' } });
    const status = await new Promise<number | undefined>((r) => {
      ws.on('unexpected-response', (_q, res) => { res.resume(); r(res.statusCode); });
      ws.on('error', () => r(undefined)); ws.on('open', () => r(-1));
    });
    expect(status).toBe(401);
    expect((await raw(port, {})).status).toBe(200);
    const page = await raw(port, { address: lanIp, host: `${lanIp}:${port}`, headers: { cookie: 'cc_token=%E0%A4%A' } });
    expect(page.status).toBe(401);
  });
});

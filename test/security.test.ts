import { describe, it, expect } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Guard, appPages, generateToken, isLoopback, sessionValue, tokenEqual } from '../src/security.js';

const TOKEN = generateToken();
const mk = (lan: { enabled: boolean; token?: string; hosts?: string[] }) => { return new Guard({ lan }); };
const off = mk({ enabled: false });
const lan = mk({ enabled: true, token: TOKEN, hosts: ['192.168.1.2', 'pc.local'] });
// A web root holding the app's pages, as web/dist does (a page in a subdirectory is not one of them).
const web = mkdtempSync(join(tmpdir(), 'cc-guard-'));
for (const f of ['index.html', 'clay-lab.html', 'clay-bake.html', 'sw.js', 'icon.svg']) writeFileSync(join(web, f), '');
mkdirSync(join(web, 'assets')); writeFileSync(join(web, 'assets', 'index.html'), ''); writeFileSync(join(web, 'assets', 'x.js'), '');
const offWeb = new Guard({ lan: { enabled: false }, webRoot: web });
const lanWeb = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, webRoot: web });
const req = (o: { addr?: string; host?: string; origin?: string; method?: string; headers?: Record<string, string> } = {}) =>
  ({ socket: { remoteAddress: o.addr ?? '127.0.0.1' }, headers: { host: o.host ?? '127.0.0.1:8420', ...(o.origin ? { origin: o.origin } : {}), ...o.headers }, method: o.method ?? 'GET' }) as any;

describe('appPages', () => {
  it('lists the top-level .html files once and re-reads the web root only after a few seconds, not per request', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-pages-'));
    writeFileSync(join(dir, 'a.html'), ''); mkdirSync(join(dir, 'sub.html')); writeFileSync(join(dir, 'x.js'), '');
    expect(appPages(dir, 1000)).toEqual(new Set(['a.html']));
    writeFileSync(join(dir, 'b.html'), '');
    expect(appPages(dir, 5000)).toEqual(new Set(['a.html']));            // cached: a rebuild shows up a little later
    expect(appPages(dir, 12_000)).toEqual(new Set(['a.html', 'b.html']));
    expect(appPages(join(dir, 'missing'), 1000)).toEqual(new Set());
  });
});

describe('Guard host allowlist', () => {
  it('accepts loopback names on any port (the Vite dev proxy forwards its own) and refuses everything else', () => {
    for (const h of ['127.0.0.1:8420', 'localhost:8420', 'LOCALHOST:8420', '[::1]:8420', '127.0.0.1', 'localhost:5173']) expect(off.check(req({ host: h }), 'http').ok).toBe(true);
    for (const h of ['evil.example:8420', 'localhost.evil.example:8420', '0.0.0.0:8420', '', '127.0.0.1.evil.example']) expect(off.check(req({ host: h }), 'http')).toMatchObject({ ok: false, status: 403 });
  });
  it('extends the allowlist to the configured LAN hosts only when LAN is on, never to a wildcard', () => {
    const lanReq = (host: string, headers?: Record<string, string>) => req({ addr: '192.168.1.5', host, headers: { authorization: `Bearer ${TOKEN}`, ...headers } });
    expect(lan.check(lanReq('192.168.1.2:8420'), 'http')).toEqual({ ok: true, via: 'token' });
    expect(lan.check(lanReq('pc.local:8420'), 'http').ok).toBe(true);
    expect(lan.check(lanReq('192.168.1.99:8420'), 'http')).toMatchObject({ ok: false, status: 403 });
    expect(lan.check(lanReq('evil.example:8420'), 'http')).toMatchObject({ ok: false, status: 403 });
    expect(off.allowedHosts().has('192.168.1.2')).toBe(false);
  });
});

describe('Guard origin rules', () => {
  it('requires a matching Origin on every write, with no exceptions', () => {
    const post = (origin?: string) => off.check(req({ method: 'POST', origin }), 'http');
    expect(post()).toMatchObject({ ok: false, status: 403, reason: 'Origin header required' });
    expect(post('https://evil.example')).toMatchObject({ ok: false, status: 403 });
    expect(post('http://localhost:8420')).toMatchObject({ ok: false, status: 403 });   // a local page, but not the page this Host serves
    expect(post('http://127.0.0.1:5173')).toMatchObject({ ok: false, status: 403 });
    expect(post('null')).toMatchObject({ ok: false, status: 403 });
    expect(post('http://127.0.0.1:8420')).toEqual({ ok: true, via: 'loopback' });
    for (const m of ['PUT', 'PATCH', 'DELETE']) expect(off.check(req({ method: m }), 'http')).toMatchObject({ ok: false, status: 403 });
  });
  it('lets plain reads through without Origin or with their own Origin, but refuses a read from any other origin', () => {
    expect(off.check(req(), 'http').ok).toBe(true);
    expect(off.check(req({ origin: 'http://127.0.0.1:8420' }), 'http').ok).toBe(true);
    expect(off.check(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), 'http').ok).toBe(true); // Vite dev proxy keeping Host
    expect(off.check(req({ origin: 'http://localhost:5173' }), 'http')).toMatchObject({ ok: false, status: 403 });
    expect(off.check(req({ origin: 'http://localhost:8420' }), 'http')).toMatchObject({ ok: false, status: 403 });
    expect(off.check(req({ origin: 'https://evil.example' }), 'http')).toMatchObject({ ok: false, status: 403 });
  });
  it('refuses anything Chrome marks cross-site, even a GET with no Origin (an <img> or <script> from another site)', () => {
    expect(off.check(req({ headers: { 'sec-fetch-site': 'cross-site' } }), 'http')).toMatchObject({ ok: false, status: 403 });
    expect(off.check(req({ headers: { 'sec-fetch-site': 'cross-site' } }), 'ws')).toMatchObject({ ok: false, status: 403 });
    for (const v of ['same-origin', 'none']) expect(off.check(req({ headers: { 'sec-fetch-site': v } }), 'http').ok).toBe(true);
  });
  it("lets a top-level document navigation to one of the app's own HTML pages through although Chrome marks it cross-site (an Android VIEW intent: kiosk, hotkey, open-url)", () => {
    // Chrome 131 on Android sends exactly these headers for `am start -a VIEW -d http://localhost:<port>/#kiosk` (measured 2026-10-12).
    const nav = { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
    const r = (o: { url?: string; method?: string; headers?: Record<string, string>; origin?: string }) => ({ ...req({ method: o.method, headers: o.headers, origin: o.origin }), url: o.url ?? '/' });
    // The pages: `/`, a static .html page that exists in the web root (query ignored), and `/gallery` (a redirect to the lab).
    for (const g of [off, offWeb]) for (const method of ['GET', 'HEAD']) for (const url of ['/', '/?x=1', '/gallery', '/gallery?x=1'])
      expect(g.check(r({ method, url, headers: nav }), 'http')).toEqual({ ok: true, via: 'loopback' });
    for (const method of ['GET', 'HEAD']) for (const url of ['/index.html', '/clay-lab.html', '/clay-lab.html?view=gallery', '/clay-bake.html'])
      expect(offWeb.check(r({ method, url, headers: nav }), 'http')).toEqual({ ok: true, via: 'loopback' });
    // Nothing else: the API, usage, health, the PC baker and dev endpoints, auth, static assets, an .html page that is
    // not there, one in a subdirectory, an encoded or traversing path, and every .html page when no web root is known.
    const refused = { ok: false, status: 403, reason: 'cross-site request refused' };
    for (const url of ['/api/state', '/api/action', '/usage', '/healthz', '/clay/sheet?account=me', '/clay/status', '/__clay/overrides',
      '/auth', '/auth?token=x', '/assets/x.js', '/assets/index.html', '/sw.js', '/manifest.webmanifest', '/icon.svg', '/missing.html',
      '/index.html/', '//index.html', '/%69ndex.html', '/../index.html', '/./index.html', '/gallery/', '/gallery/x', '/index.htm', '/ws',
      'http://127.0.0.1:8420/index.html'])
      for (const method of ['GET', 'HEAD']) expect(offWeb.check(r({ method, url, headers: nav }), 'http')).toEqual(refused);
    for (const url of ['/index.html', '/clay-lab.html']) expect(off.check(r({ url, headers: nav }), 'http')).toEqual(refused);
    // Only as a document: a cross-site frame or embed is refused (frame-ancestors also stops it rendering).
    for (const dest of ['iframe', 'frame', 'embed', 'object', 'empty', 'image', 'script'])
      for (const url of ['/', '/clay-lab.html']) expect(offWeb.check(r({ url, headers: { ...nav, 'sec-fetch-dest': dest } }), 'http')).toEqual(refused);
    // Only a read: a cross-site form POST is a navigation too, and is refused with or without its Origin.
    for (const method of ['POST', 'PUT', 'DELETE']) for (const url of ['/', '/clay-lab.html', '/api/action']) {
      expect(offWeb.check(r({ method, url, headers: nav, origin: 'https://evil.example' }), 'http')).toEqual(refused);
      expect(offWeb.check(r({ method, url, headers: nav }), 'http')).toEqual(refused);
      expect(offWeb.check(r({ method, url, headers: nav, origin: 'null' }), 'http')).toEqual(refused);
    }
    // Only a navigation: fetch/XHR from another site (cors, no-cors, same-origin mode) and subresources are refused.
    for (const mode of ['cors', 'no-cors', 'same-origin', 'websocket'])
      for (const dest of ['empty', 'document'])
        for (const url of ['/', '/api/state']) expect(offWeb.check(r({ url, headers: { ...nav, 'sec-fetch-mode': mode, 'sec-fetch-dest': dest } }), 'http')).toEqual(refused);
    // A navigation with a foreign Origin (a GET form submission sends none, but if one does) still fails the Origin check.
    expect(offWeb.check(r({ headers: nav, origin: 'https://evil.example' }), 'http')).toMatchObject({ ok: false, status: 403 });
    // Never a websocket, whatever it claims.
    for (const url of ['/', '/ws']) expect(offWeb.check(r({ url, headers: nav }), 'ws')).toEqual(refused);
    expect(offWeb.check(r({ url: '/ws', headers: { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'websocket', 'sec-fetch-dest': 'websocket' } }), 'ws')).toEqual(refused);
    // The Host allowlist still applies first (DNS rebinding), and LAN clients still need the token.
    expect(offWeb.check({ ...r({ headers: nav }), headers: { ...nav, host: 'evil.example:8420' } }, 'http')).toMatchObject({ ok: false, status: 403, reason: 'unexpected Host header' });
    for (const url of ['/', '/clay-lab.html', '/gallery'])
      expect(lanWeb.check({ ...req({ addr: '192.168.1.5', host: '192.168.1.2:8420', headers: nav }), url }, 'http')).toMatchObject({ ok: false, status: 401, login: true });
  });
  it('checks Origin on websocket upgrades when present', () => {
    expect(off.check(req({ origin: 'http://evil.example' }), 'ws')).toMatchObject({ ok: false, status: 403 });
    expect(off.check(req({ origin: 'http://127.0.0.1:8420' }), 'ws').ok).toBe(true);
    expect(off.check(req({ origin: 'http://localhost:5173' }), 'ws')).toMatchObject({ ok: false, status: 403 }); // another local port
    expect(off.check(req({ host: 'localhost:5173', origin: 'http://localhost:5173' }), 'ws').ok).toBe(true); // Vite's /ws proxy keeps Host
    expect(off.check(req(), 'ws').ok).toBe(true); // non-browser client
  });
});

describe('Guard LAN token', () => {
  const r = (headers?: Record<string, string>) => lan.check(req({ addr: '192.168.1.5', host: '192.168.1.2:8420', headers }), 'http');
  it('refuses non-loopback clients when LAN is off', () => {
    expect(off.check(req({ addr: '192.168.1.5' }), 'http')).toMatchObject({ ok: false, status: 403, reason: 'LAN access is off' });
  });
  it('requires the token on every route from non-loopback clients, via header or the session cookie', () => {
    expect(r()).toMatchObject({ ok: false, status: 401, login: true });
    expect(r({ authorization: 'Bearer wrong' })).toMatchObject({ ok: false, status: 401 });
    expect(r({ authorization: `Bearer ${TOKEN}` })).toEqual({ ok: true, via: 'token' });
    expect(r({ cookie: `a=b; cc_token=${sessionValue(TOKEN)}` })).toEqual({ ok: true, via: 'token' });
    expect(r({ cookie: 'cc_token=nope' })).toMatchObject({ ok: false });
  });
  it('treats a malformed cookie as a wrong session instead of throwing, without counting it toward the lockout', () => {
    let t = 0;
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, now: () => t });
    const bad = () => g.check(req({ addr: '192.168.1.8', host: '192.168.1.2:8420', headers: { cookie: 'cc_token=%E0%A4%A' } }), 'ws');
    for (let i = 0; i < 20; i++) expect(bad()).toMatchObject({ ok: false, status: 401 });
  });
  it('treats a LAN request that a port proxy delivers from 127.0.0.1 as a LAN request', () => {
    const proxied = (headers?: Record<string, string>) => lan.check(req({ addr: '127.0.0.1', host: '192.168.1.2:8420', headers }), 'http');
    expect(proxied()).toMatchObject({ ok: false, status: 401 });
    expect(proxied({ authorization: `Bearer ${TOKEN}` })).toEqual({ ok: true, via: 'token' });
    expect(lan.check(req({ addr: '127.0.0.1', host: 'localhost:8420' }), 'http')).toEqual({ ok: true, via: 'loopback' });
  });
  it('locks out an address after 10 wrong tokens sent as a header', () => {
    let t = 0;
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, now: () => t });
    const r2 = (auth: string) => g.check(req({ addr: '192.168.1.7', host: '192.168.1.2:8420', headers: { authorization: `Bearer ${auth}` } }), 'http');
    for (let i = 0; i < 10; i++) expect(r2('guess' + i)).toMatchObject({ status: 401 });
    expect(r2(TOKEN)).toMatchObject({ ok: false, status: 429 });
    t = 61_000;
    expect(r2(TOKEN)).toEqual({ ok: true, via: 'token' });
  });
  it('compares tokens by value in constant time and binds loopback unless LAN is on', () => {
    expect(tokenEqual('abc', 'abc')).toBe(true);
    expect(tokenEqual('abc', 'abd')).toBe(false);
    expect(tokenEqual('abc', 'abcd')).toBe(false);
    expect(generateToken()).toHaveLength(32);
    expect(isLoopback('10.0.0.1')).toBe(false);
    expect(off.bindHost()).toBe('127.0.0.1');
    expect(lan.bindHost()).toBe('0.0.0.0');
  });
});

describe('Guard.handleAuth', () => {
  const authReq = (body: string, over: { origin?: string | null; header?: boolean } = {}) => {
    const r: any = req({ addr: '192.168.1.5', host: '192.168.1.2:8420', method: 'POST', origin: over.origin === null ? undefined : over.origin ?? 'http://192.168.1.2:8420' });
    if (over.header !== false) r.headers['x-clayclaude'] = '1';
    r[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
    return r;
  };
  const res = () => { const o: any = { code: 0, headers: {} }; o.writeHead = (c: number, h: any) => { o.code = c; o.headers = h ?? {}; }; o.end = () => {}; return o; };
  const url = new URL('http://x/auth');
  const good = JSON.stringify({ token: TOKEN });

  it('sets an HttpOnly SameSite cookie for the right token only', async () => {
    const g = mk({ enabled: true, token: TOKEN, hosts: ['192.168.1.2'] });
    const bad = res();
    expect(await g.handleAuth(authReq('{"token":"nope"}'), bad, url)).toBe(true);
    expect(bad.code).toBe(401);
    const ok = res();
    await g.handleAuth(authReq(good), ok, url);
    expect(ok.code).toBe(204);
    expect(ok.headers['set-cookie']).toMatch(/HttpOnly; SameSite=Strict/);
  });
  it('refuses a login post with no or foreign Origin, a wrong Host, or no custom header', async () => {
    const g = mk({ enabled: true, token: TOKEN, hosts: ['192.168.1.2'] });
    for (const q of [authReq(good, { origin: null }), authReq(good, { origin: 'https://evil.example' }), authReq(good, { header: false })]) {
      const r = res(); await g.handleAuth(q, r, url); expect(r.code).toBe(403);
    }
    const q = authReq(good); q.headers.host = 'evil.example:8420';
    const r = res(); await g.handleAuth(q, r, url); expect(r.code).toBe(403);
  });
  it('locks out an address after 10 wrong tries in a minute', async () => {
    let t = 0;
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, now: () => t });
    for (let i = 0; i < 10; i++) await g.handleAuth(authReq('{"token":"x"}'), res(), url);
    const r = res(); await g.handleAuth(authReq(good), r, url); expect(r.code).toBe(429);
    t = 61_000;
    const later = res(); await g.handleAuth(authReq(good), later, url); expect(later.code).toBe(204);
  });
  it('does not exist when LAN is off, and ignores other paths', async () => {
    const r = res();
    expect(await off.handleAuth(authReq('{}'), r, url)).toBe(true);
    expect(r.code).toBe(404);
    expect(await off.handleAuth(authReq('{}'), res(), new URL('http://x/other'))).toBe(false);
  });
});

describe('Guard lockout cannot lock out a signed-in tablet', () => {
  const authReq = (body: string, addr: string) => {
    const r: any = req({ addr, host: '192.168.1.2:8420', method: 'POST', origin: 'http://192.168.1.2:8420' });
    r.headers['x-clayclaude'] = '1';
    r[Symbol.asyncIterator] = async function* () { yield Buffer.from(body); };
    return r;
  };
  const res = () => { const o: any = { code: 0, headers: {} }; o.writeHead = (c: number, h: any) => { o.code = c; o.headers = h ?? {}; }; o.end = () => {}; return o; };
  const login = async (g: Guard, addr: string) => {
    const r = res(); await g.handleAuth(authReq(JSON.stringify({ token: TOKEN }), addr), r, new URL('http://x/auth'));
    expect(r.code).toBe(204);
    return String(r.headers['set-cookie']).split(';')[0];
  };

  it('keeps admitting the session cookie while another client on the same address is locked out', async () => {
    // Behind a NAT or port proxy every LAN device shares one address; an attacker there must not lock the tablet out.
    let t = 0;
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, now: () => t });
    const cookie = await login(g, '172.20.0.1');
    const as = (headers: Record<string, string>) => g.check(req({ addr: '172.20.0.1', host: '192.168.1.2:8420', headers }), 'ws');
    for (let i = 0; i < 12; i++) as({ authorization: `Bearer guess${i}` });
    expect(as({ authorization: 'Bearer guess' })).toMatchObject({ ok: false, status: 429 }); // guessing is still locked
    for (let i = 0; i < 5; i++) { t += 50_000; as({ authorization: 'Bearer again' }); for (let j = 0; j < 10; j++) as({ authorization: `Bearer g${j}` }); }
    expect(as({ cookie })).toEqual({ ok: true, via: 'token' });
  });
  it('does not put the token itself in the cookie, so the cookie is no channel for guessing it', async () => {
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] } });
    const cookie = await login(g, '192.168.1.5');
    expect(cookie).not.toContain(TOKEN);
    expect(cookie).not.toContain(encodeURIComponent(TOKEN));
    expect(g.check(req({ addr: '192.168.1.5', host: '192.168.1.2:8420', headers: { cookie: `cc_token=${encodeURIComponent(TOKEN)}` } }), 'http')).toMatchObject({ ok: false, status: 401 });
  });
  it('a stale cookie (the token was changed) does not lock its own device out of signing in again', async () => {
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] } });
    // The open board reconnects its websocket every few seconds with the old cookie.
    for (let i = 0; i < 30; i++) expect(g.check(req({ addr: '192.168.1.5', host: '192.168.1.2:8420', headers: { cookie: 'cc_token=old-session-value' } }), 'ws')).toMatchObject({ status: 401 });
    await login(g, '192.168.1.5');
  });
});

describe('Guard failure map stays bounded', () => {
  it('tracks at most a fixed number of addresses, however many guess at once, and keeps locking them out', () => {
    const t = 0;
    const g = new Guard({ lan: { enabled: true, token: TOKEN, hosts: ['192.168.1.2'] }, now: () => t });
    const from = (addr: string) => g.check(req({ addr, host: '192.168.1.2:8420', headers: { authorization: 'Bearer wrong' } }), 'http');
    const started = performance.now();
    for (let i = 0; i < 20_000; i++) from(`10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`);
    expect(performance.now() - started).toBeLessThan(2000);
    expect((g as any).fails.size).toBeLessThanOrEqual(1025);
    for (let i = 0; i < 10; i++) from('10.200.0.1');
    expect(from('10.200.0.1')).toMatchObject({ status: 429 });
  });
});

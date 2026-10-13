import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import type { Config } from './config.js';
import type { Collector } from './collector.js';
import type { UsagePoller } from './usage.js';
import { APP_CSP, Guard } from './security.js';
import { readServedStamp, UNKNOWN_STAMP } from './build-info.js';
import type { NicknameStore } from './nicknames.js';

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const HEARTBEAT_MS = 30_000;
/** Shortest gap between two state broadcasts. */
export const BROADCAST_MS = 250;
const MAX_BUFFERED = 8 * 1024 * 1024;


/** Extra route. Return true once the request has been handled. */
export type RouteHandler = (req: IncomingMessage, res: ServerResponse, url: URL) => boolean | Promise<boolean>;

export async function startServer(o: { cfg: Config; collector: Collector; usage: UsagePoller; webRoot: string; port?: number; handlers?: RouteHandler[]; names?: NicknameStore }) {
  // Board nicknames (Task 41) are served as the session's name, its own name beside it as derivedName.
  const state = () => ({ type: 'state', sessions: o.names ? o.names.apply(o.collector.sessions()) : o.collector.sessions(), usage: o.usage.usage(),
    accounts: o.cfg.accounts.map((a) => ({ id: a.id, label: a.label, colour: a.colour, host: a.host })),
    cacheTtlMinutes: o.cfg.cacheTtlMinutes, serverTime: Date.now() });

  const guard = new Guard({ lan: o.cfg.lan, webRoot: o.webRoot });

  const http = createServer(async (req, res) => {
    const send = (code: number, body: string, type = 'application/json') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body); };
    // On every response, the login page and the board alike: no framing (a page on another local port is same-site,
    // so Sec-Fetch-Site does not stop it framing the board to clickjack its buttons), no MIME sniffing, and a CSP
    // (APP_CSP: scripts from the daemon only; the login page swaps in its own, which allows its one inline script).
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('content-security-policy', APP_CSP);
    res.setHeader('x-content-type-options', 'nosniff');
    try { await route(req, res, send); }
    catch { if (!res.headersSent) send(500, 'server error', 'text/plain'); else res.end(); }
  });

  async function route(req: IncomingMessage, res: ServerResponse, send: (code: number, body: string, type?: string) => void) {
    // Host and Origin first, so a foreign page learns nothing (not even a 400) about the paths.
    const pre = guard.precheck(req, 'http');
    if (pre) return guard.deny(req, res, pre);
    let url: URL;
    try { url = new URL(req.url ?? '/', 'http://x'); } catch { return send(400, 'bad path', 'text/plain'); }
    if (await guard.handleAuth(req, res, url)) return;
    const verdict = guard.check(req, 'http');
    if (!verdict.ok) return guard.deny(req, res, verdict);
    if (url.pathname === '/api/state') return send(200, JSON.stringify(state()));
    if (url.pathname === '/usage') return send(200, JSON.stringify(o.usage.publicShape()));
    // Re-read each time: a rebuild of web/dist under a running daemon changes what it serves (spec §5.1, Task 32).
    if (url.pathname === '/api/version') return send(200, JSON.stringify(readServedStamp(o.webRoot) ?? UNKNOWN_STAMP));
    if (url.pathname === '/healthz') return send(200, 'ok', 'text/plain');
    for (const h of o.handlers ?? []) {
      try { if (await h(req, res, url)) return; }
      catch { if (!res.headersSent) send(500, 'handler error', 'text/plain'); else res.end(); return; }
    }
    let rel: string;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(400, 'bad path', 'text/plain'); }
    if (rel.includes('..')) return send(404, 'not found', 'text/plain');
    const file = normalize(join(o.webRoot, rel === '/' ? 'index.html' : rel));
    if (!file.startsWith(normalize(o.webRoot))) return send(404, 'not found', 'text/plain');
    try {
      const body = await readFile(file);
      // Vite's hashed /assets/ never change under one name; everything else (the page, sw.js, the manifest) is
      // revalidated on every load, so a new build is picked up by the next load (Task 32).
      res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
        'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(body);
    } catch { send(404, 'not found', 'text/plain'); }
  }

  // The board only listens on /ws; a client sending more than a small frame is not the board (ws's default is 100 MiB).
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096,
    // ws calls this from the http server's 'upgrade' event, so a throw here would be uncaught and stop the daemon.
    verifyClient: (info, cb) => {
      let v: ReturnType<typeof guard.check>;
      try { v = guard.check(info.req, 'ws'); } catch { return cb(false, 400, 'bad request'); }
      if (v.ok) cb(true); else cb(false, v.status, v.reason);
    } });
  /** Every message is the full state, so a client that has fallen this far behind loses nothing by reconnecting. */
  const push = (c: WebSocket, msg: string) => {
    if (c.readyState !== 1) return;
    if (c.bufferedAmount > MAX_BUFFERED) { c.terminate(); return; } // stopped reading (a frozen tab): don't queue forever
    c.send(msg);
  };
  // At most one full-state message per BROADCAST_MS: the first update goes at once, a burst after it collapses into one trailing send.
  let pending: NodeJS.Timeout | undefined, lastSent = 0;
  const broadcastNow = () => {
    pending = undefined; lastSent = Date.now();
    if (!wss.clients.size) return;
    try { const msg = JSON.stringify(state()); wss.clients.forEach((c) => push(c, msg)); }
    catch (e) { console.warn(`clayclaude: broadcast failed: ${e instanceof Error ? e.message : String(e)}`); }
  };
  const broadcast = () => {
    if (pending) return;
    // Clamped: if the wall clock steps backwards (NTP, WSL2 time sync) the raw wait is the size of the step, freezing the board.
    const wait = Math.min(lastSent + BROADCAST_MS - Date.now(), BROADCAST_MS);
    if (wait <= 0) broadcastNow(); else pending = setTimeout(broadcastNow, wait);
  };
  // Without an error listener a bad frame or a write to a dropped socket throws and stops the daemon; ws closes the socket itself.
  const alive = new WeakSet<WebSocket>();
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    alive.add(ws); ws.on('pong', () => alive.add(ws));
    try { push(ws, JSON.stringify(state())); } catch { ws.terminate(); }
  });
  // A half-open connection (tablet asleep, cable pulled mid-write) never closes by itself; ping it and drop it if it stays silent.
  const heartbeat = setInterval(() => wss.clients.forEach((c) => {
    if (!alive.delete(c)) { c.terminate(); return; }
    try { c.ping(); } catch { c.terminate(); }
  }), HEARTBEAT_MS);
  heartbeat.unref();

  // ws re-emits the http server's errors; with no listener a listen failure (EADDRINUSE) is an uncaught exception.
  try {
    await new Promise<void>((resolve, reject) => {
      wss.once('error', reject);
      http.listen(o.port ?? o.cfg.port, guard.bindHost(), () => { wss.off('error', reject); resolve(); });
    });
  } catch (e) { clearInterval(heartbeat); wss.close(); http.close(); throw e; }
  wss.on('error', (e) => console.warn(`clayclaude: server error: ${e.message}`));
  o.collector.on('update', broadcast);
  o.usage.on('update', broadcast);
  o.names?.on('update', broadcast);
  return {
    port: (http.address() as any).port as number,
    close: () => new Promise<void>((r) => { clearInterval(heartbeat); clearTimeout(pending); o.collector.off('update', broadcast); o.usage.off('update', broadcast); o.names?.off('update', broadcast);
      // A request still in flight (a slow handler) would hold http.close() open forever and hang shutdown.
      wss.clients.forEach((c) => c.terminate()); wss.close(); http.close(() => r()); http.closeAllConnections(); }),
  };
}

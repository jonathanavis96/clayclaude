import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface LanConfig { enabled: boolean; token?: string; hosts?: string[] }
export type Verdict =
  | { ok: true; via: 'loopback' | 'token' }
  | { ok: false; status: number; reason: string; login?: boolean };

const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
export const COOKIE = 'cc_token';
/** Most addresses the lockout tracks at once; any beyond share the overflow bucket. */
const MAX_TRACKED = 1024;
const OVERFLOW = '*';

export const isLoopback = (addr: string | undefined) => !!addr && LOOPBACK_ADDRS.has(addr);
export const generateToken = () => randomBytes(24).toString('base64url');

/** Constant-time comparison: both sides are hashed first so lengths do not leak. */
export function tokenEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Hostname of a Host header or an Origin value, lower-cased; null when it does not parse. */
const hostnameOf = (hostHeader: string | undefined) => { try { return hostHeader ? new URL('http://' + hostHeader).hostname.toLowerCase() : null; } catch { return null; } };
const originUrl = (origin: string) => { try { return new URL(origin); } catch { return null; } };
/**
 * The app's own HTML pages: `/` (the board), `/gallery` (a redirect to the lab's gallery, spec §7.4.6), and a static
 * `.html` page at the top of the web root that exists there (index.html, clay-lab.html, clay-bake.html in web/dist).
 * The path is matched as sent, query aside: no decoding, no subdirectories, no dot segments, so nothing else qualifies.
 */
export function isAppPage(rawUrl: string | undefined, webRoot: string | undefined): boolean {
  const path = (rawUrl ?? '').split('?')[0];
  if (path === '/' || path === '/gallery') return true;
  if (!webRoot || !/^\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*\.html$/.test(path)) return false;
  return appPages(webRoot).has(path.slice(1));
}

/** How long the list of pages is trusted: a rebuild of web/dist while the daemon runs shows up within this. */
const PAGES_TTL_MS = 10_000;
const pageCache = new Map<string, { at: number; pages: Set<string> }>();

/** The `.html` files at the top of `webRoot`, read at most once per PAGES_TTL_MS (not once per request). */
export function appPages(webRoot: string, now = Date.now()): Set<string> {
  const hit = pageCache.get(webRoot);
  if (hit && now - hit.at < PAGES_TTL_MS && now >= hit.at) return hit.pages;
  let pages: Set<string>;
  try { pages = new Set(readdirSync(webRoot, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.html')).map((e) => e.name)); }
  catch { pages = new Set(); }
  pageCache.set(webRoot, { at: now, pages });
  return pages;
}
/** A top-level GET/HEAD document navigation to one of the app's own pages, per Fetch Metadata: never a frame, a subresource, a fetch, a form POST or any other route. */
const isPageNavigation = (req: IncomingMessage, webRoot: string | undefined) =>
  (req.method === 'GET' || req.method === 'HEAD') && req.headers['sec-fetch-mode'] === 'navigate'
  && req.headers['sec-fetch-dest'] === 'document' && isAppPage(req.url, webRoot);

function cookieToken(req: IncomingMessage): string | undefined {
  for (const part of String(req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k !== COOKIE) continue;
    // A malformed escape must not throw: on a websocket upgrade this runs inside ws's verifyClient, where a throw
    // is uncaught and stops the daemon. The raw value is then just a wrong session.
    try { return decodeURIComponent(v.join('=')); } catch { return v.join('='); }
  }
  return undefined;
}

function bearerToken(req: IncomingMessage): string | undefined {
  const auth = String(req.headers.authorization ?? '');
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : undefined;
}

/**
 * The cookie holds a value derived from the token, never the token itself. It is 256 bits that nobody types, so it
 * cannot be guessed and needs no lockout, and a signed-in tablet keeps working while someone sharing its address
 * (a NAT, a port proxy) is locked out for guessing. Changing the token changes it, which signs every device out.
 */
export const sessionValue = (token: string) => createHmac('sha256', token).update('clayclaude session v1').digest('base64url');

const LOGIN_SCRIPT = `f.onsubmit=async e=>{e.preventDefault();const r=await fetch('/auth',{method:'POST',headers:{'content-type':'application/json','x-clayclaude':'1'},body:JSON.stringify({token:t.value})});
if(r.ok)location.replace('/');else m.textContent=r.status==429?'Too many tries. Wait a minute.':'That token is not right.'}`;
const LOGIN_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clayclaude</title><body style="font:16px system-ui;background:#0e1014;color:#f2f4f7;display:grid;place-items:center;height:100vh;margin:0">
<form id="f" style="display:grid;gap:12px;width:min(90vw,360px)"><b>clayclaude access token</b>
<input id="t" type="password" autocomplete="off" style="font-size:18px;padding:10px"><button style="font-size:18px;padding:10px">Unlock</button>
<span id="m" style="color:#f5b544"></span></form>
<script>${LOGIN_SCRIPT}</script>`;

/**
 * The Content-Security-Policy on every response. Session text (names, questions, replies, file paths) reaches the
 * board's DOM, always escaped; this is the second line: no inline or foreign script runs, nothing is fetched from
 * elsewhere (connect-src 'self' covers the board's own websocket), and nothing can frame it. Inline style
 * attributes stay allowed: the board and the clay lab set widths, colours and custom properties that way.
 */
const csp = (scriptSrc: string) => [
  "default-src 'self'", `script-src ${scriptSrc}`, "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "connect-src 'self'", "worker-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
export const APP_CSP = csp("'self'");
/** The LAN login page is one inline document: its script is allowed by hash, and nothing else is. */
const LOGIN_CSP = csp(`'sha256-${createHash('sha256').update(LOGIN_SCRIPT).digest('base64')}'`);

export class Guard {
  private fails = new Map<string, { n: number; until: number }>();
  private session?: string;
  /** `webRoot`: the directory the board's pages are served from (web/dist), for the cross-site page navigation rule. */
  constructor(private o: { lan: LanConfig; webRoot?: string; now?: () => number }) {
    if (o.lan.token) this.session = sessionValue(o.lan.token);
  }
  private now = () => (this.o.now ?? Date.now)();

  bindHost(): string { return this.o.lan.enabled ? '0.0.0.0' : '127.0.0.1'; }

  /** The only Host names accepted (any port, so the Vite dev proxy works): loopback names, plus the configured LAN hosts when LAN mode is on. Never a wildcard. */
  allowedHosts(): Set<string> {
    return new Set([...LOOPBACK_HOSTS, ...(this.o.lan.enabled ? (this.o.lan.hosts ?? []).map((h) => h.toLowerCase()) : [])]);
  }

  /**
   * Host and Origin checks, applied to every request including the login POST. This is the one source of truth
   * (it replaces Plan 1's inline `allowed()` in server.ts).
   * - Host must name an allowed host (stops DNS rebinding).
   * - Origin, when present, must equal Host exactly (scheme aside), on every request including websocket upgrades,
   *   so a page on another site, or on another local port or name, can neither drive nor read the daemon. On any
   *   request that is not GET or HEAD it must be present (browsers always send Origin on cross-site writes).
   *   The Vite dev proxy still works: its /ws proxy keeps Host, and the board's own GETs send no Origin.
   * There are no CORS headers anywhere: a cross-origin page can neither read nor write.
   */
  precheck(req: IncomingMessage, kind: 'http' | 'ws'): Extract<Verdict, { ok: false }> | null {
    const hostHeader = String(req.headers.host ?? '').toLowerCase();
    const host = hostnameOf(hostHeader);
    const allowed = this.allowedHosts();
    if (!host || !allowed.has(host)) return { ok: false, status: 403, reason: 'unexpected Host header' };
    // Chrome marks requests a page on another site makes, including <img>/<script> GETs that send no Origin.
    // One exception: a top-level GET/HEAD document navigation to one of the app's own HTML pages (isAppPage). Chrome
    // on Android marks every URL opened from another app cross-site: the kiosk launch
    // `am start -d http://localhost:<port>/#kiosk` (spec §5.4), the hotkey, `tablet.sh open-url`, and a reload of the
    // page they opened. Such a navigation only shows a page to the person: the pages have no side effects, cannot be
    // framed (X-Frame-Options, frame-ancestors) and the site that started it cannot read the response. Every other
    // route (the API, /usage, /healthz, /clay/*, /__clay/*, /auth, static assets) and every other kind of cross-site
    // request (subresource, fetch, frame, form POST, websocket) is still refused, and the checks below (Origin, then
    // loopback or the LAN token, whose SameSite=Strict cookie a cross-site navigation does not carry) still apply.
    if (req.headers['sec-fetch-site'] === 'cross-site' && !(kind === 'http' && isPageNavigation(req, this.o.webRoot))) return { ok: false, status: 403, reason: 'cross-site request refused' };
    const origin = req.headers.origin;
    const writes = kind === 'http' && req.method !== 'GET' && req.method !== 'HEAD';
    if (origin === undefined) return writes ? { ok: false, status: 403, reason: 'Origin header required' } : null;
    const u = originUrl(String(origin));
    if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return { ok: false, status: 403, reason: 'bad origin' };
    // Exact host and port, on reads and websockets too: a page on another local port (any dev server, or another
    // service on the LAN host, which also receives the SameSite cookie) is same-site but must not read the board.
    if (!allowed.has(u.hostname.toLowerCase()) || u.host.toLowerCase() !== hostHeader) return { ok: false, status: 403, reason: 'cross-origin request refused' };
    return null;
  }

  /**
   * Full decision: precheck, then loopback or token. A request counts as local only when it both comes from a
   * loopback address and names a loopback host: a LAN browser whose request a port proxy (netsh portproxy, WSL's
   * localhost forwarding) delivers from 127.0.0.1 still carries the LAN name in Host, and still needs the token.
   * A non-browser client can write any Host, though, so behind such a proxy it passes as local: LAN traffic must
   * reach the daemon from its real address (WSL mirrored networking, or a proxy to the WSL address, not 127.0.0.1).
   */
  check(req: IncomingMessage, kind: 'http' | 'ws'): Verdict {
    const bad = this.precheck(req, kind);
    if (bad) return bad;
    const loopName = LOOPBACK_HOSTS.has(hostnameOf(String(req.headers.host ?? '')) ?? '');
    if (isLoopback(req.socket.remoteAddress) && loopName) return { ok: true, via: 'loopback' };
    const { enabled, token } = this.o.lan;
    if (!enabled || !token) return { ok: false, status: 403, reason: 'LAN access is off' };
    // The session cookie first, before the lockout: see sessionValue. A wrong or stale one is not counted.
    const cookie = cookieToken(req);
    if (cookie && this.session && tokenEqual(cookie, this.session)) return { ok: true, via: 'token' };
    const ip = req.socket.remoteAddress ?? '?';
    if (this.locked(ip)) return { ok: false, status: 429, reason: 'too many wrong tokens; wait a minute' };
    const given = bearerToken(req);
    if (given && tokenEqual(given, token)) return { ok: true, via: 'token' };
    if (given) this.failed(ip); // a wrong header counts like a wrong login, so the token cannot be guessed through /api/state
    return { ok: false, status: 401, reason: 'token required', login: true };
  }

  private locked(ip: string): boolean {
    const f = this.fails.get(ip) ?? this.fails.get(OVERFLOW);
    return !!f && f.until > this.now() && f.n >= 10;
  }

  private failed(ip: string): void {
    const t = this.now();
    if (!this.fails.has(ip) && this.fails.size >= MAX_TRACKED) {
      for (const [k, v] of this.fails) if (v.until <= t) this.fails.delete(k);
      // Still full of live entries: more addresses are guessing than any LAN has. They share one bucket, so the
      // map (and this sweep) stays bounded instead of growing with every address and slowing every request.
      if (this.fails.size >= MAX_TRACKED) ip = OVERFLOW;
    }
    const f = this.fails.get(ip);
    const live = f && f.until > t ? f : { n: 0, until: t + 60_000 };
    live.n++;
    this.fails.set(ip, live);
  }

  deny(req: IncomingMessage, res: ServerResponse, v: Extract<Verdict, { ok: false }>) {
    const wantsHtml = req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html');
    if (v.login && wantsHtml) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': LOGIN_CSP });
      return res.end(LOGIN_PAGE);
    }
    res.writeHead(v.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: 'forbidden', message: v.reason }));
  }

  /** `POST /auth {token}` sets the cookie. Returns true when it handled the request. */
  async handleAuth(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    if (url.pathname !== '/auth' || req.method !== 'POST') return false;
    const { enabled, token } = this.o.lan;
    const reply = (code: number, extra: Record<string, string> = {}) => { res.writeHead(code, { 'cache-control': 'no-store', ...extra }); res.end(); return true; };
    if (!enabled || !token) return reply(404);
    if (this.precheck(req, 'http')) return reply(403);
    if (req.headers['x-clayclaude'] !== '1') return reply(403);
    const ip = req.socket.remoteAddress ?? '?';
    if (this.locked(ip)) return reply(429);
    let body = '';
    for await (const c of req) { body += c; if (body.length > 1024) return reply(413); }
    let given = '';
    try { given = String(JSON.parse(body).token ?? ''); } catch { /* falls through to rejection */ }
    if (given && tokenEqual(given, token)) {
      this.fails.delete(ip);
      return reply(204, { 'set-cookie': `${COOKIE}=${sessionValue(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }
    this.failed(ip);
    return reply(401);
  }
}

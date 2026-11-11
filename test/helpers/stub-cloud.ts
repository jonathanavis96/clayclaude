import { createServer, type Server } from 'node:http';

/** One request the stub saw. Header names are lower case, as node gives them. */
export interface CloudCall { method: string; path: string; headers: Record<string, string>; body?: any }

export interface CloudStub { url: string; calls: CloudCall[]; close(): Promise<void> }

export interface CloudStubOpts {
  /** GET /v1/sessions, paged 100 at a time with after_id, as the real API does. */
  list: object[];
  /** GET /v1/sessions/{id}/events, paged 1000 at a time (or by `limit`) with after_id, keyed by session id. */
  events?: Record<string, object[]>;
  /** GET /v1/sessions/{id}: this object, else the list item with that id, else 404. */
  single?: Record<string, object>;
  /** Answer every request with this status (and Retry-After) instead. */
  status?: number;
  retryAfter?: string;
  /** POST /v1/sessions/{id}/events or /v1/code/sessions/{id}/events: the status to answer (default 200). */
  post?: (sid: string, body: any) => number;
  /** Delay every GET of an events page by this many ms (a slow API). */
  eventsDelayMs?: number;
}

/** An in-process stand-in for the sessions API (list, single, events, POST events). */
export async function startCloudStub(o: CloudStubOpts): Promise<CloudStub> {
  const calls: CloudCall[] = [];
  const page = (items: any[], idKey: string, q: URLSearchParams, dflt: number) => {
    const limit = Number(q.get('limit') ?? dflt) || dflt;
    const after = q.get('after_id');
    let start = 0;
    if (after) {
      const i = items.findIndex((x) => x[idKey] === after);
      start = i >= 0 ? i + 1 : 0;
    }
    const data = items.slice(start, start + limit);
    return {
      data, has_more: start + limit < items.length,
      first_id: data.length ? data[0][idKey] : null, last_id: data.length ? data[data.length - 1][idKey] : null,
    };
  };
  const srv: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method!, path: req.url!, headers, body });
      const send = (status: number, obj: object, extra: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...extra });
        res.end(JSON.stringify(obj));
      };
      if (o.status && o.status !== 200) {
        send(o.status, { type: 'error', error: { type: 'stub', message: 'stub error' } }, o.retryAfter ? { 'retry-after': o.retryAfter } : {});
        return;
      }
      const u = new URL(req.url!, 'http://stub');
      const code = u.pathname.match(/^\/v1\/code\/sessions\/([^/]+)\/events$/);
      if (code && req.method === 'POST') return send(o.post?.(code[1], body) ?? 200, {});
      const m = u.pathname.match(/^\/v1\/sessions(?:\/([^/]+))?(\/events)?$/);
      if (!m) return send(404, { error: 'no route' });
      const [, sid, ev] = m;
      if (req.method === 'POST' && sid && ev) return send(o.post?.(sid, body) ?? 200, {});
      if (req.method !== 'GET') return send(405, {});
      if (!sid) return send(200, page(o.list, 'id', u.searchParams, 100));
      if (ev) {
        const reply = () => send(200, page(o.events?.[sid] ?? [], 'uuid', u.searchParams, 1000));
        if (o.eventsDelayMs) { setTimeout(reply, o.eventsDelayMs); return; }
        return reply();
      }
      const one = o.single?.[sid] ?? o.list.find((x: any) => x.id === sid);
      return one ? send(200, one) : send(404, { error: 'not found' });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

import { createServer, type Server } from 'node:http';

export interface Stub { url: string; calls: { path: string; auth?: string; ua?: string; body?: any }[]; close(): Promise<void> }

export interface StubOpts {
  /** Status for GET /usage when the token is "old" (anything but "new"). */
  usageStatusForOld: number;
  /** Status for POST /token. */
  tokenStatus: number;
  /** Status for GET /usage with the "new" token (default 200). */
  usageStatusForNew?: number;
  /** Extra headers on a non-200 /usage answer (e.g. Retry-After). */
  usageErrorHeaders?: Record<string, string>;
  /** Delay before answering /token, so two refreshers can overlap. */
  tokenDelayMs?: number;
  /** Runs when a /token request arrives, before it is answered. */
  onToken?: () => void;
  /** The token endpoint's JSON answer (default {access_token: 'new', refresh_token: 'r2'}). */
  tokenBody?: object;
}

export async function startStub(opts: StubOpts): Promise<Stub> {
  const calls: Stub['calls'] = [];
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      calls.push({ path: req.url!, auth: req.headers.authorization, ua: req.headers['user-agent'], body: body ? JSON.parse(body) : undefined });
      if (req.url === '/usage') {
        const isNew = req.headers.authorization === 'Bearer new';
        const status = isNew ? (opts.usageStatusForNew ?? 200) : opts.usageStatusForOld;
        res.writeHead(status, { 'content-type': 'application/json', ...(status === 200 ? {} : opts.usageErrorHeaders) });
        res.end(JSON.stringify(status === 200
          ? { five_hour: { utilization: 42, resets_at: '2026-10-12T15:00:00Z' }, seven_day: { utilization: 7, resets_at: '2026-10-16T09:00:00Z' } }
          : { error: { type: 'error', message: 'stub' } }));
      } else {
        opts.onToken?.();
        setTimeout(() => {
          res.writeHead(opts.tokenStatus, { 'content-type': 'application/json' });
          res.end(JSON.stringify(opts.tokenBody ?? { access_token: 'new', refresh_token: 'r2' }));
        }, opts.tokenDelayMs ?? 0);
      }
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); }) };
}

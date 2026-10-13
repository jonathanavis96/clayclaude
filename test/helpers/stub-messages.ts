import { createServer, type Server } from 'node:http';

/** A stand-in for POST /v1/messages that answers with the subscription rate-limit headers. Never the real API. */
export interface MessagesStub {
  url: string;
  calls: { auth?: string; ua?: string; version?: string; body?: any }[];
  /** Status to answer with (default 200); `reason` replaces the status text (a hostile one may quote the token). */
  status: number;
  reason?: string;
  headers: Record<string, string>;
  close(): Promise<void>;
}

/** The headers a subscription reply carries: 25% of the five-hour window (resets in an hour), 40% of the week. */
export const rlHeaders = (nowS = Math.floor(Date.now() / 1000)): Record<string, string> => ({
  'anthropic-ratelimit-unified-5h-utilization': '0.25',
  'anthropic-ratelimit-unified-5h-reset': String(nowS + 3600),
  'anthropic-ratelimit-unified-7d-utilization': '0.4',
  'anthropic-ratelimit-unified-7d-reset': String(nowS + 3 * 86400),
  'anthropic-ratelimit-unified-status': 'allowed',
});

export async function startMessagesStub(): Promise<MessagesStub> {
  const stub = { calls: [], status: 200, headers: rlHeaders() } as unknown as MessagesStub;
  const srv: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      stub.calls.push({ auth: req.headers.authorization, ua: req.headers['user-agent'], version: req.headers['anthropic-version'] as string,
        body: body ? JSON.parse(body) : undefined });
      res.writeHead(stub.status, stub.reason ?? '', { 'content-type': 'application/json', ...(stub.status === 200 ? stub.headers : { 'retry-after': '120' }) });
      res.end(JSON.stringify(stub.status === 200 ? { content: [{ type: 'text', text: 'H' }] } : { error: { message: 'stub' } }));
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  stub.url = `http://127.0.0.1:${(srv.address() as any).port}/v1/messages`;
  stub.close = () => new Promise((r) => { srv.closeAllConnections(); srv.close(() => r()); });
  return stub;
}

import { describe, it, expect, afterEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { connect } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startServer, BROADCAST_MS, type RouteHandler } from '../src/server.js';
import { parseConfig } from '../src/config.js';

const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]
`);
class FakeCollector extends EventEmitter { list: any[] = [{ key: 'local:me:s', state: 'working' }]; sessions() { return this.list; } }
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return { me: { label: 'Me', five_hour: null, seven_day: null, stale: true } }; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function boot(handlers?: RouteHandler[]) {
  const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  const collector = new FakeCollector(), usage = new FakeUsage();
  const s = await startServer({ cfg, collector: collector as any, usage: usage as any, webRoot: web, port: 0, handlers });
  close = s.close;
  return { base: `http://127.0.0.1:${s.port}`, port: s.port, collector };
}

describe('server', () => {
  it('serves state, usage, and the board', async () => {
    const { base } = await boot();
    expect((await (await fetch(base + '/api/state')).json()).sessions[0].key).toBe('local:me:s');
    expect((await (await fetch(base + '/usage')).json()).me.label).toBe('Me');
    expect(await (await fetch(base + '/')).text()).toContain('board');
    expect((await fetch(base + '/..%2f..%2fetc/passwd')).status).toBe(404);
  });

  it('pushes state over the websocket on connect and on update', async () => {
    const { port, collector } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: any[] = [];
    await new Promise<void>((r) => ws.on('message', (m) => { msgs.push(JSON.parse(String(m))); if (msgs.length === 1) r(); }));
    collector.list = [{ key: 'local:me:s', state: 'asleep' }];
    collector.emit('update', collector.list);
    await new Promise((r) => setTimeout(r, 100));
    expect(msgs.map((m) => m.sessions[0].state)).toEqual(['working', 'asleep']);
    ws.close();
  });

  it('runs route handlers in order before static files', async () => {
    const calls: string[] = [];
    const declines: RouteHandler = (_req, _res, url) => { calls.push('first:' + url.pathname); return false; };
    const answers: RouteHandler = async (_req, res, url) => {
      calls.push('second:' + url.pathname);
      if (url.pathname !== '/clay/ping') return false;
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('pong');
      return true;
    };
    const { base } = await boot([declines, answers]);
    const r = await fetch(base + '/clay/ping');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('pong');
    expect(calls).toEqual(['first:/clay/ping', 'second:/clay/ping']);
    expect(await (await fetch(base + '/')).text()).toContain('board');
  });

  it('answers 400 to a path URL cannot parse, and stays up', async () => {
    const { base, port } = await boot();
    const raw = await new Promise<string>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET // HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n'));
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(buf));
      sock.on('error', reject);
    });
    expect(raw.split('\r\n')[0]).toContain('400');
    expect((await fetch(base + '/healthz')).status).toBe(200);
  });

  it('survives a malformed websocket frame and stays up', async () => {
    const { base, port } = await boot();
    const closed = await new Promise<boolean>((resolve, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
        + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
      let buf = '', sent = false;
      sock.on('data', (d) => {
        buf += d.toString('latin1');
        // Unmasked client text frame "hi": a protocol violation (WS_ERR_EXPECTED_MASK).
        if (!sent && buf.includes('\r\n\r\n')) { sent = true; sock.write(Buffer.from([0x81, 0x02, 0x68, 0x69])); }
      });
      sock.on('close', () => resolve(true));
      sock.on('error', () => resolve(true));
      setTimeout(() => reject(new Error('socket not closed')), 2000);
    });
    expect(closed).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect((await fetch(base + '/healthz')).status).toBe(200);
  });

  it('refuses a websocket from a foreign origin and accepts local ones', async () => {
    const { port } = await boot();
    const evil = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin: 'https://evil.example' });
    const outcome = await new Promise<string>((r) => { evil.on('message', () => r('message')); evil.on('error', () => r('error')); });
    expect(outcome).toBe('error');
    for (const [host, origin] of [['127.0.0.1', `http://127.0.0.1:${port}`], ['localhost', `http://localhost:${port}`]]) {
      const ok = new WebSocket(`ws://${host}:${port}/ws`, { origin });
      const msg = await new Promise<any>((r, j) => { ok.on('message', (m) => r(JSON.parse(String(m)))); ok.on('error', j); });
      expect(msg.type).toBe('state');
      ok.close();
    }
  });

  it('refuses HTTP requests with a foreign Host or Origin', async () => {
    const { port } = await boot();
    const get = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
      const rq = request({ host: '127.0.0.1', port, path: '/api/state', headers }, (res) => { res.resume(); resolve(res.statusCode!); });
      rq.on('error', reject); rq.end();
    });
    expect(await get({ host: 'evil.example:' + port })).toBe(403);
    expect(await get({ host: '127.0.0.1:' + port, origin: 'https://evil.example' })).toBe(403);
    expect(await get({ host: 'localhost:' + port })).toBe(200);
    expect(await get({ host: '127.0.0.1:' + port, origin: `http://localhost:${port}` })).toBe(403); // another local name is another origin
    expect(await get({ host: '127.0.0.1:' + port, origin: `http://127.0.0.1:${port}` })).toBe(200);
  });
});

describe('server startup', () => {
  it('rejects with EADDRINUSE when the port is taken, instead of crashing the process', async () => {
    const { createServer } = await import('node:net');
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const port = (blocker.address() as any).port as number;
    const collector = new FakeCollector(), usage = new FakeUsage();
    try {
      await expect(startServer({ cfg, collector: collector as any, usage: usage as any, webRoot: tmpdir(), port }))
        .rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(collector.listenerCount('update') + usage.listenerCount('update')).toBe(0);
    } finally { await new Promise((r) => blocker.close(r)); }
  });
});

/** Opens /ws over a raw socket (no automatic pong, reads only when told) and resolves once the handshake is in. */
function rawWs(port: number) {
  return new Promise<import('node:net').Socket>((resolve, reject) => {
    const sock = connect(port, '127.0.0.1', () => sock.write('GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    let buf = '';
    const onData = (d: Buffer) => { buf += d.toString('latin1'); if (buf.includes('\r\n\r\n')) { sock.off('data', onData); resolve(sock); } };
    sock.on('data', onData);
    sock.on('error', reject);
  });
}
const closedWithin = (sock: import('node:net').Socket, ms: number) => new Promise<boolean>((r) => {
  if (sock.destroyed) return r(true);
  sock.on('close', () => r(true)); sock.on('error', () => r(true)); sock.on('data', () => {}); sock.resume();
  setTimeout(() => r(false), ms);
});

describe('websocket clients that stop listening', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('drops a client that stops reading instead of buffering every update in memory', async () => {
    const { port, collector } = await boot();
    const sock = await rawWs(port);
    sock.pause();
    collector.list = [{ key: 'local:me:s', state: 'working', pad: 'x'.repeat(1 << 20) }];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    for (let i = 0; i < 64; i++) {
      collector.emit('update'); vi.advanceTimersByTime(BROADCAST_MS);
      for (let j = 0; j < 5; j++) await new Promise((r) => setImmediate(r));
    }
    vi.useRealTimers();
    expect(await closedWithin(sock, 5000)).toBe(true);
  }, 20_000);

  it('terminates a client that stops answering pings, and keeps one that answers', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { port } = await boot();
    const silent = await rawWs(port);
    silent.on('data', () => {}); // reads, but never pongs
    const live = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => live.once('message', r));
    for (let i = 0; i < 3; i++) {
      const pinged = new Promise((r) => live.once('ping', r));
      vi.advanceTimersByTime(30_000);
      await pinged; // ws has already written its automatic pong
      // A ping of our own sent behind that pong: its answer means the server has read the pong, without timing anything.
      const ponged = new Promise((r) => live.once('pong', r));
      live.ping();
      await ponged;
    }
    expect(await closedWithin(silent, 5000)).toBe(true);
    expect(live.readyState).toBe(WebSocket.OPEN);
    live.close();
  }, 20_000);
});

describe('broadcast', () => {
  it('coalesces a burst of updates into a few messages that end on the latest state', async () => {
    const { port, collector } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: any[] = [];
    await new Promise<void>((r) => ws.on('message', (m) => { msgs.push(JSON.parse(String(m))); if (msgs.length === 1) r(); }));
    for (let i = 0; i < 100; i++) { collector.list = [{ key: 'local:me:s', state: 'working', n: i }]; collector.emit('update'); }
    await new Promise((r) => setTimeout(r, BROADCAST_MS * 2 + 100));
    expect(msgs.length).toBeLessThanOrEqual(3);
    expect(msgs.at(-1).sessions[0].n).toBe(99);
    ws.close();
  });

  it('keeps sending after the system clock steps backwards', async () => {
    const { port, collector } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const msgs: any[] = [];
    await new Promise<void>((r) => ws.on('message', (m) => { msgs.push(JSON.parse(String(m))); if (msgs.length === 1) r(); }));
    collector.list = [{ key: 'local:me:s', state: 'working', n: 1 }]; collector.emit('update');
    await new Promise((r) => setTimeout(r, 50));
    vi.setSystemTime(Date.now() - 3600_000); // an NTP / Hyper-V time-sync step; mocks Date only
    try {
      collector.list = [{ key: 'local:me:s', state: 'working', n: 2 }]; collector.emit('update');
      await new Promise((r) => setTimeout(r, BROADCAST_MS * 2 + 100));
    } finally { vi.useRealTimers(); }
    expect(msgs.map((m) => m.sessions[0].n)).toEqual([undefined, 1, 2]);
    ws.close();
  });

  it('keeps a failing state read out of the emitter that reported the update', async () => {
    const { port, collector } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once('message', r));
    collector.sessions = () => { throw new Error('boom'); };
    expect(() => collector.emit('update')).not.toThrow();
    ws.close();
  });
});

/** Sends one raw request line and headers; returns the status code. */
const rawStatus = (port: number, head: string) => new Promise<number>((resolve, reject) => {
  const sock = connect(port, '127.0.0.1', () => sock.write(head + '\r\nConnection: close\r\n\r\n'));
  let buf = '';
  sock.on('data', (d) => { buf += d; });
  sock.on('end', () => resolve(Number(buf.split(' ')[1])));
  sock.on('error', reject);
});

describe('adversarial requests', () => {
  it('never serves a file outside the web root, however the path is encoded', async () => {
    const { port } = await boot();
    const paths = ['/../../../../etc/passwd', '/..%2f..%2f..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/%2e%2e/etc/passwd', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      '/..%5c..%5c..%5cetc/passwd', '/..%252f..%252fetc/passwd', '/%2fetc%2fpasswd', '//etc/passwd', '/\\..\\..\\etc\\passwd', '../../etc/passwd', '/etc/passwd%00.html'];
    for (const p of paths) {
      const code = await rawStatus(port, `GET ${p} HTTP/1.1\r\nHost: 127.0.0.1`);
      expect([400, 404], p).toContain(code);
    }
  });

  it('answers 404, not 500, for a directory or a NUL byte, and 400 for a bad escape', async () => {
    const { port } = await boot();
    expect(await rawStatus(port, 'GET /%00 HTTP/1.1\r\nHost: 127.0.0.1')).toBe(404);
    expect(await rawStatus(port, 'GET /nope/ HTTP/1.1\r\nHost: 127.0.0.1')).toBe(404);
    expect(await rawStatus(port, 'GET /%E0%A4%A HTTP/1.1\r\nHost: 127.0.0.1')).toBe(400);
  });

  it('refuses look-alike hosts and origins, a missing Host, and the null origin', async () => {
    const { port } = await boot();
    for (const host of ['localhost.evil.example', '127.0.0.1.nip.io', 'evil.example', '0.0.0.0', 'localhost.', '[::ffff:127.0.0.1]', '127.0.0.1:' + port + '.evil.example']) {
      expect(await rawStatus(port, `GET /api/state HTTP/1.1\r\nHost: ${host}`), host).toBe(403);
    }
    expect(await rawStatus(port, 'GET /api/state HTTP/1.0')).toBe(403);
    for (const origin of ['null', 'http://localhost.evil.example', 'file://', 'chrome-extension://abc', 'http://127.0.0.1.nip.io']) {
      expect(await rawStatus(port, `GET /api/state HTTP/1.1\r\nHost: 127.0.0.1\r\nOrigin: ${origin}`), origin).toBe(403);
    }
    const evilWs = await rawStatus(port, `GET /ws HTTP/1.1\r\nHost: evil.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13`);
    expect(evilWs).toBeGreaterThanOrEqual(400);
  });

  it('runs no route handler for a refused request', async () => {
    let called = false;
    const { port } = await boot([() => { called = true; return false; }]);
    expect(await rawStatus(port, 'GET /x HTTP/1.1\r\nHost: evil.example')).toBe(403);
    expect(called).toBe(false);
  });

  it('keeps credentials and config paths out of /api/state and /usage', async () => {
    const { base } = await boot();
    const body = await (await fetch(base + '/api/state')).text() + await (await fetch(base + '/usage')).text();
    expect(body).not.toMatch(/configDir|accessToken|refreshToken|credentials/);
  });
});

describe('close', () => {
  it('resolves promptly with an idle keep-alive connection, a websocket and a request still in flight', async () => {
    const hang: RouteHandler = (_q, _r, url) => url.pathname === '/hang' ? new Promise<boolean>(() => {}) : false;
    const { port, base } = await boot([hang]);
    const { Agent } = await import('node:http');
    const agent = new Agent({ keepAlive: true });
    await new Promise<void>((r) => request({ host: '127.0.0.1', port, path: '/healthz', agent }, (res) => { res.resume(); res.on('end', () => r()); }).end());
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((r) => ws.once('message', r));
    request({ host: '127.0.0.1', port, path: '/hang' }).on('error', () => {}).end();
    await new Promise((r) => setTimeout(r, 50));
    const t = Date.now();
    const done = await Promise.race([close!().then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))]);
    close = undefined;
    expect(done).toBe(true);
    expect(Date.now() - t).toBeLessThan(1000);
    agent.destroy();
    void base;
  }, 10_000);
});

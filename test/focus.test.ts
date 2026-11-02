// The voice layer's "show it on the tablet": POST /api/action {action:'focus'} -> FocusBus -> { type: 'focus' } on /ws
// -> the board opens that session's focus view (now, or once the session appears).
import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createActionRoutes } from '../src/actions/routes.js';
import { createActionService } from '../src/actions/service.js';
import type { ActionApi } from '../src/actions/types.js';
import { parseConfig } from '../src/config.js';
import { FocusBus } from '../src/focus-bus.js';
import { startServer } from '../src/server.js';
import { RemoteFocus, WAIT_MS } from '../web/src/remote-focus.js';

const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: a, label: A, colour: "#fff", host: local, configDir: /x}]
`);
const S = { key: 'local:a:s1', host: 'local', account: 'a', sessionId: 's1', pid: 1, name: 'alpha', hostOnline: true } as any;

describe('service focus', () => {
  it('raises the bus for a listed session and changes nothing else', async () => {
    const bus = new FocusBus();
    const got: string[] = [];
    bus.on('focus', (k) => got.push(k));
    const svc = createActionService({ cfg, sessions: () => [S], probe: async () => { throw new Error('no probe'); }, focus: bus });
    expect(await svc.focus!('local:a:s1')).toEqual({ ok: true, message: 'Showing alpha on the board' });
    expect(got).toEqual(['local:a:s1']);
  });
  it('fails for an unknown session (nothing raised) and as unsupported without a bus', async () => {
    const bus = new FocusBus();
    const got: string[] = [];
    bus.on('focus', (k) => got.push(k));
    const svc = createActionService({ cfg, sessions: () => [S], probe: async () => ({}), focus: bus });
    expect(await svc.focus!('nope')).toMatchObject({ ok: false, error: 'unknown_session' });
    expect(got).toEqual([]);
    const none = createActionService({ cfg, sessions: () => [S], probe: async () => ({}) });
    expect(await none.focus!('local:a:s1')).toMatchObject({ ok: false, error: 'unsupported' });
  });
});

describe('focus route', () => {
  let srv: Server | undefined;
  afterEach(() => { srv?.close(); srv = undefined; });
  async function boot(api: Partial<ActionApi>) {
    const h = createActionRoutes(api as ActionApi, { mode: 'live' });
    srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    return (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-clayclaude': '1' }) =>
      fetch(base + '/api/action', { method: 'POST', headers, body: JSON.stringify(body) });
  }
  it('dispatches to api.focus with only the session id, under the usual POST rules', async () => {
    const calls: unknown[][] = [];
    const post = await boot({ focus: async (...a: unknown[]) => { calls.push(a); return { ok: true, message: 'm' }; } } as any);
    const r = await post({ action: 'focus', sessionId: 'k', extra: 'x' });
    expect(r.status).toBe(200);
    expect(calls).toEqual([['k']]);
    expect((await post({ action: 'focus', sessionId: 'k' }, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await post({ action: 'focus' })).status).toBe(400);
    expect(calls).toHaveLength(1);
  });
  it('answers unsupported (422) when the api has no focus (the demo)', async () => {
    const post = await boot({});
    const r = await post({ action: 'focus', sessionId: 'k' });
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ ok: false, error: 'unsupported' });
  });
});

describe('server focus broadcast', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });
  it('pushes { type: focus, sessionId } to every connected board, and stops on close', async () => {
    const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
    writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
    const collector = Object.assign(new EventEmitter(), { sessions: () => [S] });
    const usage = Object.assign(new EventEmitter(), { usage: () => [], publicShape: () => ({}) });
    const focus = new FocusBus();
    const s = await startServer({ cfg, collector: collector as any, usage: usage as any, webRoot: web, port: 0, focus });
    close = s.close;
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
    const msgs: any[] = [];
    await new Promise<void>((r) => ws.on('message', (m) => { msgs.push(JSON.parse(String(m))); if (msgs.length === 1) r(); }));
    const second = new Promise<void>((r) => ws.on('message', () => { if (msgs.length === 2) r(); }));
    focus.request('local:a:s1');
    await second;
    expect(msgs[1]).toEqual({ type: 'focus', sessionId: 'local:a:s1' });
    ws.close();
    await close(); close = undefined;
    expect(focus.listenerCount('focus')).toBe(0);
  });
});

describe('RemoteFocus (board)', () => {
  it('opens a shown session at once', () => {
    const f = new RemoteFocus();
    expect(f.request('k', () => true, 0)).toBe('k');
    expect(f.onState(() => true, 1)).toBeNull();
  });
  it('keeps a session not shown yet and opens it when it appears, once', () => {
    const f = new RemoteFocus();
    let shown = false;
    expect(f.request('k', () => shown, 0)).toBeNull();
    expect(f.onState(() => shown, 1000)).toBeNull();
    shown = true;
    expect(f.onState(() => shown, 2000)).toBe('k');
    expect(f.onState(() => shown, 3000)).toBeNull();
  });
  it('drops a request that waited past WAIT_MS, and a newer request replaces an older one', () => {
    const f = new RemoteFocus();
    f.request('old', () => false, 0);
    expect(f.onState(() => true, WAIT_MS + 1)).toBeNull();
    f.request('a', () => false, 0);
    f.request('b', () => false, 0);
    expect(f.onState((k) => k === 'a' || k === 'b', 10)).toBe('b');
  });
});

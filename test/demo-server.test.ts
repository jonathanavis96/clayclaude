import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createDemo } from '../src/demo/index.js';
import { createActionRoutes } from '../src/actions/routes.js';
import { startServer } from '../src/server.js';

let close: (() => Promise<void>) | undefined;
let stop: (() => void) | undefined;
afterEach(async () => { await close?.(); stop?.(); close = stop = undefined; });

async function boot() {
  const demo = createDemo();
  const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  const s = await startServer({ cfg: demo.cfg, collector: demo.collector as never, usage: demo.usage as never, webRoot: web, port: 0,
    handlers: [createActionRoutes(demo.api, { mode: 'demo', publicConfig: demo.publicConfig })] });
  close = s.close; stop = demo.stop;
  const base = `http://127.0.0.1:${s.port}`;
  const post = (body: object) => fetch(base + '/api/action', { method: 'POST', headers: { 'content-type': 'application/json', 'x-clayclaude': '1', origin: base }, body: JSON.stringify(body) });
  return { base, post, port: s.port };
}

describe('demo over http', () => {
  it('serves state with all six states and answers through the real routes', async () => {
    const { base, post } = await boot();
    const state = await (await fetch(base + '/api/state')).json();
    expect(new Set(state.sessions.map((s: any) => s.state)).size).toBe(6);
    expect(state.usage).toHaveLength(3);
    expect((await (await fetch(base + '/api/meta')).json()).mode).toBe('demo');
    const key = state.sessions.find((s: any) => s.name === 'tidepool-ui').key;
    const p: any = await (await post({ action: 'prompt', sessionId: key })).json();
    expect(p.prompt.kind).toBe('menu');
    const a = await post({ action: 'answer', sessionId: key, promptHash: p.prompt.hash, choice: '1' });
    expect(a.status).toBe(200);
    expect((await post({ action: 'answer', sessionId: key, promptHash: p.prompt.hash, choice: '1' })).status).toBe(422);
  });
  it('pushes updates over the websocket', async () => {
    const { port } = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const first: any = await new Promise((r) => ws.on('message', (m) => r(JSON.parse(String(m)))));
    expect(first.sessions.length).toBeGreaterThan(5);
    ws.close();
  });
});

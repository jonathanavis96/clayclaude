import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { RateLimit, createActionRoutes } from '../src/actions/routes.js';
import { fail, type ActionApi } from '../src/actions/types.js';

const calls: unknown[][] = [];
const rec = (name: string, r: unknown) => async (...a: unknown[]) => { calls.push([name, ...a]); return r as never; };
const api: ActionApi = {
  open: rec('open', { ok: true, message: 'opened' }),
  attach: rec('attach', fail('unknown_session', 'no such session')),
  readPrompt: rec('prompt', { ok: true, prompt: { kind: 'none', hash: 'h', title: '', detail: '', options: [], quickReplies: [] } }),
  answer: rec('answer', fail('prompt_changed', 'changed')),
  launch: rec('launch', { ok: true, message: 'started' }),
  launchOptions: rec('opts', { accounts: [] }),
  repos: rec('repos', { ok: true, repos: [] }),
  summary: rec('summary', { ok: true, summary: { files: [], tools: [], toolCount: 0, tokensIn: 0, tokensOut: 0 } }),
  rename: rec('rename', { ok: true, message: 'Renamed', name: 'n' }),
} as ActionApi;
let srv: Server | undefined;
afterEach(() => { srv?.close(); srv = undefined; calls.length = 0; });

async function boot() {
  const h = createActionRoutes(api, { mode: 'demo' });
  srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end('nope'); } });
  await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  const post = (body: unknown, headers: Record<string, string> = { 'content-type': 'application/json', 'x-clayclaude': '1' }) =>
    fetch(base + '/api/action', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });
  return { base, post };
}

describe('action routes', () => {
  it('dispatches each action to the api and maps errors to status codes', async () => {
    const { post } = await boot();
    expect((await post({ action: 'open', sessionId: 'a' })).status).toBe(200);
    expect((await post({ action: 'attach', sessionId: 'a' })).status).toBe(404);
    expect((await post({ action: 'answer', sessionId: 'a', promptHash: 'h', choice: '1' })).status).toBe(409);
    expect((await post({ action: 'launch', account: 'x', repo: '/r' })).status).toBe(200);
    expect(calls.find((c) => c[0] === 'launch')![1]).toEqual({ account: 'x', repo: '/r', options: {} });
  });
  it('rejects a request without the custom header or JSON type (cross-site form posts)', async () => {
    const { post } = await boot();
    expect((await post({ action: 'open', sessionId: 'a' }, { 'content-type': 'application/json' })).status).toBe(403);
    expect((await post('action=open', { 'content-type': 'application/x-www-form-urlencoded', 'x-clayclaude': '1' })).status).toBe(403);
    expect(calls).toHaveLength(0);
  });
  it('validates bodies: unknown action, both choice and text, oversized body, bad JSON', async () => {
    const { post } = await boot();
    expect((await post({ action: 'rm -rf' })).status).toBe(400);
    expect((await post({ action: 'answer', sessionId: 'a', promptHash: 'h', choice: '1', text: 'x' })).status).toBe(400);
    expect((await post({ action: 'answer', sessionId: 'a', promptHash: 'h' })).status).toBe(400);
    expect((await post('{nope')).status).toBe(400);
    expect((await post(JSON.stringify({ action: 'prompt', sessionId: 'x'.repeat(40_000) }))).status).toBe(413);
    expect(calls).toHaveLength(0);
  });
  // The tablet names things; it never supplies a command, binary, directory, host or extra flag.
  it('passes on only the known fields: extra keys (bin, args, host, cwd, tmux) never reach the api', async () => {
    const { post } = await boot();
    expect((await post({ action: 'launch', account: 'x', repo: '/r', bin: '/bin/sh', host: 'build-box', configDir: '/tmp', tmuxSession: '#(id)',
      options: { model: 'opus', effort: 'high', remoteControl: true, openOnPc: false, args: ['--dangerously-skip-permissions'], claudeBin: 'sh' } })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['launch', { account: 'x', repo: '/r', options: { model: 'opus', effort: 'high', remoteControl: true, openOnPc: false } }]);
    await post({ action: 'answer', sessionId: 'a', promptHash: 'h', text: 'hi', keys: ['C-c'], literal: false, pane: '%0' });
    expect(calls.at(-1)).toEqual(['answer', { sessionId: 'a', promptHash: 'h', text: 'hi' }]);
    expect((await post('{"action":"answer","sessionId":"a","promptHash":"h","__proto__":{"text":"x","choice":"1"}}')).status).toBe(400);
    await post({ action: 'open', sessionId: 'a', tmux: 'other:@1.%1', bridgeSessionId: 'session_evil' });
    expect(calls.at(-1)).toEqual(['open', 'a']);
    // Wrong types are refused, not coerced.
    for (const bad of [{ action: 'answer', sessionId: 'a', promptHash: 'h', choice: 1 }, { action: 'launch', account: 'x', repo: '/r', options: { remoteControl: 'yes' } },
      { action: 'launch', account: 'x', repo: ['/r'] }, { action: 'prompt', sessionId: { $ne: '' } }, { action: 'answer', sessionId: 'a', promptHash: 'h', choice: '12345' }])
      expect((await post(bad)).status).toBe(400);
    expect(calls).toHaveLength(3);
  });
  it('serves the GET endpoints and ignores other paths', async () => {
    const { base } = await boot();
    expect((await (await fetch(base + '/api/meta')).json()).mode).toBe('demo');
    expect((await fetch(base + '/api/launch/options')).status).toBe(200);
    expect((await fetch(base + '/api/repos?account=me')).status).toBe(200);
    expect((await fetch(base + '/api/nothing')).status).toBe(404);
    expect((await fetch(base + '/other')).status).toBe(404);
  });
  it('rate-limits action posts before doing anything', async () => {
    let t = 0;
    const limit = new RateLimit(3, 10_000, () => t);
    const h = createActionRoutes(api, { mode: 'demo', rateLimit: limit });
    srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const post = () => fetch(`http://127.0.0.1:${(srv!.address() as any).port}/api/action`, { method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clayclaude': '1' }, body: JSON.stringify({ action: 'open', sessionId: 'a' }) });
    expect([(await post()).status, (await post()).status, (await post()).status]).toEqual([200, 200, 200]);
    expect((await post()).status).toBe(429);
    expect(calls).toHaveLength(3);
    t = 10_001;
    expect((await post()).status).toBe(200);
  });
  // Task 46: the permission mode and the bypass confirm, typed and bounded (the action itself checks the values).
  it('passes a permission mode and the bypass confirm through, typed; refuses wrong types', async () => {
    const { post } = await boot();
    expect((await post({ action: 'launch', account: 'x', repo: '/r', options: { model: 'claude-opus-4-8', permissionMode: 'bypassPermissions', confirmBypass: true } })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['launch', { account: 'x', repo: '/r', options: { model: 'claude-opus-4-8', permissionMode: 'bypassPermissions', confirmBypass: true } }]);
    for (const bad of [{ action: 'launch', account: 'x', repo: '/r', options: { permissionMode: 1 } }, { action: 'launch', account: 'x', repo: '/r', options: { permissionMode: 'x'.repeat(33) } },
      { action: 'launch', account: 'x', repo: '/r', options: { confirmBypass: 'yes' } }])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(calls).toHaveLength(1);
  });
  // Task 42a: the launch Name and the rename sheet's tmux tick are the only new fields, typed and bounded.
  it('passes a launch name and a rename tmux flag through, typed; refuses wrong types', async () => {
    const { post } = await boot();
    expect((await post({ action: 'launch', account: 'x', repo: '/r', options: { name: 'api work' } })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['launch', { account: 'x', repo: '/r', options: { name: 'api work' } }]);
    expect((await post({ action: 'rename', sessionId: 'a', name: 'n', tmux: true })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['rename', 'a', 'n', { tmux: true }]);
    expect((await post({ action: 'rename', sessionId: 'a', name: 'n' })).status).toBe(200);
    expect(calls.at(-1)).toEqual(['rename', 'a', 'n', { tmux: false }]);
    for (const bad of [{ action: 'launch', account: 'x', repo: '/r', options: { name: 7 } }, { action: 'launch', account: 'x', repo: '/r', options: { name: 'x'.repeat(401) } },
      { action: 'rename', sessionId: 'a', name: 'n', tmux: 'yes' }])
      expect((await post(bad)).status, JSON.stringify(bad)).toBe(400);
    expect(calls).toHaveLength(3);
  });
});

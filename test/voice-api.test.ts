// The voice layer's two additions (used by an external voice assistant):
// GET /api/message (a session's full last assistant message) and a launch's first prompt.
import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { appendFileSync } from 'node:fs';
import { createActionRoutes } from '../src/actions/routes.js';
import { fail, type ActionApi } from '../src/actions/types.js';
import { lastAssistantMessage, MAX_MESSAGE_CHARS } from '../src/core/summary.js';
import { launchArgv, validateOptions, type CliCaps } from '../src/actions/launch.js';
import { createActionService } from '../src/actions/service.js';
import { parseConfig } from '../src/config.js';
import { runProbeSync, makeDir, writeJson } from './helpers/probe.js';

const J = (o: object) => JSON.stringify(o);
const asst = (id: string, ts: string, content: object[], extra: object = {}) => J({ type: 'assistant', timestamp: ts, message: { id, content }, ...extra });

describe('lastAssistantMessage', () => {
  it('returns every text block of the newest reply that has text, joined, skipping a tool-only turn after it', () => {
    const long = 'x'.repeat(1500);
    const m = lastAssistantMessage([
      asst('m1', '2026-10-21T10:00:00Z', [{ type: 'text', text: 'old' }]),
      asst('m2', '2026-10-21T10:00:05Z', [{ type: 'text', text: 'First part.' }]),
      asst('m2', '2026-10-21T10:00:06Z', [{ type: 'tool_use', id: 't', name: 'Read', input: {} }]),
      asst('m2', '2026-10-21T10:00:07Z', [{ type: 'text', text: long }]),
      J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'r' }] } }),
      asst('m3', '2026-10-21T10:00:09Z', [{ type: 'tool_use', id: 'u', name: 'Bash', input: { command: 'ls' } }]),
      '{bad',
    ]);
    expect(m).toEqual({ text: `First part.\n\n${long}`, at: Date.parse('2026-10-21T10:00:07Z'), chars: 13 + 1500 });
  });
  it('caps the text and says so; null when no reply has text; ignores a sub-agent turn', () => {
    const m = lastAssistantMessage([asst('a', 'x', [{ type: 'text', text: 'y'.repeat(70_000) }])]);
    expect(m).toMatchObject({ chars: 70_000, truncated: true, at: null });
    expect(m!.text.length).toBe(MAX_MESSAGE_CHARS);
    // The probe cuts a block at textClip and records its length before the cut; `chars` counts that length.
    const clipped = lastAssistantMessage([asst('a', 'x', [{ type: 'text', text: 'y'.repeat(MAX_MESSAGE_CHARS + 1), textChars: 100_000 }])]);
    expect(clipped).toMatchObject({ chars: 100_000, truncated: true });
    expect(lastAssistantMessage([asst('a', 'x', [{ type: 'tool_use', name: 'Read', input: {} }])])).toBeNull();
    expect(lastAssistantMessage([asst('a', '2026-10-21T10:00:00Z', [{ type: 'text', text: 'main' }]),
      asst('b', '2026-10-21T10:00:01Z', [{ type: 'text', text: 'side' }], { isSidechain: true })])!.text).toBe('main');
  });
});

describe('probe snapshot textClip', () => {
  it('keeps assistant text up to textClip while every other string stays at clip', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', '1.json'), { pid: 999999, sessionId: 'tc', cwd: '/x', startedAt: 1 });
    const t = join(d, 'projects', '-x', 'tc.jsonl');
    appendFileSync(t, J({ type: 'user', message: { content: 'u'.repeat(900) } }) + '\n');
    appendFileSync(t, asst('m', '2026-10-21T10:00:00Z', [{ type: 'text', text: 'a'.repeat(900) }, { type: 'tool_use', id: 't', name: 'Bash', input: { command: 'c'.repeat(900) } }]) + '\n');
    appendFileSync(t, '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], only: 'tc', clip: 100, textClip: 500 });
    const lines = r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l));
    expect(lines[0].message.content.length).toBe(100);
    expect(lines[1].message.content[0].text.length).toBe(500);
    expect(lines[1].message.content[0].textChars).toBe(900);   // the length before the clip, for `chars`
    expect(lines[1].message.content[1].input.command.length).toBe(100);
    const plain = runProbeSync({ mode: 'snapshot', dirs: [d], only: 'tc', clip: 100 });
    expect(JSON.parse(plain.dirs[0].registries[0].transcript[1]).message.content[0].text.length).toBe(100);
  });
});

describe('service lastMessage', () => {
  const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: a, label: A, colour: "#fff", host: local, configDir: /x}]
`);
  const S = (over: object) => ({ key: 'k', host: 'local', account: 'a', sessionId: 'sid', pid: 1, name: 'n', hostOnline: true, ...over }) as any;
  it('asks the probe for just that session with a large textClip and returns the full text', async () => {
    const reqs: any[] = [];
    const probe = async (_h: unknown, req: any) => (reqs.push(req), { ok: true, dirs: [{ registries: [{ data: { pid: 1 }, live: true, transcript: [asst('m', '2026-10-21T10:00:00Z', [{ type: 'text', text: 'z'.repeat(2000) }])] }] }] });
    const svc = createActionService({ cfg, sessions: () => [S({})], probe });
    expect(await svc.lastMessage('k')).toEqual({ ok: true, text: 'z'.repeat(2000), at: Date.parse('2026-10-21T10:00:00Z'), chars: 2000 });
    expect(reqs[0]).toMatchObject({ mode: 'snapshot', only: 'sid', dirs: ['/x'] });
    expect(reqs[0].textClip).toBeGreaterThan(MAX_MESSAGE_CHARS);
  });
  it('fails as no_prompt with no reply yet, and for an unknown or offline session', async () => {
    const empty = createActionService({ cfg, sessions: () => [S({})], probe: async () => ({ ok: true, dirs: [{ registries: [] }] }) });
    expect(await empty.lastMessage('k')).toEqual(fail('no_prompt', 'no assistant message yet'));
    expect(await empty.lastMessage('nope')).toMatchObject({ ok: false, error: 'unknown_session' });
    const off = createActionService({ cfg, sessions: () => [S({ hostOnline: false })], probe: async () => ({}) });
    expect(await off.lastMessage('k')).toMatchObject({ ok: false, error: 'host_offline' });
  });
});

describe('GET /api/message', () => {
  let srv: Server | undefined;
  afterEach(() => { srv?.close(); srv = undefined; });
  it('answers with the api result, needs no header, and maps a failure to its status', async () => {
    const seen: string[] = [];
    const api = {
      lastMessage: async (id: string) => (seen.push(id), id === 'k' ? { ok: true, text: 'full', at: 5, chars: 4 } : fail('unknown_session', 'gone')),
    } as unknown as ActionApi;
    const h = createActionRoutes(api, { mode: 'live' });
    srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    const ok = await fetch(`${base}/api/message?sessionId=k`);
    expect([ok.status, await ok.json()]).toEqual([200, { ok: true, text: 'full', at: 5, chars: 4 }]);
    expect((await fetch(`${base}/api/message?sessionId=other`)).status).toBe(404);
    expect(seen).toEqual(['k', 'other']);
  });
});

describe('launch prompt', () => {
  const cfg = parseConfig(`
hosts: [{id: local, tmuxSession: t, claudeBin: claude, repoRoots: [/r]}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]
`);
  const caps: CliCaps = { efforts: ['low'], remoteControl: false, model: true, name: true, permissionModes: ['acceptEdits'] };
  const argv = (prompt?: string) => {
    const options = validateOptions(cfg, caps, { name: 'voice', permissionMode: 'acceptEdits', ...(prompt !== undefined ? { prompt } : {}) });
    return launchArgv({ host: cfg.hosts[0], account: cfg.accounts[0], repoPath: '/r/x', options, windowName: 'x' });
  };
  it('is the last argv element, one element after `--`, unescaped, newlines and tabs kept', () => {
    const a = argv('--help me; rm -rf / $(id) "quoted"\n\tsecond line');
    expect(a.slice(-2)).toEqual(['--', '--help me; rm -rf / $(id) "quoted"\n\tsecond line']);
    expect(a.indexOf('--permission-mode')).toBeLessThan(a.indexOf('--'));
    expect(argv().includes('--')).toBe(false);
    expect(argv('   ').includes('--')).toBe(false); // nothing to say
  });
  it('refuses other control characters and an over-long prompt', () => {
    for (const bad of ['a\u0000b', 'a\u0007b', 'a\u001bb', 'a\rb', 'x'.repeat(4001)])
      expect(() => argv(bad), JSON.stringify(bad.slice(0, 8))).toThrow();
  });
  it('the route passes `prompt` on, typed and bounded', async () => {
    const calls: unknown[] = [];
    const api = { launch: async (req: unknown) => (calls.push(req), { ok: true, message: 'Started' }) } as unknown as ActionApi;
    const h = createActionRoutes(api, { mode: 'live' });
    const srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    try {
      const post = (body: unknown) => fetch(`http://127.0.0.1:${(srv.address() as any).port}/api/action`, { method: 'POST',
        headers: { 'content-type': 'application/json', 'x-clayclaude': '1' }, body: JSON.stringify(body) });
      expect((await post({ action: 'launch', account: 'me', repo: '/r/x', options: { prompt: 'why is this bug happening' } })).status).toBe(200);
      expect(calls.at(-1)).toEqual({ account: 'me', repo: '/r/x', options: { prompt: 'why is this bug happening' } });
      expect((await post({ action: 'launch', account: 'me', repo: '/r/x', options: { prompt: 7 } })).status).toBe(400);
      expect((await post({ action: 'launch', account: 'me', repo: '/r/x', options: { prompt: 'x'.repeat(4001) } })).status).toBe(400);
      expect(calls).toHaveLength(1);
    } finally { srv.close(); }
  });
});

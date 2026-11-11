import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE, PYTHON } from './helpers/probe.js';
import { startCloudStub, type CloudStub, type CloudStubOpts } from './helpers/stub-cloud.js';
import { parseConfig, type HostConfig } from '../src/config.js';
import { cloudAnswer, cloudPrompt, type CloudDeps } from '../src/actions/cloud.js';
import { SendGuard } from '../src/actions/answer.js';
import { cloudSession, mergeEntry } from '../src/cloud/reduce.js';

const execFileP = promisify(execFile);
const FIX = join(import.meta.dirname, 'fixtures/cloud');
const fix = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));
const LIST: any[] = fix('sessions.list.json').data;
const EVENTS: any[] = fix('ask-answered.events.json').data;
const RID = 'fb19b28a-0f4d-4870-a322-09bc2c25a699';
const ANSWER_AT = EVENTS.findIndex((e) => e.type === 'control_response' && e.response?.request_id === RID);
const PENDING = EVENTS.slice(0, ANSWER_AT);
const ASK_ID = 'session_01FixtureAskAnswered';
const id = (s: string) => `session_01Fixture${s}`;

function acct(expiresAt: number | null = Date.now() + 3600_000, extra: object = {}) {
  const d = mkdtempSync(join(tmpdir(), 'cc-cloud-'));
  writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'tok-SECRET-123', refreshToken: 'ref-SECRET-456', expiresAt, ...extra } })); // gitleaks:allow (test fake)
  chmodSync(join(d, '.credentials.json'), 0o600);
  writeFileSync(join(d, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-1', accountUuid: 'acc-1' } }));
  return d;
}

let stub: CloudStub | undefined;
afterEach(async () => { await stub?.close(); stub = undefined; });
async function serve(o: CloudStubOpts) { stub = await startCloudStub(o); return stub; }

async function probe(url: string, req: object): Promise<{ out: any; stdout: string }> {
  const { stdout } = await execFileP(PYTHON, [PROBE, JSON.stringify(req)], { encoding: 'utf8', env: { ...process.env, CLAYCLAUDE_API_URL: url } });
  return { out: JSON.parse(stdout), stdout };
}
async function cloud(url: string, account: object, extra: object = {}) {
  return probe(url, { mode: 'cloud', budgetMs: 20000, accounts: [{ key: 'main', configDir: acct(), ...account }], ...extra });
}
/** The ask session as the list shows it: one cloud session, so its events are read. */
const askItem = (status = 'requires_action', updated = '2026-11-11T10:58:43.189113Z') => ({ ...LIST[1], id: ASK_ID, session_status: status, updated_at: updated });
const rawEvents = (f: string) => fix(f).events;
/** A can_use_tool control_request event for the ask session. */
const toolReq = (rid: string, tool: string, input: unknown, uuid = `ev-${rid}`) => ({ type: 'control_request', uuid, request_id: rid,
  created_at: '2026-11-11T10:58:40Z', request: { subtype: 'can_use_tool', tool_name: tool, input, tool_use_id: `toolu_${rid}` } });
/** The requests the cloud mode reduces from `events`, read from a stub of its own that is closed after. */
async function reduced(events: object[]): Promise<any[]> {
  const s = await startCloudStub({ list: [askItem()], events: { [ASK_ID]: events } });
  try { return (await cloud(s.url, {})).out.accounts[0].sessions[0].events.requests; } finally { await s.close(); }
}

describe('probe cloud', () => {
  it('lists live cloud sessions only', async () => {
    const s = await serve({ list: LIST });
    const { out } = await cloud(s.url, {});
    const a = out.accounts[0];
    expect(a.ok).toBe(true);
    expect(a.sessions.map((x: any) => x.id)).toEqual([id('Running'), id('Asking'), id('Done'), id('Read')]);
    expect(a.login).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof out.nowMs).toBe('number');
  });

  it('sends the headers and never the token in output', async () => {
    const s = await serve({ list: LIST, events: { [id('Asking')]: PENDING } });
    const { stdout } = await cloud(s.url, {});
    expect(s.calls.length).toBeGreaterThan(1);
    for (const c of s.calls) {
      expect(c.headers).toMatchObject({
        'anthropic-beta': 'ccr-byoc-2025-07-29', 'anthropic-version': '2023-06-01', 'x-organization-uuid': 'org-1',
        authorization: 'Bearer tok-SECRET-123',
      });
      expect(c.headers['user-agent']).toMatch(/^claude-code\//);
    }
    expect(stdout).not.toContain('tok-SECRET');
    expect(stdout).not.toContain('ref-SECRET');
  });

  it('maps model, context and repo', async () => {
    const s = await serve({ list: LIST });
    const { out } = await cloud(s.url, {});
    const by = Object.fromEntries(out.accounts[0].sessions.map((x: any) => [x.id, x]));
    expect(by[id('Asking')]).toMatchObject({ model: 'claude-opus-5-5', contextUsed: 900000, contextMax: 1000000, repo: 'example/widgets', status: 'requires_action', unread: true, title: 'Asking fixture session' });
    expect(by[id('Done')].repo).toBeUndefined();
  });

  it('reduces a pending AskUserQuestion', async () => {
    const s = await serve({ list: [askItem()], events: { [ASK_ID]: PENDING } });
    const { out } = await cloud(s.url, {});
    const ev = out.accounts[0].sessions[0].events;
    const reqIdx = EVENTS.findIndex((e) => e.request_id === RID);
    expect(ev.requests).toHaveLength(1);
    expect(ev.requests[0]).toMatchObject({ requestId: RID, toolName: 'AskUserQuestion', eventId: '8185a837-a3d1-48b6-bf53-9ab2778b9d27', prevId: EVENTS[reqIdx - 1].uuid });
    expect(ev.requests[0].input.questions[0].question).toBe('Pick a colour for the test');
  });

  it('sends a request input whole with the host\'s hash of it; a long or deep one is clipped, marked truncated and has no hash', async () => {
    const cmd = 'echo ' + 'x'.repeat(600) + ' && rm -rf ./build';
    const content = 'line one\n' + 'y'.repeat(7000) + '\nlast';
    let deep: any = 'bottom';
    for (let i = 0; i < 70; i++) deep = [deep];
    const [whole, write, long, nested] = await reduced([toolReq('r1', 'Bash', { command: cmd }), toolReq('r2', 'Write', { file_path: '/w/a', content }),
      toolReq('r3', 'Write', { file_path: '/w/b', content: 'z'.repeat(9000) }), toolReq('r4', 'Bash', { command: 'x', extra: deep })]);
    expect(whole.input).toEqual({ command: cmd });
    expect(whole.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(whole.truncated).toBeUndefined();
    expect(write.input).toEqual({ file_path: '/w/a', content });
    expect(write.inputHash).not.toBe(whole.inputHash);
    for (const r of [long, nested]) {
      expect(r.truncated).toBe(true);
      expect(r.inputHash).toBeUndefined();
    }
    expect(long.input.content).toHaveLength(400);
    // Key order does not change the hash: it is over canonical JSON.
    const [same] = await reduced([toolReq('r5', 'Write', { content, file_path: '/w/a' })]);
    expect(same.inputHash).toBe(write.inputHash);
  });

  it('drops a request answered in the same batch', async () => {
    const s = await serve({ list: [askItem('idle', '2026-11-11T10:59:11.069397Z')], events: { [ASK_ID]: EVENTS } });
    const { out } = await cloud(s.url, {});
    const ev = out.accounts[0].sessions[0].events;
    expect(ev.requests).toEqual([]);
    expect(ev.resolved).toContain(RID);
  });

  it('events match the committed CloudRaw fixtures', async () => {
    let s = await serve({ list: [askItem()], events: { [ASK_ID]: PENDING } });
    let { out } = await cloud(s.url, {});
    expect(out.accounts[0].sessions[0].events).toEqual(rawEvents('ask-pending.raw.json'));
    await s.close(); stub = undefined;
    s = await serve({ list: [askItem('idle', '2026-11-11T10:59:11.069397Z')], events: { [ASK_ID]: EVENTS } });
    ({ out } = await cloud(s.url, { known: { [ASK_ID]: { updatedAt: '2026-11-11T00:00:00Z' } } }));
    expect(out.accounts[0].sessions[0].events).toEqual(rawEvents('ask-answered.raw.json'));
  });

  it('lines keep prompts and replies with a timestamp', async () => {
    const s = await serve({ list: [askItem('idle')], events: { [ASK_ID]: EVENTS } });
    const { out } = await cloud(s.url, {});
    const ev = out.accounts[0].sessions[0].events;
    const lines = ev.lines.map((l: string) => JSON.parse(l));
    const hello = lines.find((l: any) => l.type === 'user' && l.message?.content === 'hello from the tablet');
    expect(hello).toBeTruthy();
    expect(hello.timestamp).toBe(hello.created_at);
    const results = EVENTS.filter((e) => e.type === 'result');
    expect(ev.lastResultAt).toBe(results[1].created_at);
  });

  it('skips events when updatedAt is unchanged', async () => {
    const item = askItem();
    const s = await serve({ list: [item], events: { [ASK_ID]: PENDING } });
    const { out } = await cloud(s.url, { known: { [ASK_ID]: { afterId: 'x', updatedAt: item.updated_at } } });
    expect(s.calls.some((c) => c.path.includes('/events'))).toBe(false);
    expect('events' in out.accounts[0].sessions[0]).toBe(false);
  });

  it('reads only events after afterId, and stops at the page cap with more: true', async () => {
    const many = Array.from({ length: 3500 }, (_, i) => ({ type: 'system', subtype: 'status', uuid: `ev-${i}`, created_at: '2026-11-11T10:00:00Z' }));
    const s = await serve({ list: [askItem('running')], events: { [ASK_ID]: many } });
    const { out } = await cloud(s.url, { known: { [ASK_ID]: { afterId: 'ev-10', updatedAt: 'old' } } });
    const evCalls = s.calls.filter((c) => c.path.includes('/events'));
    expect(evCalls[0].path).toContain('after_id=ev-10');
    expect(evCalls).toHaveLength(3);
    const ev = out.accounts[0].sessions[0].events;
    expect(ev.more).toBe(true);
    expect(ev.lastId).toBe('ev-3010');
  });

  it('fetches also-ids missing from the list pages', async () => {
    const extra = { ...LIST[3], id: 'session_01FixtureOlder' };
    const gone = { ...LIST[3], id: 'session_01FixtureOldGone', session_status: 'archived' };
    const s = await serve({ list: LIST, single: { [extra.id]: extra, [gone.id]: gone } });
    const { out } = await cloud(s.url, { also: [extra.id, gone.id, 'session_01FixtureMissing', id('Running')] });
    const ids = out.accounts[0].sessions.map((x: any) => x.id);
    expect(ids).toContain(extra.id);
    expect(ids).not.toContain(gone.id);
    expect(ids).not.toContain('session_01FixtureMissing');
    expect(ids.filter((x: string) => x === id('Running'))).toHaveLength(1);
    expect(s.calls.some((c) => c.path.startsWith(`/v1/sessions/${id('Running')}?`))).toBe(false);
  });

  it('expired token makes no request', async () => {
    const s = await serve({ list: LIST });
    const { out, stdout } = await probe(s.url, { mode: 'cloud', accounts: [{ key: 'main', configDir: acct(Date.now() - 1000) }] });
    expect(out.accounts[0]).toMatchObject({ key: 'main', ok: false, expired: true, error: 'token expired (refresh is off)' });
    expect(s.calls).toHaveLength(0);
    expect(stdout).not.toContain('tok-SECRET');
  });

  it('no credentials file is noAuth', async () => {
    const s = await serve({ list: LIST });
    const d = mkdtempSync(join(tmpdir(), 'cc-cloud-'));
    const { out } = await probe(s.url, { mode: 'cloud', accounts: [{ key: 'none', configDir: d }] });
    expect(out.accounts[0]).toMatchObject({ key: 'none', ok: false, noAuth: true });
    expect(s.calls).toHaveLength(0);
  });

  it('429 reports status and retryAfterS', async () => {
    const s = await serve({ list: LIST, status: 429, retryAfter: '30' });
    const { out, stdout } = await cloud(s.url, {});
    expect(out.accounts[0]).toMatchObject({ ok: false, status: 429, retryAfterS: 30 });
    expect(stdout).not.toContain('tok-SECRET');
  });

  it('parses both launch-log layouts', async () => {
    const s = await serve({ list: [] });
    const run = async (p: string) => (await probe(s.url, { mode: 'cloud', launchLog: p, accounts: [] })).out;
    expect((await run(join(FIX, 'launches.local.tsv'))).launches).toEqual([{ sessionId: id('Running'), task: 'fix-login' }]);
    expect((await run(join(FIX, 'launches.gs.tsv'))).launches).toEqual([{ sessionId: id('Asking'), task: 'summary-v2' }]);
    expect((await run(join(FIX, 'no-such.tsv'))).launches).toEqual([]);
  });

  it('rejects bad requests', async () => {
    for (const bad of [{ pages: 9 }, { also: ['x; rm'] }, { known: [] }]) {
      const err: any = await execFileP(PYTHON, [PROBE, JSON.stringify({ mode: 'cloud', accounts: [{ key: 'k', configDir: '/x', ...bad }] })]).catch((e) => e);
      expect(err.code).toBe(2);
    }
  });
});

describe('probe cloud-answer', () => {
  const REQ = EVENTS.find((e) => e.request_id === RID);
  const PREV = EVENTS[EVENTS.indexOf(REQ) - 1].uuid;
  const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const outputs: string[] = [];
  async function answer(o: CloudStubOpts, ans: object, sid = ASK_ID) {
    const s = await serve(o);
    const r = await probe(s.url, { mode: 'cloud-answer', budgetMs: 12000, configDir: acct(), sessionId: sid, answer: ans });
    outputs.push(r.stdout);
    return { out: r.out, posts: s.calls.filter((c) => c.method === 'POST') };
  }
  const pending = (status = 'requires_action', events = PENDING): CloudStubOpts =>
    ({ list: [], single: { [ASK_ID]: askItem(status) }, events: { [ASK_ID]: events } });

  it('posts the AskUserQuestion answer as proven', async () => {
    const { out, posts } = await answer(pending(), { kind: 'choice', requestId: RID, fromId: PREV, label: 'Blue' });
    expect(out).toEqual({ ok: true, sent: 'choice' });
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe(`/v1/sessions/${ASK_ID}/events?beta=true`);
    expect(posts[0].headers['content-type']).toBe('application/json');
    const ev = posts[0].body.events[0];
    expect(ev.type).toBe('control_response');
    expect(ev.response.subtype).toBe('success');
    expect(ev.response.request_id).toBe(RID);
    expect(ev.response.response).toEqual({
      behavior: 'allow', toolUseID: 'toolu_01HmG9CwHfKfHVb3ZxtKR2rP', tool_name: 'AskUserQuestion',
      updatedInput: { questions: REQ.request.input.questions, answers: { 'Pick a colour for the test': 'Blue' } },
    });
  });

  it('reads from the start when fromId is null', async () => {
    const { out } = await answer(pending(), { kind: 'choice', requestId: RID, fromId: null, label: 'Red' });
    expect(out).toEqual({ ok: true, sent: 'choice' });
  });

  it('refuses a label that is not an option', async () => {
    const { out, posts } = await answer(pending(), { kind: 'choice', requestId: RID, fromId: PREV, label: 'Green' });
    expect(out).toMatchObject({ ok: false, code: 'bad_choice' });
    expect(posts).toHaveLength(0);
  });

  it('refuses when a later control_response answers the request', async () => {
    const { out, posts } = await answer(pending('requires_action', EVENTS), { kind: 'choice', requestId: RID, fromId: PREV, label: 'Blue' });
    expect(out).toMatchObject({ ok: false, code: 'not_pending' });
    expect(posts).toHaveLength(0);
  });

  it('refuses when the session is no longer requires_action', async () => {
    const { out, posts } = await answer(pending('idle'), { kind: 'choice', requestId: RID, fromId: PREV, label: 'Blue' });
    expect(out).toMatchObject({ ok: false, code: 'not_pending' });
    expect(posts).toHaveLength(0);
  });

  it('allow sends the input back unchanged', async () => {
    const [{ inputHash }] = await reduced(PENDING);
    const { out, posts } = await answer(pending(), { kind: 'allow', requestId: RID, fromId: PREV, inputHash });
    expect(out).toEqual({ ok: true, sent: 'allow' });
    expect(posts[0].body.events[0].response.response).toEqual({
      behavior: 'allow', toolUseID: 'toolu_01HmG9CwHfKfHVb3ZxtKR2rP', tool_name: 'AskUserQuestion', updatedInput: REQ.request.input,
    });
  });

  it('allow with a hash that is not of the input on the host is refused and posts nothing; deny needs no hash', async () => {
    const [{ inputHash }] = await reduced(PENDING);
    let { out, posts } = await answer(pending(), { kind: 'allow', requestId: RID, fromId: PREV, inputHash: 'b'.repeat(64) });
    expect(out).toMatchObject({ ok: false, code: 'changed' });
    expect(posts).toHaveLength(0);
    await stub!.close(); stub = undefined;
    // The input on the host changed since it was shown: the shown hash no longer matches.
    const edited = PENDING.map((e) => (e.request_id === RID ? { ...e, request: { ...e.request, input: { ...e.request.input, extra: 1 } } } : e));
    ({ out, posts } = await answer(pending('requires_action', edited), { kind: 'allow', requestId: RID, fromId: PREV, inputHash }));
    expect(out).toMatchObject({ ok: false, code: 'changed' });
    expect(posts).toHaveLength(0);
    await stub!.close(); stub = undefined;
    ({ out, posts } = await answer(pending(), { kind: 'allow', requestId: RID, fromId: PREV, inputHash }));
    expect(out).toEqual({ ok: true, sent: 'allow' });
    expect(posts).toHaveLength(1);
    await stub!.close(); stub = undefined;
    ({ out, posts } = await answer(pending(), { kind: 'deny', requestId: RID, fromId: PREV, inputHash: 'b'.repeat(64) }));
    expect(out).toEqual({ ok: true, sent: 'deny' });
  });

  it('a 401 or 403 from the API (a revoked token) is an auth error', async () => {
    for (const status of [401, 403]) {
      const { out, posts } = await answer({ ...pending(), status }, { kind: 'text', text: 'hi' });
      expect(out).toMatchObject({ ok: false, code: 'auth', status });
      expect(posts).toHaveLength(0);
      await stub!.close(); stub = undefined;
    }
  });

  it('a revoked token on the first account makes the board answer through the second', async () => {
    const dead = await startCloudStub({ ...pending(), status: 401 });
    const live = await startCloudStub({ ...pending(), list: [askItem()] });
    try {
      const cfg = parseConfig(`
hosts: [{id: local}, {id: gs, ssh: gs}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: ${acct()}, open: {type: tmux}}
  - {id: b, label: B, colour: "#fff", host: gs, configDir: ${acct()}, open: {type: tmux}}
`);
      const listed = (await cloud(live.url, {})).out.accounts[0].sessions[0];
      const entry = mergeEntry(undefined, listed);
      const s = cloudSession(entry, { account: 'a', host: 'local', hostOnline: true, lastSeen: 0 });
      const used: string[] = [];
      const d: CloudDeps = { cfg, guard: new SendGuard(() => 0),
        cloud: { entry: () => entry, poke: () => {}, accountsFor: () => cfg.accounts },
        probe: async (h: HostConfig, req: object) => { used.push(h.id); return (await probe(h.id === 'local' ? dead.url : live.url, req)).out; } };
      const v = cloudPrompt(s, entry, []);
      if ('ok' in v) throw new Error(v.message);
      expect(await cloudAnswer(d, s, { sessionId: s.key, promptHash: v.hash, choice: '2' })).toEqual({ ok: true, sent: 'Blue' });
      expect(used).toEqual(['local', 'gs']);
      expect(dead.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
      expect(live.calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    } finally {
      await dead.close(); await live.close();
    }
  });

  it('deny sends behavior deny with a message', async () => {
    const { out, posts } = await answer(pending(), { kind: 'deny', requestId: RID, fromId: PREV });
    expect(out).toEqual({ ok: true, sent: 'deny' });
    const r = posts[0].body.events[0].response.response;
    expect(r.behavior).toBe('deny');
    expect(typeof r.message).toBe('string');
    expect(r.message.length).toBeGreaterThan(0);
    expect(r.toolUseID).toBe('toolu_01HmG9CwHfKfHVb3ZxtKR2rP');
  });

  it('text posts a user event only when idle, the way `claude -p --cloud` sends it', async () => {
    let { out, posts } = await answer(pending('idle'), { kind: 'text', text: 'hi' });
    expect(out).toEqual({ ok: true, sent: 'text' });
    expect(posts).toHaveLength(1);
    // KNOWN-ISSUES #39: without anthropic-client-platform the session reads it as "Another Claude session sent a message".
    expect(posts[0].path).toBe(`/v1/code/sessions/${ASK_ID}/events`);
    expect(posts[0].headers['anthropic-client-platform']).toBe('claude_code_sdk');
    expect(posts[0].body.events).toHaveLength(1);
    const ev = posts[0].body.events[0].payload;
    expect(ev).toMatchObject({ type: 'user', session_id: ASK_ID, parent_tool_use_id: null, message: { role: 'user', content: 'hi' } });
    expect(ev.uuid).toMatch(UUID4);
    await stub!.close(); stub = undefined;
    ({ out, posts } = await answer(pending('running'), { kind: 'text', text: 'hi' }));
    expect(out).toMatchObject({ ok: false, code: 'busy' });
    expect(posts).toHaveLength(0);
    await stub!.close(); stub = undefined;
    ({ out, posts } = await answer(pending('requires_action'), { kind: 'text', text: 'hi' }));
    expect(out).toMatchObject({ ok: false, code: 'not_pending' });
    expect(posts).toHaveLength(0);
  });

  it('archived session is gone', async () => {
    let { out } = await answer(pending('archived'), { kind: 'text', text: 'hi' });
    expect(out).toMatchObject({ ok: false, code: 'gone' });
    await stub!.close(); stub = undefined;
    ({ out } = await answer({ list: [] }, { kind: 'text', text: 'hi' }, 'session_01FixtureNowhere'));
    expect(out).toMatchObject({ ok: false, code: 'gone' });
  });

  it('a failed POST is an http error with its status', async () => {
    const { out } = await answer({ ...pending('idle'), post: () => 429 }, { kind: 'text', text: 'hi' });
    expect(out).toMatchObject({ ok: false, code: 'http', status: 429 });
  });

  it('an expired token is an auth error and sends nothing', async () => {
    const s = await serve(pending());
    const { out, stdout } = await probe(s.url, { mode: 'cloud-answer', configDir: acct(Date.now() - 1000), sessionId: ASK_ID, answer: { kind: 'text', text: 'hi' } });
    outputs.push(stdout);
    expect(out).toMatchObject({ ok: false, code: 'auth' });
    expect(s.calls).toHaveLength(0);
  });

  it('never prints the token', () => {
    expect(outputs.length).toBeGreaterThan(5);
    for (const o of outputs) expect(o).not.toContain('tok-SECRET');
  });

  it('rejects bad requests', async () => {
    const base = { mode: 'cloud-answer', configDir: '/x', sessionId: ASK_ID };
    for (const bad of [
      { ...base, sessionId: 'session_x; rm' },
      { ...base, answer: { kind: 'text', text: '' } },
      { ...base, answer: { kind: 'text', text: 'x'.repeat(4001) } },
      { ...base, answer: { kind: 'choice', requestId: RID, label: 'x'.repeat(401) } },
      { ...base, answer: { kind: 'allow' } },
      { ...base, answer: { kind: 'allow', requestId: RID } },
      { ...base, answer: { kind: 'allow', requestId: RID, inputHash: 'xyz' } },
      { ...base, answer: { kind: 'nope' } },
    ]) {
      const err: any = await execFileP(PYTHON, [PROBE, JSON.stringify(bad)]).catch((e) => e);
      expect(err.code).toBe(2);
    }
  });
});

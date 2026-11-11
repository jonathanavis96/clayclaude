import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseConfig, type HostConfig } from '../src/config.js';
import { cloudAnswer, cloudMessage, cloudPrompt, cloudReadPrompt, type CloudDeps } from '../src/actions/cloud.js';
import { createActionService } from '../src/actions/service.js';
import { SendGuard } from '../src/actions/answer.js';
import { PERMISSION_OPTIONS } from '../src/actions/pane.js';
import type { Cmd } from '../src/actions/open.js';
import { cloudSession, mergeEntry, type CloudEntry } from '../src/cloud/reduce.js';
import type { CloudRaw, CloudRequest } from '../src/cloud/types.js';
import type { Fail, PromptView } from '../src/actions/types.js';

const FIX = join(import.meta.dirname, 'fixtures/cloud');
const raw = (f: string): CloudRaw => { const { _note, ...r } = JSON.parse(readFileSync(join(FIX, f), 'utf8')); return r; };
const PENDING = raw('ask-pending.raw.json');
const REQ_ID = 'fb19b28a-0f4d-4870-a322-09bc2c25a699';
const PREV_ID = '4758f8cd-8624-4e3e-a325-a111c9c53f84';

const cfg = parseConfig(`
browsers: { chrome: /c/chrome.exe }
hosts: [{id: local}, {id: gs, ssh: gs}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /c/a, open: {type: tmux}}
  - {id: b, label: B, colour: "#fff", host: gs, configDir: ~/.claude-b, open: {type: chrome, profileDirectory: "Profile 2"}}
`);
const lit = (o: Partial<CloudRaw> = {}): CloudRaw => ({
  id: 'session_01FixtureDone', title: 'Done', status: 'idle', unread: true, createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T09:00:00Z', ...o,
});
const req = (o: Partial<CloudRequest> = {}): CloudRequest => ({
  requestId: 'r1', eventId: 'e1', prevId: 'e0', toolName: 'Bash', input: { command: 'date' }, createdAt: '2026-11-11T09:00:00Z', ...o,
});
const ev = (o: object = {}) => ({ lines: [], requests: [], resolved: [], lastId: 'e1', more: false, ...o });
const ask = (questions: object[]) => lit({ id: 'session_01Ask', status: 'requires_action', events: ev({ requests: [req({ toolName: 'AskUserQuestion', input: { questions } })] }) });

function rig(raws: CloudRaw[], o: { probe?: (h: HostConfig, r: any) => Promise<unknown>; owners?: string[] } = {}) {
  const entries = new Map<string, CloudEntry>(raws.map((r) => [r.id, mergeEntry(undefined, r)]));
  const calls: { host: string; req: any }[] = [];
  const poke = vi.fn();
  const cloud = { entry: (id: string) => entries.get(id), poke,
    accountsFor: (id: string) => (entries.has(id) ? (o.owners ?? ['a', 'b']).map((x) => cfg.accounts.find((a) => a.id === x)!) : []) };
  const probe = async (h: HostConfig, r: any) => { calls.push({ host: h.id, req: r }); return o.probe ? o.probe(h, r) : { ok: true, sent: r.answer?.kind }; };
  const d: CloudDeps = { cfg, cloud, probe, guard: new SendGuard(() => 0) };
  const sessions = raws.map((r) => cloudSession(entries.get(r.id)!, { account: (o.owners ?? ['a'])[0], host: 'local', hostOnline: true, lastSeen: 0 }));
  const S = (id: string) => sessions.find((s) => s.sessionId === id)!;
  return { d, calls, poke, sessions, S, entries };
}
const view = (p: PromptView | Fail): PromptView => { if ('ok' in p) throw new Error(p.message); return p; };

describe('cloud actions', () => {
  it('menu prompt for a single AskUserQuestion', () => {
    const r = rig([PENDING]);
    const v = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, ['ok']));
    expect(v.kind).toBe('menu');
    expect(v.title).toBe('Pick a colour for the test');
    expect(v.options.map((x) => x.label)).toEqual(['Red', 'Blue']);
    expect(v.options.map((x) => x.key)).toEqual(['1', '2']);
    expect(v.options[0].description).toBe('Choose red');
    expect(v.quickReplies).toEqual([]);
  });

  it('several questions or multi-select is unsupported', () => {
    const q = { question: 'Q', options: [{ label: 'X' }, { label: 'Y' }] };
    for (const raw of [ask([q, { ...q, question: 'Q2' }]), ask([{ ...q, multiSelect: true }])]) {
      const r = rig([raw]);
      expect(cloudPrompt(r.S(raw.id), r.entries.get(raw.id)!, [])).toMatchObject({ ok: false, error: 'unsupported' });
    }
  });

  it('permission prompt offers Yes and No', () => {
    const raw = lit({ status: 'requires_action', events: ev({ requests: [req()] }) });
    const r = rig([raw]);
    const v = view(cloudPrompt(r.S(raw.id), r.entries.get(raw.id)!, []));
    expect(v.kind).toBe('permission');
    expect(v.options).toEqual(PERMISSION_OPTIONS);
    expect(v.detail.startsWith('Bash: ')).toBe(true);
    expect(v.detail).toBe('Bash: date');
  });

  it('a finished turn takes a typed reply; a working session has no prompt; an unread question is poked', () => {
    const r = rig([lit(), lit({ id: 'session_01Run', status: 'running' }), lit({ id: 'session_01Wait', status: 'requires_action' })]);
    expect(view(cloudPrompt(r.S('session_01FixtureDone'), r.entries.get('session_01FixtureDone')!, ['ok']))).toMatchObject({ kind: 'text', quickReplies: ['ok'] });
    expect(cloudReadPrompt(r.d, r.S('session_01Run'))).toMatchObject({ ok: false, error: 'no_prompt' });
    expect(cloudReadPrompt(r.d, r.S('session_01Wait'))).toMatchObject({ ok: false, error: 'no_prompt', message: expect.stringMatching(/not been read yet/) });
    expect(r.poke).toHaveBeenCalledWith('session_01Wait');
  });

  it('answer sends the chosen label with the request and fromId', async () => {
    const r = rig([PENDING]);
    const rp = cloudReadPrompt(r.d, r.S(PENDING.id));
    if (!rp.ok) throw new Error(rp.message);
    const out = await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: r.S(PENDING.id).key, promptHash: rp.prompt.hash, choice: '2' });
    expect(out).toEqual({ ok: true, sent: 'Blue' });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]).toMatchObject({ host: 'local', req: { mode: 'cloud-answer', configDir: '/c/a', sessionId: PENDING.id, budgetMs: 12000,
      answer: { kind: 'choice', label: 'Blue', requestId: REQ_ID, fromId: PREV_ID } } });
    expect(r.poke).toHaveBeenCalledWith(PENDING.id);
  });

  it('a permission Yes is allow and No is deny', async () => {
    const raw = lit({ status: 'requires_action', events: ev({ requests: [req()] }) });
    for (const [choice, kind, sent] of [['yes', 'allow', 'Yes'], ['no', 'deny', 'No']]) {
      const r = rig([raw]);
      const hash = view(cloudPrompt(r.S(raw.id), r.entries.get(raw.id)!, [])).hash;
      expect(await cloudAnswer(r.d, r.S(raw.id), { sessionId: 'x', promptHash: hash, choice })).toEqual({ ok: true, sent });
      expect(r.calls[0].req.answer).toEqual({ kind, requestId: 'r1', fromId: 'e0' });
    }
    const r = rig([raw]);
    const hash = view(cloudPrompt(r.S(raw.id), r.entries.get(raw.id)!, [])).hash;
    expect(await cloudAnswer(r.d, r.S(raw.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(r.calls).toHaveLength(0);
  });

  it('a stale promptHash is refused before any probe call', async () => {
    const r = rig([PENDING]);
    const out = await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: 'stale', choice: '1' });
    expect(out).toMatchObject({ ok: false, error: 'prompt_changed', prompt: { kind: 'menu' } });
    expect(r.calls).toHaveLength(0);
  });

  it('maps not_pending to prompt_changed and sends nothing', async () => {
    const r = rig([PENDING], { probe: async () => ({ ok: false, code: 'not_pending', error: 'request is no longer pending' }) });
    const hash = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, [])).hash;
    const out = await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' });
    expect(out).toMatchObject({ ok: false, error: 'prompt_changed', message: expect.stringMatching(/already answered or cancelled/) });
    expect(r.calls).toHaveLength(1); // the host refused; it did not try another account
    expect(r.poke).toHaveBeenCalled();
  });

  it('maps busy, bad_choice, a 429 and auth', async () => {
    const cases: [object, string][] = [
      [{ ok: false, code: 'busy', error: 'x' }, 'no_prompt'],
      [{ ok: false, code: 'bad_choice', error: 'x' }, 'bad_request'],
      [{ ok: false, code: 'http', status: 429, error: 'HTTP 429' }, 'rate_limited'],
      [{ ok: false, code: 'http', status: 500, error: 'HTTP 500' }, 'failed'],
    ];
    for (const [reply, error] of cases) {
      const r = rig([PENDING], { probe: async () => reply });
      const hash = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, [])).hash;
      expect(await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toMatchObject({ ok: false, error });
    }
    // An expired token on the owner: the next account of the login is tried.
    const r = rig([PENDING], { probe: async (h) => (h.id === 'local' ? { ok: false, code: 'auth', error: 'token expired (refresh is off)' } : { ok: true, sent: 'choice' }) });
    const hash = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, [])).hash;
    expect(await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toEqual({ ok: true, sent: 'Red' });
    expect(r.calls.map((c) => c.host)).toEqual(['local', 'gs']);
  });

  it("tries the next account that lists the session when the owner's host is unreachable", async () => {
    const r = rig([PENDING], { probe: async (h) => { if (h.id === 'local') throw new Error('local: probe timed out'); return { ok: true, sent: 'choice' }; } });
    const hash = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, [])).hash;
    expect(await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toEqual({ ok: true, sent: 'Red' });
    expect(r.calls.map((c) => [c.host, c.req.configDir])).toEqual([['local', '/c/a'], ['gs', '~/.claude-b']]);
    const all = rig([PENDING], { probe: async () => { throw new Error('down'); } });
    expect(await cloudAnswer(all.d, all.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toMatchObject({ ok: false, error: 'host_offline' });
  });

  it('a second answer while one is in flight is a duplicate', async () => {
    let release!: () => void;
    const r = rig([PENDING], { probe: () => new Promise((res) => { release = () => res({ ok: true, sent: 'choice' }); }) });
    const hash = view(cloudPrompt(r.S(PENDING.id), r.entries.get(PENDING.id)!, [])).hash;
    const first = cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' });
    expect(await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '2' })).toMatchObject({ ok: false, error: 'duplicate' });
    await new Promise((res) => setImmediate(res));
    release();
    expect(await first).toEqual({ ok: true, sent: 'Red' });
    // Sent a moment ago, with the same prompt still showing: a repeat.
    expect(await cloudAnswer(r.d, r.S(PENDING.id), { sessionId: 'x', promptHash: hash, choice: '1' })).toMatchObject({ ok: false, error: 'duplicate' });
    expect(r.calls).toHaveLength(1);
  });

  it('message posts text to an asleep cloud session; refused while working', async () => {
    const r = rig([lit({ unread: false }), lit({ id: 'session_01Run', status: 'running' })]);
    expect(r.S('session_01FixtureDone').state).toBe('asleep');
    expect(await cloudMessage(r.d, r.S('session_01FixtureDone'), { sessionId: 'x', text: 'carry on' })).toEqual({ ok: true, sent: 'message (8 characters)' });
    expect(r.calls[0].req).toMatchObject({ mode: 'cloud-answer', sessionId: 'session_01FixtureDone', answer: { kind: 'text', text: 'carry on' } });
    expect(await cloudMessage(r.d, r.S('session_01Run'), { sessionId: 'x', text: 'carry on' })).toMatchObject({ ok: false, error: 'no_prompt' });
    expect(r.calls).toHaveLength(1);
  });

  it('open uses https://claude.ai/code/<id>', async () => {
    for (const [account, check] of [['a', (c: Cmd) => expect(c.args.at(-1)).toBe('https://claude.ai/code/session_01FixtureDone')],
      ['b', (c: Cmd) => { expect(c.bin).toBe('/c/chrome.exe'); expect(c.args).toContain('https://claude.ai/code/session_01FixtureDone'); }]] as const) {
      const r = rig([lit()], { owners: [account] });
      const cmds: Cmd[] = [];
      const svc = createActionService({ cfg, sessions: () => r.sessions, probe: r.d.probe, cloud: r.d.cloud, gui: async (c) => (cmds.push(c), { ok: true }),
        env: { kind: 'wsl', distro: 'Ubuntu' }, exec: async () => ({ code: 0, stdout: '', stderr: '' }) });
      expect(await svc.open('cloud:session_01FixtureDone')).toEqual({ ok: true, message: 'Opened on claude.ai' });
      check(cmds[0]);
    }
  });

  it('summary needs no probe call', async () => {
    const r = rig([raw('ask-answered.raw.json')]);
    const svc = createActionService({ cfg, sessions: () => r.sessions, probe: r.d.probe, cloud: r.d.cloud, gui: async () => ({ ok: true }),
      env: { kind: 'wsl', distro: 'Ubuntu' }, exec: async () => ({ code: 0, stdout: '', stderr: '' }) });
    const s = await svc.summary(r.sessions[0].key);
    expect(s.ok).toBe(true);
    if (s.ok) expect(s.summary.lastAssistantText).toMatch(/GOT: hello from the tablet/);
    expect(r.calls).toHaveLength(0);
    expect(await svc.lastMessage(r.sessions[0].key)).toMatchObject({ ok: false, error: 'unsupported' });
    // The service routes a cloud card's prompt, answer and message to the cloud functions.
    expect(await svc.readPrompt(r.sessions[0].key)).toMatchObject({ ok: true, prompt: { kind: 'text' }, lastAssistantText: expect.stringMatching(/GOT:/) });
    expect(r.calls).toHaveLength(0);
  });
});

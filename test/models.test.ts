// Task 46: the + New launcher's real model list. Grouping (newest of each family first, the rest under More), the
// per-account cache (24 h, memory and state.json) and its fallback order, and the server's allow-list.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { BUILTIN_MODELS, ModelCache, groupModels, type ModelInfo } from '../src/actions/models.js';

const DAY = 24 * 3_600_000;

/** A model list like the API's, older models included, in no particular order. */
const FIXTURE: ModelInfo[] = [
  { id: 'claude-opus-4-7', name: 'Opus 4.7', created: '2025-11-01T00:00:00Z' },
  { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', created: '2025-10-01T00:00:00Z' },
  { id: 'claude-sonnet-5', name: 'Sonnet 5', created: '2026-05-02T00:00:00Z' },
  { id: 'claude-fable-5-1', name: 'Fable 5.1', created: '2026-08-01T00:00:00Z' },
  { id: 'claude-opus-5-5', name: 'Opus 5.5', created: '2026-09-01T00:00:00Z' },
  { id: 'claude-opus-4-6', name: 'Opus 4.6', created: '2025-08-01T00:00:00Z' },
  { id: 'claude-mystery-1', name: 'Mystery 1', created: '2026-09-09T00:00:00Z' },
  { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', created: '2026-09-02T00:00:00Z' },
  { id: 'claude-opus-5', name: 'Opus 5', created: '2026-05-01T00:00:00Z' },
  { id: 'claude-haiku-5-5', name: 'Haiku 5.5', created: '2026-09-03T00:00:00Z' },
  { id: 'claude-opus-4-8', name: 'Opus 4.8', created: '2026-02-01T00:00:00Z' },
  { id: 'claude-fable-5', name: 'Fable 5', created: '2026-04-01T00:00:00Z' },
];
const names = (l: ModelInfo[]) => l.map((m) => m.name);

describe('groupModels', () => {
  it('puts the newest of each family first (Opus, Sonnet, Haiku, Fable), then every other model under More, newest first per family', () => {
    const g = groupModels(FIXTURE);
    expect(names(g.main)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
    expect(names(g.more)).toEqual(['Opus 5', 'Opus 4.8', 'Opus 4.7', 'Opus 4.6', 'Sonnet 5', 'Haiku 4.5', 'Fable 5', 'Mystery 1']);
  });
  it('leaves out a family that has no model, and keeps list order where there are no dates (the built-in list)', () => {
    expect(names(groupModels(FIXTURE.filter((m) => !m.id.includes('fable'))).main)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    const g = groupModels([...BUILTIN_MODELS]);
    expect(names(g.main)).toEqual(['Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5', 'Fable 5.1']);
    expect(names(g.more)).toEqual(['Opus 5', 'Sonnet 5', 'Haiku 4.5', 'Fable 5']);
  });
  it('lists each id once', () => {
    const g = groupModels([...FIXTURE, { id: 'claude-opus-5-5', name: 'dup' }]);
    expect([...g.main, ...g.more].filter((m) => m.id === 'claude-opus-5-5')).toHaveLength(1);
  });
  it('the built-in list is the one in the task', () => {
    expect(BUILTIN_MODELS.map((m) => `${m.name}=${m.id}`)).toEqual([
      'Opus 5.5=claude-opus-5-5', 'Sonnet 5.5=claude-sonnet-5-5', 'Haiku 5.5=claude-haiku-5-5', 'Fable 5.1=claude-fable-5-1',
      'Opus 5=claude-opus-5', 'Sonnet 5=claude-sonnet-5', 'Fable 5=claude-fable-5', 'Haiku 4.5=claude-haiku-4-5-20251001']);
  });
});

const cfgText = (extra = '') => `
hosts: [{id: desk}, {id: rack, ssh: rack}]
accounts:
  - {id: a, label: A, colour: "#fff", host: desk, configDir: /x/a}
  - {id: b, label: B, colour: "#fff", host: desk, configDir: /x/b, usage: {provider: token, tokenEnv: CC_TOKEN, envFile: ~/env}}
  - {id: c, label: C, colour: "#fff", host: rack, configDir: ~/.claude-c}
${extra}`;
const api = (l: ModelInfo[]) => l.map((m) => ({ id: m.id, display_name: m.name, created_at: m.created }));

function rig(o: { reply?: (req: any) => any; extra?: string; statePath?: string | null; waitMs?: number } = {}) {
  let t = 1_000_000;
  const calls: { host: string; req: any }[] = [];
  const cfg = parseConfig(cfgText(o.extra), '/home/u');
  const reply = o.reply ?? ((req: any) => ({ ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true, models: api(FIXTURE) })) }));
  const probe = async (h: { id: string }, req: object) => { calls.push({ host: h.id, req }); return reply(req); };
  const cache = new ModelCache(cfg, probe, { now: () => t, statePath: o.statePath ?? null, waitMs: o.waitMs, log: () => {} });
  return { cache, calls, cfg, advance: (ms: number) => { t += ms; } };
}
const ids = (l: ModelInfo[]) => l.map((m) => m.id);

describe('ModelCache', () => {
  it('asks each host once for all its accounts, saying which token each uses (never the token itself)', async () => {
    const { cache, calls } = rig();
    await cache.refresh();
    expect(calls.map((c) => c.host).sort()).toEqual(['desk', 'rack']);
    const desk = calls.find((c) => c.host === 'desk')!.req;
    expect(desk).toEqual({ mode: 'models', accounts: [
      { key: 'a', configDir: '/x/a', kind: 'oauth' },
      { key: 'b', configDir: '/x/b', kind: 'token', tokenEnv: 'CC_TOKEN', envFile: '~/env' }] });
    expect(ids(cache.list('a'))).toEqual(ids(FIXTURE));
  });

  it('keeps a list for 24 hours, then asks again when the launcher opens', async () => {
    const { cache, calls, advance } = rig();
    await cache.refresh();
    advance(DAY - 1);
    await cache.refresh();
    expect(calls).toHaveLength(2);
    advance(1);
    await cache.refresh();
    expect(calls).toHaveLength(4);
  });

  it('falls back to the last good list, then to the built-in list', async () => {
    let fail = false;
    const { cache, advance } = rig({ reply: (req) => fail ? { ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: false, error: 'HTTPError: 401', status: 401 })) }
      : { ok: true, accounts: req.accounts.filter((a: any) => a.key !== 'c').map((a: any) => ({ key: a.key, ok: true, models: api(FIXTURE.slice(0, 3)) })) } });
    await cache.refresh();
    expect(ids(cache.list('a'))).toEqual(ids(FIXTURE.slice(0, 3)));
    expect(ids(cache.list('c'))).toEqual(ids(BUILTIN_MODELS));   // no entry for c in the reply: a failure
    fail = true; advance(DAY);
    await cache.refresh();
    expect(ids(cache.list('a'))).toEqual(ids(FIXTURE.slice(0, 3)));
    expect(ids(cache.list('c'))).toEqual(ids(BUILTIN_MODELS));
  });

  it('a host that cannot be reached, or an empty list, falls back too; a failure is not retried on every open', async () => {
    let n = 0;
    const { cache, calls, advance } = rig({ reply: () => { n++; if (n === 1) throw new Error('ssh: unreachable'); return { ok: true, accounts: [{ key: 'a', ok: true, models: [] }] }; } });
    await cache.refresh();
    expect(ids(cache.list('a'))).toEqual(ids(BUILTIN_MODELS));
    await cache.refresh();
    expect(calls).toHaveLength(2);    // one per host; both failed, so neither is asked again yet
    advance(10 * 60_000);
    await cache.refresh();
    expect(calls.length).toBeGreaterThan(2);
    expect(ids(cache.list('a'))).toEqual(ids(BUILTIN_MODELS));
  });

  it('does not hold the launcher up: past waitMs it answers with what it has, and the late reply is kept', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const { cache } = rig({ waitMs: 20, reply: async (req) => { await gate; return { ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true, models: api(FIXTURE) })) }; } });
    await cache.refresh();
    expect(ids(cache.list('a'))).toEqual(ids(BUILTIN_MODELS));
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(ids(cache.list('a'))).toEqual(ids(FIXTURE));
  });

  it('keeps only well-formed entries from the host (argv-safe ids, short names)', async () => {
    const { cache } = rig({ reply: (req) => ({ ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true, models: [
      { id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
      { id: '--dangerously-skip-permissions', display_name: 'x' }, { id: 'a b', display_name: 'x' }, { id: 7 }, { id: 'x'.repeat(65), display_name: 'x' },
      { id: 'claude-sonnet-5-5', display_name: 'S'.repeat(500) }, { id: 'claude-haiku-5-5' },
    ] })) }) });
    await cache.refresh();
    const l = cache.list('a');
    expect(ids(l)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']);
    expect(l[1].name.length).toBeLessThanOrEqual(64);
    expect(l[2].name).toBe('claude-haiku-5-5');
  });

  it('shows the API\'s display names without their "Claude " prefix ("Claude Opus 5.5" reads "Opus 5.5")', async () => {
    const { cache } = rig({ reply: (req) => ({ ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true, models: [
      { id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-x', display_name: 'Claude' }] })) }) });
    await cache.refresh();
    expect(names(cache.list('a'))).toEqual(['Opus 5.5', 'Claude']);
  });

  it('merges launch.models extras (aliases still accepted) into the list and the allow-list', async () => {
    const { cache } = rig({ extra: 'launch: {models: [opus, "claude-opus-5-5[1m]", claude-opus-5-5]}' });
    await cache.refresh();
    expect(ids(cache.list('a'))).toEqual([...ids(FIXTURE), 'opus', 'claude-opus-5-5[1m]']);
    const ok = cache.allowed('a');
    for (const id of ['claude-opus-4-6', 'claude-fable-5', 'claude-haiku-4-5-20251001', 'opus', 'sonnet', 'haiku', 'fable', 'claude-opus-5-5[1m]']) expect(ok.has(id), id).toBe(true);
    for (const id of ['claude-opus-9', 'x; id', '']) expect(ok.has(id), id).toBe(false);
  });

  it('the allow-list is per account: the built-in list always, plus what that account discovered', async () => {
    const { cache } = rig({ reply: (req) => ({ ok: true, accounts: req.accounts.map((a: any) => ({ key: a.key, ok: true,
      models: a.key === 'a' ? api([...FIXTURE, { id: 'claude-secret-preview', name: 'Preview' }]) : api(FIXTURE) })) }) });
    await cache.refresh();
    expect(cache.allowed('a').has('claude-secret-preview')).toBe(true);
    expect(cache.allowed('b').has('claude-secret-preview')).toBe(false);
    expect(cache.allowed('b').has('claude-opus-5')).toBe(true);
  });

  it('persists in state.json (ids, names and dates only) and reloads without asking again within 24 hours', async () => {
    const statePath = join(mkdtempSync(join(tmpdir(), 'cc-models-')), 'state.json');
    const one = rig({ statePath });
    await one.cache.refresh();
    const saved = JSON.parse(readFileSync(statePath, 'utf8'));
    expect(Object.keys(saved)).toEqual(['models']);
    expect(Object.keys(saved.models).sort()).toEqual(['a', 'b', 'c']);
    expect(Object.keys(saved.models.a).sort()).toEqual(['at', 'models']);
    for (const m of saved.models.a.models) expect(Object.keys(m).every((k) => ['id', 'name', 'created'].includes(k))).toBe(true);
    const two = rig({ statePath });
    await two.cache.refresh();
    expect(two.calls).toHaveLength(0);
    expect(ids(two.cache.list('c'))).toEqual(ids(FIXTURE));
  });
});

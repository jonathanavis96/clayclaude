import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Collector } from '../src/collector.js';
import { parseConfig } from '../src/config.js';
import { DismissedStore } from '../src/dismissed.js';
import { createActionService } from '../src/actions/service.js';
import { createActionRoutes } from '../src/actions/routes.js';
import type { ActionApi } from '../src/actions/types.js';

/**
 * Spec §5.1 (UI round 4): clearing stopped sessions. The daemon hides a cleared session for good (a dismissed list in
 * state.json, mode 0600, that the collector filters on), asks the host's probe to remove its dead registry files, and
 * never touches a live session.
 */
const NOW = Date.parse('2026-10-13T12:00:00Z');
const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
  - {id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w}
`);
const reg = (sid: string, live: boolean, file = `${sid}.json`) => ({ file, mtimeMs: NOW - 1000, live, transcript: [],
  data: { pid: 9, sessionId: sid, cwd: `/x/${sid}`, startedAt: NOW - 60_000, status: 'idle', updatedAt: NOW - 1000 } });
const snap = (dir: string, regs: object[]) => ({ ok: true, nowMs: NOW, dirs: [{ configDir: dir, registries: regs, events: [] }] });
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-clear-'));

describe('dismissed store', () => {
  it('persists dismissals in state.json with mode 0600, and a new store reads them back', async () => {
    const path = join(tmp(), 'sub', 'state.json');
    const a = new DismissedStore(path);
    expect(a.has('local:me:x')).toBe(false);
    await a.add(['local:me:x', 'box:w:y']);
    expect(a.has('local:me:x')).toBe(true);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).dismissed).toEqual(['local:me:x', 'box:w:y']);
    const b = new DismissedStore(path);
    expect(b.has('box:w:y')).toBe(true);
  });
  it('keeps other keys in state.json, tightens a looser mode, and survives a corrupt file', async () => {
    const path = join(tmp(), 'state.json');
    writeFileSync(path, JSON.stringify({ other: 1, dismissed: ['k1'] }), { mode: 0o644 });
    const s = new DismissedStore(path);
    await s.add(['k2', 'k1']);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 1, dismissed: ['k1', 'k2'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    writeFileSync(path, '{not json');
    expect(new DismissedStore(path).has('k1')).toBe(false);
  });
  it('remove() drops keys and saves, keeping the rest and other keys in state.json (T39)', async () => {
    const path = join(tmp(), 'state.json');
    writeFileSync(path, JSON.stringify({ other: 1, dismissed: ['k1', 'k2', 'k3'] }));
    const s = new DismissedStore(path);
    await s.remove(['k2', 'nope']);
    expect(['k1', 'k2', 'k3'].map((k) => s.has(k))).toEqual([true, false, true]);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 1, dismissed: ['k1', 'k3'] });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await s.add(['k2']);
    expect(JSON.parse(readFileSync(path, 'utf8')).dismissed).toEqual(['k1', 'k3', 'k2']);
  });
  it('keeps only the newest keys past its cap', async () => {
    const s = new DismissedStore(join(tmp(), 'state.json'), { max: 3 });
    await s.add(['a', 'b', 'c']); await s.add(['d']);
    expect(['a', 'b', 'c', 'd'].map((k) => s.has(k))).toEqual([false, true, true, true]);
  });
  it('never writes through a link planted at its temporary file (a config kept in a shared folder)', async () => {
    const d = tmp(), victim = join(d, 'victim');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, join(d, `state.json.${process.pid}.tmp`));
    const s = new DismissedStore(join(d, 'state.json'));
    await s.add(['k1']);
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
    expect(JSON.parse(readFileSync(join(d, 'state.json'), 'utf8')).dismissed).toEqual(['k1']);
    expect(lstatSync(join(d, 'state.json')).isSymbolicLink()).toBe(false);
  });
});

describe('collector and dismissed sessions', () => {
  it('filters dismissed stopped sessions, never a live one, and remembers each session\'s registry files', async () => {
    const hidden = new Set(['local:me:gone', 'local:me:back']);
    const c = new Collector(cfg, { now: () => NOW, hidden: (k) => hidden.has(k), probe: async (h) => h.id === 'local'
      ? snap('/c/me', [reg('gone', false), reg('dead', false), reg('dead', false, 'dead-2.json'), reg('back', true)])
      : snap('~/.claude-w', []) });
    const s = await c.pollOnce();
    expect(s.map((x) => x.sessionId).sort()).toEqual(['back', 'dead']);
    expect(c.registryFiles('local:me:dead')).toEqual({ configDir: '/c/me', files: ['dead.json', 'dead-2.json'] });
    expect(c.registryFiles('local:me:back')).toEqual({ configDir: '/c/me', files: ['back.json'] });
  });
  it('un-clears a session seen live again: it shows as stopped when it stops, and state.json loses its key (T39)', async () => {
    const path = join(tmp(), 'state.json');
    const store = new DismissedStore(path);
    let regs = [reg('back', false), reg('gone', false)];
    const c = new Collector(cfg, { now: () => NOW, hidden: (k) => store.has(k), resumed: (k) => { void store.remove([k]); },
      probe: async (h) => h.id === 'local' ? snap('/c/me', regs) : snap('~/.claude-w', []) });
    await store.add(['local:me:back', 'local:me:gone']);   // cleared while stopped
    expect((await c.pollOnce()).map((x) => x.sessionId)).toEqual([]);
    regs = [reg('back', true), reg('gone', false)];          // 'back' resumes with the same session id
    expect((await c.pollOnce()).map((x) => x.sessionId)).toEqual(['back']);
    await store.remove([]);                                   // waits for the queued writes
    expect(JSON.parse(readFileSync(path, 'utf8')).dismissed).toEqual(['local:me:gone']);
    expect(new DismissedStore(path).has('local:me:back')).toBe(false);
    regs = [reg('back', false), reg('gone', false)];         // and stops again
    const s = await c.pollOnce();
    expect(s.map((x) => [x.sessionId, x.state])).toEqual([['back', 'stopped']]);   // never-resumed 'gone' stays hidden
    expect(store.has('local:me:gone')).toBe(true);
  });
  it('refilter() drops a newly dismissed session at once and emits an update', async () => {
    const hidden = new Set<string>();
    const c = new Collector(cfg, { now: () => NOW, hidden: (k) => hidden.has(k), probe: async (h) => h.id === 'local' ? snap('/c/me', [reg('a', false), reg('b', true)]) : snap('~/.claude-w', []) });
    await c.pollOnce();
    let n = 0; c.on('update', () => n++);
    hidden.add('local:me:a'); hidden.add('local:me:b');
    c.refilter();
    expect(c.sessions().map((x) => x.sessionId)).toEqual(['b']);
    expect(n).toBe(1);
  });
});

const S = (sid: string, over: object = {}) => ({ key: `box:w:${sid}`, host: 'box', account: 'w', sessionId: sid, pid: 1, name: sid, cwd: '/x', state: 'stopped', stateSince: NOW, live: false,
  overContext: false, hostOnline: true, lastSeen: NOW, ...over }) as any;

function service(list: any[], probe: (h: any, r: any) => Promise<unknown> = async (_h, r) => ({ ok: true, results: r.files.map((f: string) => ({ file: f, removed: true, reason: 'removed' })) })) {
  const store = new DismissedStore(join(tmp(), 'state.json'));
  const probes: any[] = [];
  let changed = 0;
  const svc = createActionService({ cfg, sessions: () => list.filter((s) => !store.has(s.key) || s.live), probe: async (h, r: any) => { probes.push([h.id, r]); return probe(h, r); },
    clear: { store, files: (k) => ({ configDir: '~/.claude-w', files: [`${k.split(':')[2]}.json`] }), changed: () => { changed++; } } });
  return { svc, store, probes, changed: () => changed };
}

describe('clear actions', () => {
  it('refuses to clear a session the latest snapshot shows live, and touches nothing', async () => {
    const { svc, store, probes, changed } = service([S('run', { state: 'working', live: true }), S('nyou', { state: 'needs-you', live: true })]);
    expect(await svc.clear('box:w:run')).toMatchObject({ ok: false, error: 'live' });
    expect(await svc.clear('box:w:nyou')).toMatchObject({ ok: false, error: 'live' });
    expect(store.has('box:w:run')).toBe(false);
    expect(probes).toEqual([]);
    expect(changed()).toBe(0);
  });
  it('clears a stopped session: dismissed first, then the probe reaps its files', async () => {
    const { svc, store, probes, changed } = service([S('old')]);
    expect(await svc.clear('box:w:old')).toMatchObject({ ok: true, removed: 1 });
    expect(store.has('box:w:old')).toBe(true);
    expect(changed()).toBe(1);
    expect(probes).toEqual([['box', { mode: 'reap', configDir: '~/.claude-w', sessionId: 'old', files: ['old.json'] }]]);
    expect(await svc.clear('box:w:nope')).toMatchObject({ ok: false, error: 'unknown_session' });
  });
  it('still hides the row when the probe fails or refuses, and skips the probe for an offline host', async () => {
    const a = service([S('x')], async () => { throw new Error('box: probe timed out'); });
    expect(await a.svc.clear('box:w:x')).toMatchObject({ ok: true, removed: 0 });
    expect(a.store.has('box:w:x')).toBe(true);
    const b = service([S('y', { hostOnline: false })]);
    expect(await b.svc.clear('box:w:y')).toMatchObject({ ok: true, removed: 0 });
    expect(b.store.has('box:w:y')).toBe(true);
    expect(b.probes).toEqual([]);
  });
  it('clear-stopped touches only stopped sessions', async () => {
    const { svc, store, probes } = service([S('s1'), S('s2'), S('w', { state: 'working', live: true }), S('a', { state: 'asleep', live: true }), S('n', { state: 'needs-you', live: true })]);
    expect(await svc.clearStopped()).toMatchObject({ ok: true, cleared: 2, removed: 2 });
    expect(['s1', 's2', 'w', 'a', 'n'].map((k) => store.has(`box:w:${k}`))).toEqual([true, true, false, false, false]);
    expect(probes).toEqual([['box', { mode: 'reap', configDir: '~/.claude-w', sessionId: 's1', files: ['s1.json'] }],
      ['box', { mode: 'reap', configDir: '~/.claude-w', sessionId: 's2', files: ['s2.json'] }]]);
  });
});

describe('clear routes', () => {
  let srv: Server | undefined;
  afterEach(() => { srv?.close(); srv = undefined; });
  it('POST /api/action accepts clear and clear-stopped under the same header rules', async () => {
    const calls: unknown[][] = [];
    const api = { clear: async (id: string) => (calls.push(['clear', id]), { ok: true, message: 'Cleared', removed: 0 }),
      clearStopped: async () => (calls.push(['clear-stopped']), { ok: true, message: 'Cleared 0', cleared: 0, removed: 0 }) } as unknown as ActionApi;
    const h = createActionRoutes(api, { mode: 'live' });
    srv = createServer(async (req, res) => { if (!(await h(req, res, new URL(req.url!, 'http://x')))) { res.writeHead(404); res.end(); } });
    await new Promise<void>((r) => srv!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as any).port}/api/action`;
    const post = (body: object, headers: Record<string, string> = { 'content-type': 'application/json', 'x-clayclaude': '1' }) => fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
    expect((await post({ action: 'clear', sessionId: 'box:w:a' })).status).toBe(200);
    expect((await post({ action: 'clear-stopped' })).status).toBe(200);
    expect((await post({ action: 'clear' })).status).toBe(400);
    expect((await post({ action: 'clear', sessionId: 'box:w:a' }, { 'content-type': 'application/json' })).status).toBe(403);
    expect(calls).toEqual([['clear', 'box:w:a'], ['clear-stopped']]);
  });
});

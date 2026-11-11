import { describe, it, expect, vi, afterEach } from 'vitest';
import { CloudPoller, FAST_MS, SLOW_MS, DISCOVER_MS, POKE_DELAY_MS } from '../src/cloud/poller.js';
import { parseConfig, type HostConfig } from '../src/config.js';
import type { CloudAccount, CloudRaw, ProbeCloud } from '../src/cloud/types.js';

const T0 = Date.parse('2026-11-11T12:00:00Z');
const two = parseConfig(`
hosts: [{id: local}, {id: gs, ssh: gs}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /c/a}
  - {id: b, label: B, colour: "#fff", host: gs, configDir: ~/.claude-b}
`);
const one = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /c/a}
`);
const logs = parseConfig(`
hosts: [{id: local, cloudLaunchLog: ~/l.tsv}, {id: gs, ssh: gs, cloudLaunchLog: ~/g.tsv}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /c/a}
`);

const sess = (id: string, o: Partial<CloudRaw> = {}): CloudRaw => ({
  id, title: id, status: 'running', unread: false, createdAt: '2026-11-11T11:00:00Z', updatedAt: '2026-11-11T11:30:00Z', ...o,
});
const ok = (key: string, sessions: CloudRaw[], login = 'L1'): CloudAccount => ({ key, configDir: '', ok: true, login, sessions });

type Req = { host: string; mode: string; launchLog?: string; accounts: { key: string; pages: number; also: string[]; known: Record<string, { afterId?: string; updatedAt?: string }> }[] };

/** A fake probe: `reply` gives each account's entry (or throws), `launches` a host's log rows. */
function rig(cfg = two, o: { reply?: (host: string, key: string, r: Req) => CloudAccount; throws?: (host: string) => boolean;
  launches?: (host: string) => ProbeCloud['launches'] | Error } = {}) {
  let t = T0;
  const reqs: Req[] = [];
  const logLines: string[] = [];
  const p = new CloudPoller(cfg, {
    now: () => t, log: (m) => logLines.push(m),
    probe: async (h: HostConfig, req: any) => {
      const r = { host: h.id, ...req } as Req;
      reqs.push(r);
      if (o.throws?.(h.id)) throw new Error(`${h.id}: unreachable`);
      const out: ProbeCloud = { ok: true, nowMs: t, accounts: r.accounts.map((a) => (o.reply ?? ((_h, k) => ok(k, [sess('session_01X')])))(h.id, a.key, r)) };
      if (r.launchLog) { const l = o.launches?.(h.id) ?? []; if (l instanceof Error) out.launchError = l.message; else out.launches = l; }
      return out;
    },
  });
  return { p, reqs, logLines, at: (ms: number) => { t = T0 + ms; }, keys: () => reqs.flatMap((r) => r.accounts.map((a) => a.key)) };
}

describe('CloudPoller', () => {
  it('polls one account per login and shows each session once', async () => {
    const r = rig();
    await r.p.pollOnce();
    expect(r.keys().sort()).toEqual(['a', 'b']);
    r.reqs.length = 0;
    r.at(FAST_MS);
    const s = await r.p.pollOnce();
    expect(r.keys()).toEqual(['a']);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ key: 'cloud:session_01X', account: 'a', host: 'local', hostOnline: true, cloud: true });
    expect(r.p.accountsFor('session_01X').map((a) => a.id)).toEqual(['a', 'b']);
  });

  it('moves a login to its next account when the first one fails', async () => {
    let down = false;
    const r = rig(two, { throws: (h) => down && h === 'local' });
    await r.p.pollOnce();
    down = true;
    r.at(FAST_MS);
    await r.p.pollOnce();
    r.reqs.length = 0;
    r.at(2 * FAST_MS);
    const s = await r.p.pollOnce();
    expect(r.keys()).toEqual(['b']);
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ account: 'b', host: 'gs', hostOnline: true });
    expect(r.p.accountsFor('session_01X').map((a) => a.id)).toEqual(['b', 'a']);
  });

  it('keeps cards offline when the only host fails', async () => {
    let down = false;
    const r = rig(one, { throws: () => down });
    await r.p.pollOnce();
    down = true;
    r.at(FAST_MS);
    const s = await r.p.pollOnce();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ hostOnline: false, lastSeen: T0 });
    expect(r.logLines.filter((l) => l.includes('cloud sessions for a'))).toHaveLength(1);
    down = false;
    r.at(FAST_MS + SLOW_MS);
    expect((await r.p.pollOnce())[0].hostOnline).toBe(true);
    expect(r.logLines.at(-1)).toMatch(/cloud sessions for a are back/);
  });

  it('backs off an account after a 429 and keeps its cards', async () => {
    let limited = false;
    const r = rig(one, { reply: (_h, k) => limited ? { key: k, configDir: '', ok: false, error: 'HTTP 429', status: 429 } : ok(k, [sess('session_01X')]) });
    await r.p.pollOnce();
    limited = true;
    r.at(FAST_MS);
    await r.p.pollOnce();
    r.reqs.length = 0;
    for (let ms = 2 * FAST_MS; ms < FAST_MS + 120_000; ms += FAST_MS) {
      r.at(ms);
      expect(await r.p.pollOnce()).toHaveLength(1);
    }
    expect(r.keys()).toEqual([]);
    limited = false;
    r.at(FAST_MS + 120_000);
    const s = await r.p.pollOnce();
    expect(r.keys()).toEqual(['a']);
    expect(s[0].hostOnline).toBe(true);
  });

  it('polls fast while a session runs and slowly when all are idle', async () => {
    let status = 'running';
    const r = rig(one, { reply: (_h, k) => ok(k, [sess('session_01X', { status })]) });
    await r.p.pollOnce();
    r.at(FAST_MS - 1); await r.p.pollOnce();
    expect(r.reqs).toHaveLength(1);
    status = 'idle';
    r.at(FAST_MS); await r.p.pollOnce();
    expect(r.reqs).toHaveLength(2);
    r.at(FAST_MS + SLOW_MS - 1); await r.p.pollOnce();
    expect(r.reqs).toHaveLength(2);
    r.at(FAST_MS + SLOW_MS); await r.p.pollOnce();
    expect(r.reqs).toHaveLength(3);
    // A poke makes the login due on the next tick.
    r.p.poke('session_01X');
    r.at(FAST_MS + SLOW_MS + FAST_MS); await r.p.pollOnce();
    expect(r.reqs).toHaveLength(4);
  });

  it('asks five pages at start and every ten minutes, else one', async () => {
    const r = rig(one);
    const pages = () => r.reqs.at(-1)!.accounts[0].pages;
    await r.p.pollOnce();
    expect(pages()).toBe(5);
    r.at(FAST_MS); await r.p.pollOnce();
    expect(pages()).toBe(1);
    r.at(DISCOVER_MS); await r.p.pollOnce();
    expect(pages()).toBe(5);
    r.at(DISCOVER_MS + FAST_MS); await r.p.pollOnce();
    expect(pages()).toBe(1);
  });

  it('drops a session the next ok poll does not return', async () => {
    let list = [sess('session_01X'), sess('session_01Y')];
    const r = rig(one, { reply: (_h, k) => ok(k, list) });
    expect(await r.p.pollOnce()).toHaveLength(2);
    list = [sess('session_01Y')];
    r.at(FAST_MS);
    expect((await r.p.pollOnce()).map((s) => s.sessionId)).toEqual(['session_01Y']);
    expect(r.p.entry('session_01X')).toBeUndefined();
  });

  it('sends known afterId and updatedAt', async () => {
    const r = rig(one, { reply: (_h, k, req) => ok(k, [sess('session_01X', req.accounts[0].known.session_01X ? {}
      : { events: { lines: [], requests: [], resolved: [], lastId: 'e9', more: false } })]) });
    await r.p.pollOnce();
    r.at(FAST_MS); await r.p.pollOnce();
    const a = r.reqs.at(-1)!.accounts[0];
    expect(a.also).toEqual(['session_01X']);
    expect(a.known).toEqual({ session_01X: { afterId: 'e9', updatedAt: '2026-11-11T11:30:00Z' } });
    expect(r.p.entry('session_01X')?.afterId).toBe('e9');
  });

  it('labels origin from launch logs', async () => {
    let gsLog: ProbeCloud['launches'] | Error = new Error('cannot read');
    const r = rig(logs, {
      reply: (_h, k) => ok(k, [sess('session_01Here'), sess('session_01There'), sess('session_01Web')]),
      launches: (h) => h === 'local' ? [{ sessionId: 'session_01Here', task: 'fix-login' }] : gsLog,
    });
    let s = await r.p.pollOnce();
    const by = (id: string) => s.find((x) => x.sessionId === id)!;
    expect(by('session_01Here')).toMatchObject({ origin: 'this PC', originTask: 'fix-login' });
    expect(by('session_01Web').origin).toBeUndefined();
    gsLog = [{ sessionId: 'session_01There' }];
    r.at(FAST_MS);
    s = await r.p.pollOnce();
    expect(by('session_01Web').origin).toBeUndefined(); // gs's log is read again only after SLOW_MS
    r.at(SLOW_MS);
    s = await r.p.pollOnce();
    expect(by('session_01There').origin).toBe('gs');
    expect(by('session_01There').originTask).toBeUndefined();
    expect(by('session_01Web').origin).toBe('claude.ai');
    expect(by('session_01Here').origin).toBe('this PC');
  });

  it('reads a launch log on a host with no due accounts', async () => {
    const r = rig(logs, { launches: () => [] });
    await r.p.pollOnce();
    const gs = r.reqs.filter((q) => q.host === 'gs');
    expect(gs).toHaveLength(1);
    expect(gs[0]).toMatchObject({ mode: 'cloud', launchLog: '~/g.tsv', accounts: [] });
    r.at(FAST_MS); await r.p.pollOnce();
    expect(r.reqs.filter((q) => q.host === 'gs')).toHaveLength(1);
    r.at(SLOW_MS); await r.p.pollOnce();
    expect(r.reqs.filter((q) => q.host === 'gs')).toHaveLength(2);
  });

  it('retries an account with no credentials every ten minutes', async () => {
    const r = rig(one, { reply: (_h, k) => ({ key: k, configDir: '', ok: false, error: 'no credentials', noAuth: true }) });
    expect(await r.p.pollOnce()).toEqual([]);
    r.reqs.length = 0;
    r.at(SLOW_MS); await r.p.pollOnce();
    expect(r.keys()).toEqual([]);
    r.at(DISCOVER_MS); await r.p.pollOnce();
    expect(r.keys()).toEqual(['a']);
  });
  afterEach(() => { vi.useRealTimers(); });
  it('a poke while running polls again soon, not at the next tick (an answer shows within the sheet\'s wait)', async () => {
    vi.useFakeTimers();
    const r = rig(one, { reply: (_h, k) => ok(k, [sess('session_01X', { status: 'requires_action' })]) });
    r.p.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.reqs).toHaveLength(1);
    r.at(3000);
    await vi.advanceTimersByTimeAsync(3000);
    r.p.poke('session_01X');
    r.at(3000 + POKE_DELAY_MS);
    await vi.advanceTimersByTimeAsync(POKE_DELAY_MS);
    expect(r.reqs).toHaveLength(2);
    r.p.stop();
  });
  it('asks a known login before accounts still being discovered, so a cold read cannot starve it', async () => {
    const cfg = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: n, label: N, colour: "#fff", host: local, configDir: /c/n}
  - {id: a, label: A, colour: "#fff", host: local, configDir: /c/a}
`);
    let nDown = true;
    const r = rig(cfg, { reply: (_h, k) => (k === 'n' && nDown ? { key: k, configDir: '', ok: false, error: 'no time left in this poll' } : ok(k, [sess('session_01' + k.toUpperCase())], 'L' + k)) });
    await r.p.pollOnce();
    nDown = false;
    r.at(SLOW_MS);
    await r.p.pollOnce();
    expect(r.reqs.at(-1)!.accounts.map((a) => a.key)).toEqual(['a', 'n']);
  });
});

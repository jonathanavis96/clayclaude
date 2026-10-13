import { describe, it, expect, vi, afterEach } from 'vitest';
import { UsagePoller, planLabel } from '../src/usage.js';
import { parseConfig } from '../src/config.js';

const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: me, label: Me, colour: "#e8b54a", host: local, configDir: /c/me}
  - {id: w, label: W, colour: "#4fd1c5", host: box, configDir: ~/.claude-w, usage: {provider: http, url: "http://x/usage", key: work}}
  - {id: n, label: N, colour: "#fff", host: local, configDir: /c/n, usage: {provider: none}}
`);
const win = (u: number) => ({ utilization: u, resets_at: '2026-10-12T15:00:00Z' });

describe('UsagePoller', () => {
  it('combines oauth and http accounts, omits none', async () => {
    const p = new UsagePoller(cfg, {
      probe: async () => ({ ok: true, accounts: [{ configDir: '/c/me', ok: true, email: 'a@b', five_hour: win(64), seven_day: win(100) }] }),
      fetchFn: (async () => new Response(JSON.stringify({ work: { five_hour: win(10), seven_day: win(20) } }))) as any,
    });
    const u = await p.pollOnce();
    expect(u.map((x) => [x.account, x.fiveHour, x.weekly, x.stale])).toEqual([['me', 64, 100, false], ['w', 10, 20, false]]);
    expect(p.isExhausted('me')).toBe(true);
    expect(p.publicShape().me.five_hour).toEqual(win(64));
  });

  it('keeps last values and marks stale on failure', async () => {
    let fail = false;
    const p = new UsagePoller(cfg, {
      probe: async () => fail ? { ok: true, accounts: [{ configDir: '/c/me', ok: false, error: 'HTTPError: 400' }] }
        : { ok: true, accounts: [{ configDir: '/c/me', ok: true, five_hour: win(50), seven_day: win(5) }] },
      fetchFn: (async () => { throw new Error('down'); }) as any,
    });
    await p.pollOnce();
    fail = true;
    const u = await p.pollOnce();
    expect(u.find((x) => x.account === 'me')).toMatchObject({ fiveHour: 50, stale: true });
    expect(u.find((x) => x.account === 'w')).toMatchObject({ fiveHour: null, stale: true });
    expect(p.isExhausted('me')).toBe(false);
  });

  it('gives the http provider a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    const p = new UsagePoller(cfg, { probe: async () => ({ ok: true, accounts: [] }),
      fetchFn: (async (_u: string, init?: RequestInit) => { signal = init?.signal ?? undefined; return new Response('{}'); }) as any });
    await p.pollOnce();
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  describe('start', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('is idempotent and stop() lets it start again', async () => {
      vi.useFakeTimers();
      let calls = 0;
      const p = new UsagePoller(cfg, { probe: async () => { calls++; return { ok: true, accounts: [] }; }, fetchFn: (async () => new Response('{}')) as any });
      p.start(); p.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2); // one immediate poll plus one tick
      p.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      p.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(3);
      p.stop();
    });
  });

  it('logs a failing account once, not on every poll', async () => {
    const log = vi.fn();
    const p = new UsagePoller(cfg, { log, probe: async () => ({ ok: true, accounts: [{ configDir: '/c/me', ok: false, error: 'HTTPError: 401' }] }),
      fetchFn: (async () => new Response('{}')) as any });
    await p.pollOnce(); await p.pollOnce();
    expect(log.mock.calls.filter((c) => String(c[0]).includes('me'))).toHaveLength(1);
    expect(String(log.mock.calls.find((c) => String(c[0]).includes('me'))![0])).toContain('HTTPError: 401');
  });

  it('never runs two polls at once (overlapping polls could double-refresh a token)', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0; let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      const p = new UsagePoller(cfg, { probe: async () => { calls++; await gate; return { ok: true, accounts: [] }; },
        fetchFn: (async () => new Response('{}')) as any, log: () => {} });
      p.start();
      await vi.advanceTimersByTimeAsync(180_000);
      expect(calls).toBe(1);
      release();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(2);
      p.stop();
    } finally { vi.useRealTimers(); }
  });

  it('passes the probe a time budget shorter than its timeout', async () => {
    let req: any;
    const p = new UsagePoller(cfg, { probe: async (_h, r) => { req = r; return { ok: true, accounts: [] }; }, fetchFn: (async () => new Response('{}')) as any });
    await p.pollOnce();
    expect(req.budgetMs).toBeGreaterThan(10_000);
  });

  it('backs off an oauth account that answers 429, doubling, and resets on success', async () => {
    let t = 1_000_000; let status = 429; const asked: string[][] = [];
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => {
        asked.push(r.accounts.map((a: any) => a.configDir));
        return { ok: true, accounts: [status === 200
          ? { configDir: '/c/me', ok: true, five_hour: win(1), seven_day: win(2) }
          : { configDir: '/c/me', ok: false, status, retryAfterS: 0, error: 'HTTPError: HTTP Error 429: Too Many Requests' }] };
      },
      fetchFn: (async () => new Response('{}')) as any });
    const polls = async (n: number) => { for (let i = 0; i < n; i++) { await p.pollOnce(); t += 60_000; } };
    await polls(1);            // 429 -> wait 2 min
    await polls(1);            // skipped
    expect(asked).toHaveLength(1);
    await polls(1);            // t0+2min: asked again, 429 -> wait 4 min
    expect(asked).toHaveLength(2);
    await polls(3);            // skipped
    expect(asked).toHaveLength(2);
    status = 200;
    await polls(1);            // t0+6min: asked, ok
    await polls(1);            // asked every minute again
    expect(asked).toHaveLength(4);
    expect(p.usage().find((x) => x.account === 'me')).toMatchObject({ fiveHour: 1, stale: false });
  });

  it('honours a Retry-After longer than its own backoff', async () => {
    let t = 0; let n = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async () => { n++; return { ok: true, accounts: [{ configDir: '/c/me', ok: false, status: 429, retryAfterS: 600, error: '429' }] }; },
      fetchFn: (async () => new Response('{}')) as any });
    await p.pollOnce();
    t = 9 * 60_000; await p.pollOnce();
    expect(n).toBe(1);
    t = 10 * 60_000; await p.pollOnce();
    expect(n).toBe(2);
  });

  it('backs off an http account that answers 429', async () => {
    let t = 0; let n = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {}, probe: async () => ({ ok: true, accounts: [] }),
      fetchFn: (async () => { n++; return new Response('{}', { status: 429 }); }) as any });
    await p.pollOnce();
    t = 60_000; await p.pollOnce();
    expect(n).toBe(1);
  });

  it('does not take values from an http error answer, or non-numeric ones', async () => {
    let body: any = { work: { five_hour: win(10), seven_day: win(20) } }; let status = 500;
    const p = new UsagePoller(cfg, { log: () => {}, probe: async () => ({ ok: true, accounts: [] }),
      fetchFn: (async () => new Response(JSON.stringify(body), { status })) as any });
    let w = (await p.pollOnce()).find((x) => x.account === 'w')!;
    expect(w).toMatchObject({ fiveHour: null, stale: true });
    status = 200; body = { work: { five_hour: { utilization: '99', resets_at: 5 }, seven_day: win(20) } };
    w = (await p.pollOnce()).find((x) => x.account === 'w')!;
    expect(w).toMatchObject({ fiveHour: null, fiveHourResetsAt: null, weekly: 20 });
  });

  it('goes stale 5 min after the last success, and /usage keeps the public shape without the email', async () => {
    let t = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async () => ({ ok: true, accounts: [{ configDir: '/c/me', ok: true, email: 'a@b', five_hour: { ...win(64), extra: 1 } as any, seven_day: null }] }),
      fetchFn: (async () => new Response('{}')) as any });
    await p.pollOnce();
    t = 5 * 60_000;
    expect(p.publicShape().me).toEqual({ label: 'Me', stale: false, five_hour: win(64), seven_day: null });
    t = 5 * 60_000 + 1;
    expect(p.publicShape().me.stale).toBe(true);
    expect(p.isExhausted('me')).toBe(false);
    expect(JSON.stringify(p.publicShape())).not.toContain('a@b');
  });
});


describe('account name and plan', () => {
  it('carries the name and a readable plan from the probe, and keeps both out of /usage', async () => {
    const p = new UsagePoller(cfg, { log: () => {},
      probe: async () => ({ ok: true, accounts: [{ configDir: '/c/me', ok: true, email: 'a@b', name: 'Ann', plan: 'claude_max', planTier: 'default_claude_max_20x',
        five_hour: win(64), seven_day: win(10) }] }),
      fetchFn: (async () => new Response('{}')) as any });
    const u = (await p.pollOnce()).find((x) => x.account === 'me')!;
    expect(u).toMatchObject({ email: 'a@b', name: 'Ann', plan: 'Max 20x' });
    expect(JSON.stringify(p.publicShape())).not.toMatch(/Ann|Max/);
  });

  it('has no plan when the probe sends none', async () => {
    const p = new UsagePoller(cfg, { log: () => {},
      probe: async () => ({ ok: true, accounts: [{ configDir: '/c/me', ok: true, five_hour: win(64), seven_day: win(10) }] }),
      fetchFn: (async () => new Response('{}')) as any });
    const u = (await p.pollOnce()).find((x) => x.account === 'me')!;
    expect(u.plan ?? null).toBeNull();
    expect(u.name ?? null).toBeNull();
  });

  it('names the plan from the organisation type and its rate-limit tier, and never guesses', () => {
    expect(planLabel('claude_max', 'default_claude_max_20x')).toBe('Max 20x');
    expect(planLabel('claude_max', 'default_claude_max_5x')).toBe('Max 5x');
    expect(planLabel('claude_max', null)).toBe('Max');
    expect(planLabel('claude_pro', 'default_claude_pro')).toBe('Pro');
    expect(planLabel('claude_team', undefined)).toBe('Team');
    expect(planLabel(null, 'default_claude_max_20x')).toBeNull();
    expect(planLabel('', null)).toBeNull();
    expect(planLabel('<b>x</b>', null)).toBeNull();
    expect(planLabel(42 as any, null)).toBeNull();
  });
});

describe('UsagePoller with a hung host', () => {
  it('publishes the other hosts as soon as they answer, not after the hung one times out', async () => {
    const two = parseConfig(`
hosts: [{id: good, ssh: good}, {id: hung, ssh: hung}]
accounts:
  - {id: g, label: G, colour: "#fff", host: good, configDir: /c/g}
  - {id: h, label: H, colour: "#fff", host: hung, configDir: /c/h}
`);
    let release!: () => void;
    const hung = new Promise<void>((r) => { release = r; });
    const p = new UsagePoller(two, {
      probe: async (host) => {
        if (host.id === 'hung') { await hung; throw new Error('hung: probe timed out'); }
        return { ok: true, accounts: [{ configDir: '/c/g', ok: true, five_hour: win(30), seven_day: win(40) }] };
      },
      log: () => {},
    });
    const updates: any[][] = [];
    p.on('update', (u) => updates.push(u));
    const done = p.pollOnce();
    await new Promise((r) => setTimeout(r, 50));
    expect(updates.at(-1)?.find((u: any) => u.account === 'g')).toMatchObject({ fiveHour: 30, stale: false });
    release();
    await done;
    expect(updates.at(-1)?.find((u: any) => u.account === 'h')).toMatchObject({ stale: true });
  });
});

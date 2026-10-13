import { describe, it, expect, vi, afterEach } from 'vitest';
import { Collector } from '../src/collector.js';
import { parseConfig } from '../src/config.js';
import { ProbeError } from '../src/probe/run.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
  - {id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w}
`);
const reg = (sid: string, live: boolean, extra: object = {}) => ({ file: `${sid}.json`, mtimeMs: NOW - 1000, live, transcript: [],
  data: { pid: 9, sessionId: sid, cwd: `/x/${sid}`, startedAt: NOW - 60_000, status: 'busy', updatedAt: NOW - 1000, ...extra } });
const snap = (dir: string, regs: object[]) => ({ ok: true, nowMs: NOW, dirs: [{ configDir: dir, registries: regs, events: [] }] });

describe('Collector', () => {
  it('merges hosts and keys sessions by host:account:session', async () => {
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'local' ? snap('/c/me', [reg('a', true)]) : snap('~/.claude-w', [reg('b', true)]) });
    const s = await c.pollOnce();
    expect(s.map((x) => x.key).sort()).toEqual(['box:w:b', 'local:me:a']);
  });

  it('keeps an offline host\'s last sessions, greyed, while others update', async () => {
    let boxUp = true;
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => {
      if (h.id === 'box' && !boxUp) throw new Error('unreachable');
      return h.id === 'local' ? snap('/c/me', [reg('a', true)]) : snap('~/.claude-w', [reg('b', true)]);
    } });
    await c.pollOnce();
    boxUp = false;
    const s = await c.pollOnce();
    const b = s.find((x) => x.key === 'box:w:b')!;
    expect(b.hostOnline).toBe(false);
    expect(s.find((x) => x.key === 'local:me:a')!.hostOnline).toBe(true);
  });

  it('a slow link: one probe timeout keeps the host online, a second in a row greys it', async () => {
    let t = NOW, slow = false;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => {
      if (h.id === 'box' && slow) throw new ProbeError('timeout', 'box: probe timed out');
      return h.id === 'local' ? snap('/c/me', [reg('a', true)]) : snap('~/.claude-w', [reg('b', true)]);
    } });
    await c.pollOnce();
    slow = true;
    t += 60_000;
    expect((await c.pollOnce()).find((x) => x.key === 'box:w:b')!.hostOnline).toBe(true);
    t += 60_000;
    expect((await c.pollOnce()).find((x) => x.key === 'box:w:b')!.hostOnline).toBe(false);
  });

  it('drops stopped sessions past retention and dedupes resumed sessions', async () => {
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'local'
      ? snap('/c/me', [reg('old', false, { updatedAt: NOW - 4 * 3600_000 }), reg('dup', false), { ...reg('dup', true), file: 'dup2.json' }])
      : snap('~/.claude-w', []) });
    const s = await c.pollOnce();
    expect(s.map((x) => x.sessionId)).toEqual(['dup']);
    expect(s[0].live).toBe(true);
  });

  it('hands each session the status line record the probe found for it', async () => {
    const turn = JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 600_000).toISOString(),
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, cache_read_input_tokens: 150_000, cache_creation_input_tokens: 0 } } });
    const rec = { sessionId: 'a', ts: NOW - 500_000, contextWindowSize: 1_000_000, usedPercentage: 15, totalInputTokens: 150_000 };
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'local'
      ? { ok: true, nowMs: NOW, dirs: [{ configDir: '/c/me', registries: [{ ...reg('a', true), transcript: [turn] }, { ...reg('b', true), transcript: [turn] }], events: [], contexts: { a: rec } }] }
      : snap('~/.claude-w', []) });
    const s = await c.pollOnce();
    expect(s.find((x) => x.sessionId === 'a')).toMatchObject({ contextWindow: 1_000_000, contextPct: 15, contextTokens: 150_000 });
    expect(s.find((x) => x.sessionId === 'b')).toMatchObject({ contextWindow: 200_000, contextPct: 75 });
  });

  it('a session seen past 200k keeps the 1M window across polls, and is forgotten once it is gone', async () => {
    const turn = (tokens: number) => JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 600_000).toISOString(),
      message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } });
    let regs: object[] = [{ ...reg('a', true), transcript: [turn(266_000)] }];
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'local' ? snap('/c/me', regs) : snap('~/.claude-w', []) });
    expect((await c.pollOnce())[0].contextPct).toBe(27);
    regs = [{ ...reg('a', true), transcript: [turn(198_000)] }];
    expect((await c.pollOnce())[0].contextPct).toBe(20);
    regs = [];
    await c.pollOnce();
    regs = [{ ...reg('a', true), transcript: [turn(198_000)] }];
    expect((await c.pollOnce())[0].contextPct).toBe(99);
  });

  it('emits update only on change', async () => {
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => snap(h.id === 'local' ? '/c/me' : '~/.claude-w', []) });
    let n = 0; c.on('update', () => n++);
    await c.pollOnce(); await c.pollOnce();
    expect(n).toBe(1);
  });

  it('does not re-emit an unchanged session list just because time moved on', async () => {
    let t = NOW;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => ({ ...(h.id === 'local' ? snap('/c/me', [reg('a', true)]) : snap('~/.claude-w', [])), nowMs: t }) });
    let n = 0; c.on('update', () => n++);
    await c.pollOnce();
    t += 2000; await c.pollOnce();
    t += 2000; await c.pollOnce();
    expect(n).toBe(1);
  });

  it('keeps lastSeen at the last successful poll while the host is offline', async () => {
    let t = NOW; let boxUp = true;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => {
      if (h.id === 'box' && !boxUp) throw new Error('unreachable');
      return h.id === 'local' ? snap('/c/me', []) : snap('~/.claude-w', [reg('b', true)]);
    } });
    await c.pollOnce();
    boxUp = false;
    t = NOW + 5 * 60_000;
    let emitted: any[] = [];
    c.on('update', (l) => { emitted = l; });
    const s = await c.pollOnce();
    const b = s.find((x) => x.key === 'box:w:b')!;
    expect(b.hostOnline).toBe(false);
    expect(b.lastSeen).toBe(NOW);
    expect(emitted.find((x) => x.key === 'box:w:b').lastSeen).toBe(NOW);
  });

  it('judges a remote host by the probe\'s clock, not the daemon\'s', async () => {
    const remoteNow = NOW - 60_000; // remote clock 60 s behind
    const entry = JSON.stringify({ type: 'assistant', timestamp: new Date(remoteNow - 5000).toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } });
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'local'
      ? { ...snap('/c/me', [{ ...reg('a', true, { status: 'idle' }), transcript: [entry] }]), nowMs: remoteNow }
      : snap('~/.claude-w', []) });
    const s = await c.pollOnce();
    expect(s[0].state).toBe('working');
  });

  it('asks the probe to skip transcripts it already has, and reuses them', async () => {
    const entry = JSON.stringify({ type: 'ai-title', aiTitle: 'Cached title' });
    const reqs: any[] = [];
    const c = new Collector(cfg, { now: () => NOW, probe: async (h, req: any) => {
      if (h.id !== 'local') return snap('~/.claude-w', []);
      reqs.push(req);
      const known = req.known?.['/c/me']?.a;
      return snap('/c/me', [known === '10:1' ? { ...reg('a', true), tsig: '10:1', same: true } : { ...reg('a', true), tsig: '10:1', transcript: [entry] }]);
    } });
    expect((await c.pollOnce())[0].name).toBe('Cached title');
    const s = await c.pollOnce();
    expect(reqs[1].known).toEqual({ '/c/me': { a: '10:1' } });
    expect(s[0].name).toBe('Cached title');
  });

  it('never runs two probes to the same host at once, so a slow stale snapshot cannot overwrite a fresh one', async () => {
    let calls = 0; let release!: () => void;
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => {
      if (h.id === 'local') return snap('/c/me', []);
      calls++;
      await new Promise<void>((r) => { release = r; });
      return snap('~/.claude-w', [reg('b', true)]);
    } });
    const first = c.pollOnce();
    await c.pollOnce(); // box still in flight: must be skipped, not re-probed
    expect(calls).toBe(1);
    release();
    await first;
    expect(c.sessions().map((x) => x.key)).toEqual(['box:w:b']);
  });

  it('backs off exponentially on an unreachable host and resets on success', async () => {
    let t = NOW; let boxUp = false; let calls = 0;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => {
      if (h.id === 'local') return snap('/c/me', []);
      calls++;
      if (!boxUp) throw new Error('unreachable');
      return snap('~/.claude-w', []);
    } });
    // pollMs = 2000: retries after 2s, then 4s, then 8s...
    await c.pollOnce(); expect(calls).toBe(1);
    t = NOW + 1000; await c.pollOnce(); expect(calls).toBe(1);
    t = NOW + 2000; await c.pollOnce(); expect(calls).toBe(2);
    t = NOW + 5000; await c.pollOnce(); expect(calls).toBe(2);
    t = NOW + 6000; await c.pollOnce(); expect(calls).toBe(3);
    t = NOW + 13_000; await c.pollOnce(); expect(calls).toBe(3);
    boxUp = true;
    t = NOW + 14_000; await c.pollOnce(); expect(calls).toBe(4);
    await c.pollOnce(); expect(calls).toBe(5); // success reset the backoff
  });

  it('logs a host going offline once, with the error, and logs its recovery', async () => {
    let t = NOW; let boxUp = false; const log = vi.fn();
    const c = new Collector(cfg, { now: () => t, log, probe: async (h) => {
      if (h.id === 'local') return snap('/c/me', []);
      if (!boxUp) throw new Error('ssh: connect refused');
      return snap('~/.claude-w', []);
    } });
    await c.pollOnce(); t += 60_000; await c.pollOnce();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toMatch(/box.*connect refused/);
    boxUp = true; t += 60_000; await c.pollOnce();
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('caps the backoff at 60s', async () => {
    let t = NOW; let calls = 0;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => {
      if (h.id === 'local') return snap('/c/me', []);
      calls++; throw new Error('unreachable');
    } });
    for (let i = 0; i < 20; i++) { await c.pollOnce(); t += 60_000; }
    expect(calls).toBe(20);
  });

  it('reports a remote host\'s timestamps on the daemon\'s clock, so ages and the cache timer are right', async () => {
    const remoteNow = NOW - 60_000; // remote clock 60 s behind
    const entry = JSON.stringify({ type: 'assistant', timestamp: new Date(remoteNow - 5000).toISOString(), message: { content: [{ type: 'text', text: 'hi' }] } });
    const c = new Collector(cfg, { now: () => NOW, probe: async (h) => h.id === 'box'
      ? { ...snap('~/.claude-w', [{ ...reg('b', true, { status: undefined }), transcript: [entry] }]), nowMs: remoteNow }
      : snap('/c/me', []) });
    const [s] = await c.pollOnce();
    expect(s.state).toBe('working');
    expect(s.stateSince).toBe(NOW - 5000);
    expect(s.lastAssistantAt).toBe(NOW - 5000);
    expect(s.cacheExpiresAt).toBe(NOW - 5000 + 60 * 60_000);
  });

  it('does not re-emit because of probe latency jitter in the clock comparison', async () => {
    let t = NOW; let i = 0;
    const c = new Collector(cfg, { now: () => t, probe: async (h) => h.id === 'box'
      ? { ...snap('~/.claude-w', [reg('b', true, { statusUpdatedAt: NOW - 90_000 })]), nowMs: t - 60_000 + (i++ % 2 ? 400 : -400) }
      : snap('/c/me', []) });
    let n = 0; c.on('update', () => n++);
    for (let k = 0; k < 6; k++) { await c.pollOnce(); t += 2000; }
    expect(n).toBe(1);
    expect(Math.abs(c.sessions()[0].stateSince - (NOW - 30_000))).toBeLessThan(1000);
  });

  describe('start', () => {
    afterEach(() => { vi.useRealTimers(); });
    it('a throwing update listener is logged, not an unhandled rejection that stops the daemon', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
      const log = vi.fn(); const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const c = new Collector(cfg, { now: () => NOW, log, probe: async (h) => snap(h.id === 'local' ? '/c/me' : '~/.claude-w', [reg(h.id, true)]) });
        c.on('update', () => { throw new Error('listener broke'); });
        c.start();
        await vi.advanceTimersByTimeAsync(10);
        c.stop();
        await new Promise((r) => setImmediate(r));
        expect(unhandled).not.toHaveBeenCalled();
        expect(String(log.mock.calls[0]?.[0])).toMatch(/listener broke/);
      } finally { process.off('unhandledRejection', unhandled); }
    });

    afterEach(() => { vi.useRealTimers(); });
    it('is idempotent: calling it twice does not double the polling', async () => {
      vi.useFakeTimers();
      let calls = 0;
      const c = new Collector(cfg, { now: () => NOW, probe: async (h) => { if (h.id === 'local') calls++; return snap(h.id === 'local' ? '/c/me' : '~/.claude-w', []); } });
      c.start(); c.start();
      await vi.advanceTimersByTimeAsync(cfg.pollMs * 3);
      c.stop();
      expect(calls).toBe(4); // one immediate poll plus three ticks
    });
  });
});

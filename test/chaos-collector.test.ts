import { describe, it, expect } from 'vitest';
import { Collector } from '../src/collector.js';
import { parseConfig } from '../src/config.js';
import { runProbe } from '../src/probe/run.js';
import { fakeSshDir } from './helpers/probe.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const cfg = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
`);
const entry = JSON.stringify({ type: 'assistant', timestamp: new Date(NOW - 60_000).toISOString(),
  message: { model: 'claude-opus-4-1', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] } });
const reg = (extra: object = {}) => ({ file: 'a.json', mtimeMs: NOW - 1000, live: true, transcript: [] as string[],
  data: { pid: 9, sessionId: 'a', cwd: '/x/a', startedAt: NOW - 600_000, status: 'busy', statusUpdatedAt: NOW - 1000 }, ...extra });
const snap = (regs: object[]) => ({ ok: true, nowMs: NOW, dirs: [{ configDir: '/c/me', registries: regs, events: [] }] });

describe('Collector chaos', () => {
  it('keeps the last transcript of a session the probe deferred for its budget, and asks for it again', async () => {
    const reqs: any[] = [];
    let poll = 0;
    const c = new Collector(cfg, { now: () => NOW, probe: async (_h, r) => {
      reqs.push(r);
      poll++;
      if (poll === 1) return snap([reg({ tsig: '10:1', transcript: [entry] })]);
      if (poll === 2) return snap([reg({ deferred: true })]); // changed on disk, but over this poll's budget
      return snap([reg({ tsig: '20:2', same: true })]);
    } });
    expect((await c.pollOnce())[0].currentAction).toBe('Bash: ls');
    expect((await c.pollOnce())[0].currentAction).toBe('Bash: ls');
    await c.pollOnce();
    expect(reqs[2].known['/c/me']).toEqual({ a: '10:1' }); // still the old signature, so the probe resends
    expect(reqs[0].budgetMs).toBeGreaterThan(0);
  });
});

describe('Collector chaos: request', () => {
  it('asks the probe to leave out dead registry files past stopped retention', async () => {
    const reqs: any[] = [];
    const c = new Collector(cfg, { now: () => NOW, probe: async (_h, r) => { reqs.push(r); return snap([]); } });
    await c.pollOnce();
    expect(reqs[0].deadAfterMs).toBeGreaterThanOrEqual(cfg.stoppedRetentionMs);
  });
});

describe('runProbe chaos: request size', () => {
  const big = () => {
    const known: Record<string, string> = {};
    for (let i = 0; i < 3000; i++) known[`0b6f1c2e-6d0e-4c1a-9a57-${String(i).padStart(12, '0')}`] = `123456:1791820000123456789`;
    return { mode: 'snapshot', dirs: ['/nonexistent'], known: { '/nonexistent': known } };
  };
  it('runs locally with a known map larger than one argv string may be (128 KB on Linux)', async () => {
    expect(JSON.stringify(big()).length).toBeGreaterThan(131072);
    const r: any = await runProbe({ id: 'local', tmuxSession: 'x', repoRoots: [] }, big());
    expect(r.ok).toBe(true);
  });
  it('runs over ssh with the same request', async () => {
    const saved = { ...process.env };
    process.env.PATH = `${fakeSshDir()}:${saved.PATH}`;
    try {
      const r: any = await runProbe({ id: 'fake', ssh: 'box', tmuxSession: 'x', repoRoots: [] }, big());
      expect(r.ok).toBe(true);
    } finally { process.env = { ...saved }; }
  });
  it('carries any string through the stdin request unchanged', async () => {
    const odd = ['/nonexistent/Документы', '/n/\u2028\u2029', '/n/"\'\\$`!*', '/n/\udcff', '/n/\n\t', '/n/\u{1F600}'];
    const r: any = await runProbe({ id: 'local', tmuxSession: 'x', repoRoots: [] }, { mode: 'snapshot', dirs: odd });
    expect(r.dirs.map((d: any) => d.configDir)).toEqual(odd);
  });
});

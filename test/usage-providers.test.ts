// The token and meter-log usage providers: config shapes, the poller's cadence and staleness, and an end-to-end
// run through the real probe (locally and over a fake ssh) with a stub messages server. Every token here is fake.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { UsagePoller, TOKEN_MIN_INTERVAL_MS, READING_STALE_MS } from '../src/usage.js';
import { startServer } from '../src/server.js';
import { fakeSshDir } from './helpers/probe.js';
import { startMessagesStub } from './helpers/stub-messages.js';

const FAKE = 'FAKE-setup-token-1a2b3c4d5e6f';
const MIN = 60_000;
const acct = (usage: string, extra = '') => `
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: d, label: D, colour: "#fff", host: box, configDir: ~/.claude-d, usage: ${usage}${extra}}
`;

describe('usage config: token and meter-log', () => {
  it('accepts the documented shapes', () => {
    const t = parseConfig(acct('{provider: token, tokenEnv: MY_CLAUDE_TOKEN, envFile: ~/.config/clayclaude/token.env}'));
    expect(t.accounts[0].usage).toEqual({ provider: 'token', tokenEnv: 'MY_CLAUDE_TOKEN', envFile: '~/.config/clayclaude/token.env' });
    expect(parseConfig(acct('{provider: token, tokenEnv: T, model: claude-haiku-5-5}')).accounts[0].usage).toMatchObject({ model: 'claude-haiku-5-5' });
    const m = parseConfig(acct('{provider: meter-log, log: ~/ops/claude-usage-meter-work.log}'));
    expect(m.accounts[0].usage).toEqual({ provider: 'meter-log', log: '~/ops/claude-usage-meter-work.log' });
    expect(parseConfig(acct('{provider: oauth}')).accounts[0].usage).toEqual({ provider: 'oauth', refresh: true });
  });

  it('refuses an env name that is not [A-Za-z_][A-Za-z0-9_]*', () => {
    for (const bad of ['"X;rm -rf ~"', '"$HOME"', '1ABC', '"A B"', '"A-B"', '""', '"X\\nY"'])
      expect(() => parseConfig(acct(`{provider: token, tokenEnv: ${bad}}`)), bad).toThrow();
  });

  it('refuses a path that is not absolute or ~/, or that holds a control character', () => {
    for (const bad of ['"~root/.bashrc"', 'relative/log', '"~"', '"/x\\ny"', '"/x\\0y"', '"-oProxyCommand=x"'])
      expect(() => parseConfig(acct(`{provider: meter-log, log: ${bad}}`)), bad).toThrow();
    for (const bad of ['"~root/env"', 'env'])
      expect(() => parseConfig(acct(`{provider: token, tokenEnv: T, envFile: ${bad}}`)), bad).toThrow();
    // Odd but literal: it rides to the host as JSON data, never through a shell.
    expect(() => parseConfig(acct(`{provider: meter-log, log: "~/$(touch x) 'y'"}`))).not.toThrow();
  });

  it('refuses a model that is not a plain model id', () => {
    expect(() => parseConfig(acct('{provider: token, tokenEnv: T, model: "x\\"; y"}'))).toThrow();
  });
});

const reading = (u5: number, r5: string | null, u7: number, r7: string | null) =>
  ({ five_hour: { utilization: u5, resets_at: r5 }, seven_day: { utilization: u7, resets_at: r7 } });
const iso = (ms: number) => new Date(ms).toISOString();

describe('UsagePoller: token provider', () => {
  const cfg = parseConfig(acct('{provider: token, tokenEnv: GS_T, envFile: ~/.config/x/env}'));
  const T0 = Date.parse('2026-10-13T10:00:00Z');

  it('asks the host at most once per 5 minutes, and shows the last reading fresh between calls', async () => {
    let t = T0; const reqs: any[] = [];
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => { reqs.push(r); const e = r.accounts.find((a: any) => a.key === 'd');
        return { ok: true, accounts: e ? [{ key: 'd', configDir: e.configDir, ok: true, ...reading(30, iso(t + 3600_000), 40, iso(t + 86_400_000)) }] : [] }; } });
    for (let i = 0; i <= 12; i++) { await p.pollOnce(); expect(p.usage()[0], `t+${i}m`).toMatchObject({ fiveHour: 30, weekly: 40, stale: false }); t += MIN; }
    const asked = reqs.filter((r) => r.accounts.some((a: any) => a.key === 'd'));
    expect(asked).toHaveLength(3); // t0, t0+5, t0+10
    expect(asked[0].accounts[0]).toEqual({ kind: 'token', key: 'd', configDir: '~/.claude-d', tokenEnv: 'GS_T', envFile: '~/.config/x/env' });
    expect(TOKEN_MIN_INTERVAL_MS).toBe(5 * MIN);
  });

  it('counts a failed call too: a 401 is not retried for 5 minutes, and the meter goes stale', async () => {
    let t = T0; let n = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => { if (r.accounts.length) n++; return { ok: true, accounts: r.accounts.map((a: any) => ({ key: a.key, configDir: a.configDir, ok: false, status: 401, error: 'HTTPError: HTTP Error 401' })) }; } });
    for (let i = 0; i < 5; i++) { await p.pollOnce(); t += MIN; }
    expect(n).toBe(1);
    expect(p.usage()[0].stale).toBe(true);
    await p.pollOnce();
    expect(n).toBe(2);
  });

  it('an ssh failure is a stale meter, not a crash', async () => {
    const logs: string[] = [];
    const p = new UsagePoller(cfg, { log: (m) => logs.push(m), probe: async () => { throw new Error('box: exit 255: ssh: connect to host box port 22: Connection refused'); } });
    const u = await p.pollOnce();
    expect(u[0]).toMatchObject({ stale: true, fiveHour: null });
    expect(logs.join()).toContain('Connection refused');
  });

  it('a 429 backs off for at least the 5-minute spacing', async () => {
    let t = T0; let n = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => { if (r.accounts.length) n++; return { ok: true, accounts: r.accounts.map((a: any) => ({ key: a.key, configDir: a.configDir, ok: false, status: 429, retryAfterS: 0, error: '429' })) }; } });
    await p.pollOnce(); t += 4 * MIN; await p.pollOnce();
    expect(n).toBe(1);
  });

  it('a lapsed five-hour window reads 0 with no reset and is not stale; the next ask lets the host hold the call', async () => {
    let t = T0; const reqs: any[] = []; let answer: any = reading(80, iso(T0 + 2 * MIN), 40, iso(T0 + 86_400_000));
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => { reqs.push(r); return { ok: true, accounts: r.accounts.map((a: any) => ({ key: a.key, configDir: a.configDir, ok: true, ...answer })) }; } });
    await p.pollOnce();
    expect(p.usage()[0]).toMatchObject({ fiveHour: 80, stale: false });
    t += 3 * MIN; await p.pollOnce();
    expect(p.usage()[0]).toMatchObject({ fiveHour: 0, fiveHourResetsAt: null, weekly: 40, stale: false });
    answer = { held: 'lapsed' };
    t += 2 * MIN; await p.pollOnce();
    const last = reqs.at(-1).accounts[0];
    expect(last.idleSinceMs).toBe(T0 + 2 * MIN);
    t += 60 * MIN; await p.pollOnce();
    expect(p.usage()[0]).toMatchObject({ fiveHour: 0, weekly: 40, stale: false });
  });

  it('does not call while the week is capped, and the capped reading is not stale', async () => {
    let t = T0; let n = 0;
    const p = new UsagePoller(cfg, { now: () => t, log: () => {},
      probe: async (_h, r: any) => { if (r.accounts.length) n++;
        return { ok: true, accounts: r.accounts.map((a: any) => ({ key: a.key, configDir: a.configDir, ok: true, ...reading(10, iso(T0 + 3600_000), 100, iso(T0 + 2 * 86_400_000)) })) }; } });
    await p.pollOnce();
    t += 30 * MIN; await p.pollOnce();
    expect(n).toBe(1);
    expect(p.usage()[0]).toMatchObject({ weekly: 100, stale: false });
    expect(p.isExhausted('d')).toBe(true);
  });
});

describe('UsagePoller: meter-log provider', () => {
  const cfg = parseConfig(acct('{provider: meter-log, log: ~/ops/m.log}'));
  const T0 = Date.parse('2026-10-13T10:00:00Z');
  const run = async (entry: object, t: number) => {
    const reqs: any[] = [];
    const p = new UsagePoller(cfg, { now: () => t, log: () => {}, probe: async (_h, r: any) => { reqs.push(r); return { ok: true, accounts: [{ key: 'd', configDir: '~/.claude-d', ok: true, ...entry }] }; } });
    await p.pollOnce();
    return { p, reqs };
  };

  it('asks for the log every poll and takes the reading at its own time', async () => {
    const { p, reqs } = await run({ ts: iso(T0 - 10 * MIN), ...reading(7, iso(T0 + 3600_000), 22, iso(T0 + 86_400_000)) }, T0);
    expect(reqs[0].accounts[0]).toEqual({ kind: 'meter-log', key: 'd', configDir: '~/.claude-d', log: '~/ops/m.log' });
    expect(p.usage()[0]).toMatchObject({ fiveHour: 7, weekly: 22, stale: false, updatedAt: T0 - 10 * MIN });
  });

  it('is stale once the reading is older than READING_STALE_MS (15 min)', async () => {
    expect(READING_STALE_MS).toBe(15 * MIN);
    const r = reading(7, iso(T0 + 3600_000), 22, iso(T0 + 86_400_000));
    expect((await run({ ts: iso(T0 - 15 * MIN), ...r }, T0)).p.usage()[0].stale).toBe(false);
    expect((await run({ ts: iso(T0 - 15 * MIN - 1000), ...r }, T0)).p.usage()[0]).toMatchObject({ stale: true, fiveHour: 7 });
    expect((await run({ ts: 'garbage', ...r }, T0)).p.usage()[0].stale).toBe(true);
    expect((await run({ ...r }, T0)).p.usage()[0].stale).toBe(true);
  });

  it('a reading held in a lapsed five-hour window, the account idle since, is not stale until its own weekly reset passes', async () => {
    const { p } = await run({ ts: iso(T0 - 120 * MIN), idle: true, ...reading(60, iso(T0 - 30 * MIN), 22, iso(T0 + 86_400_000)) }, T0);
    expect(p.usage()[0]).toMatchObject({ fiveHour: 0, fiveHourResetsAt: null, weekly: 22, stale: false });
  });

  it('a 20-minute-old reading after the five-hour reset: stale if the account was used since, held if it was idle', async () => {
    const r = { ts: iso(T0 - 20 * MIN), ...reading(60, iso(T0 - 10 * MIN), 22, iso(T0 + 86_400_000)) };
    expect((await run({ ...r, idle: false }, T0)).p.usage()[0]).toMatchObject({ fiveHour: 0, stale: true });
    expect((await run({ ...r }, T0)).p.usage()[0].stale).toBe(true); // no word from the host: not idle
    expect((await run({ ...r, idle: true }, T0)).p.usage()[0]).toMatchObject({ fiveHour: 0, stale: false });
  });

  it('a fresh reading is not stale, idle or not', async () => {
    const r = { ts: iso(T0 - 5 * MIN), ...reading(60, iso(T0 - 2 * MIN), 22, iso(T0 + 86_400_000)) };
    expect((await run({ ...r, idle: false }, T0)).p.usage()[0].stale).toBe(false);
    expect((await run({ ...r, idle: true }, T0)).p.usage()[0].stale).toBe(false);
  });

  it('a capped week no longer holds a meter-log reading on its own', async () => {
    const r = { ts: iso(T0 - 20 * MIN), ...reading(30, iso(T0 + 60 * MIN), 100, iso(T0 + 86_400_000)) };
    expect((await run({ ...r, idle: true }, T0)).p.usage()[0]).toMatchObject({ weekly: 100, stale: true });
  });

  it('a dead meter on an account still in use is stale, not a fresh 0% until the weekly reset', async () => {
    // The meter stopped 3 days ago; its five-hour window reset long since and the week resets in 4 days. Claude runs
    // on the account since that reset mean a live meter would have written a new line.
    const t = Date.parse('2026-10-16T12:00:00Z');
    const old = { ts: '2026-10-13T12:00:00Z', idle: false, ...reading(80, '2026-10-13T15:00:00Z', 40, '2026-10-20T12:00:00Z') };
    const { p } = await run(old, t);
    expect(p.usage()[0]).toMatchObject({ fiveHour: 0, weekly: 40, stale: true });
  });

  it('a dead meter is not shown as fresh 0% once the reading\'s weekly reset has passed', async () => {
    // The last line is 3.5 days old: five-hour 99%, week 95% resetting 2026-10-15T23:00Z.
    const t = Date.parse('2026-10-16T12:00:00Z');
    const old = { ts: '2026-10-13T00:00:00Z', idle: true, ...reading(99, '2026-10-13T04:00:00Z', 95, '2026-10-15T23:00:00Z') };
    const { p } = await run(old, t);
    expect(p.usage()[0]).toMatchObject({ fiveHour: 0, weekly: 0, stale: true });
    expect(p.isExhausted('d')).toBe(false);
  });

  it('an old reading with no five-hour or weekly reset time is stale, not held', async () => {
    const ts = iso(T0 - 120 * MIN), idle = true;
    expect((await run({ ts, idle, ...reading(60, null, 22, iso(T0 + 86_400_000)) }, T0)).p.usage()[0].stale).toBe(true);
    expect((await run({ ts, idle, ...reading(60, iso(T0 - 30 * MIN), 22, null) }, T0)).p.usage()[0].stale).toBe(true);
    expect((await run({ ts, idle, five_hour: null, seven_day: { utilization: 22, resets_at: iso(T0 + 86_400_000) } }, T0)).p.usage()[0].stale).toBe(true);
  });

  it('a host error is a stale meter', async () => {
    const p = new UsagePoller(cfg, { log: () => {}, probe: async () => ({ ok: true, accounts: [{ key: 'd', configDir: '~/.claude-d', ok: false, error: 'FileNotFoundError: x' }] }) });
    expect((await p.pollOnce())[0].stale).toBe(true);
  });
});

describe('token provider end to end through the real probe (fake token, stub server)', () => {
  const saved = { ...process.env };
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'cc-e2e-')); mkdirSync(join(home, '.cfg')); mkdirSync(join(home, '.claude-d')); });
  afterEach(() => { process.env = { ...saved }; });

  class FakeCollector extends EventEmitter { sessions() { return []; } }

  it('locally: reads the env file, never lets the token into the daemon logs, /api/state or /usage', async () => {
    const s = await startMessagesStub();
    writeFileSync(join(home, '.cfg', 'env'), `CC_E2E_TOKEN=${FAKE}\n`);
    process.env.CLAYCLAUDE_MESSAGES_URL = s.url;
    delete process.env.CC_E2E_TOKEN;
    const cfg = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: d, label: D, colour: "#fff", host: local, configDir: ${home}/.claude-d, usage: {provider: token, tokenEnv: CC_E2E_TOKEN, envFile: ${home}/.cfg/env}}
  - {id: e, label: E, colour: "#fff", host: local, configDir: ${home}/.claude-d, usage: {provider: token, tokenEnv: CC_E2E_TOKEN, envFile: ${home}/.cfg/env}}
`);
    const logs: string[] = [];
    const p = new UsagePoller(cfg, { log: (m) => logs.push(m) });
    const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
    writeFileSync(join(web, 'index.html'), 'x');
    const srv = await startServer({ cfg, collector: new FakeCollector() as any, usage: p, webRoot: web, port: 0 });
    try {
      await p.pollOnce();
      expect(p.usage()[0]).toMatchObject({ fiveHour: 25, weekly: 40, stale: false });
      expect(s.calls.map((c) => c.auth)).toEqual([`Bearer ${FAKE}`, `Bearer ${FAKE}`]);
      s.status = 401; s.reason = `bad token ${FAKE}`;
      process.env.CLAYCLAUDE_MESSAGES_URL = s.url;
      const q = new UsagePoller(cfg, { log: (m) => logs.push(m) });
      await q.pollOnce();
      expect(q.usage()[0].stale).toBe(true);
      expect(logs.join('\n')).toContain('401');
      const state = await (await fetch(`http://127.0.0.1:${srv.port}/api/state`)).text();
      const usage = await (await fetch(`http://127.0.0.1:${srv.port}/usage`)).text();
      expect(state).toContain('"fiveHour":25');
      for (const text of [state, usage, logs.join('\n'), JSON.stringify(q.usage())]) {
        expect(text).not.toContain(FAKE);
        expect(text).not.toContain(FAKE.slice(5, 21));
      }
    } finally { await srv.close(); await s.close(); }
  });

  it('over ssh: hostile paths stay data (no shell runs them), ~ is the remote home, and the ssh argv is fixed', async () => {
    const s = await startMessagesStub();
    const fake = fakeSshDir();
    process.env.PATH = `${fake}:${saved.PATH}`;
    process.env.HOME = home; // the fake ssh runs the remote side as this user, in this home
    process.env.FAKE_SSH_CWD = home;
    process.env.CLAYCLAUDE_MESSAGES_URL = s.url;
    process.env.CC_E2E_TOKEN = '';
    const evil = "$(touch PWNED1)`touch PWNED2`;touch PWNED3 'q\" x";
    mkdirSync(join(home, evil));
    writeFileSync(join(home, evil, 'env'), `CC_E2E_TOKEN=${FAKE}\n`);
    writeFileSync(join(home, evil, 'm.log'), JSON.stringify({ ts: new Date().toISOString(), ...reading(12, iso(Date.now() + 3600_000), 34, iso(Date.now() + 86_400_000)) }) + '\n');
    const cfg = parseConfig(`
hosts: [{id: box, ssh: box}]
accounts:
  - id: t
    label: T
    colour: "#fff"
    host: box
    configDir: ~/.claude-d
    usage: {provider: token, tokenEnv: CC_E2E_TOKEN, envFile: ${JSON.stringify('~/' + evil + '/env')}}
  - id: m
    label: M
    colour: "#fff"
    host: box
    configDir: ~/.claude-d
    usage: {provider: meter-log, log: ${JSON.stringify('~/' + evil + '/m.log')}}
`);
    const logs: string[] = [];
    try {
      const p = new UsagePoller(cfg, { log: (m) => logs.push(m) });
      const u = await p.pollOnce();
      expect(u.map((x) => [x.account, x.fiveHour, x.weekly, x.stale])).toEqual([['t', 25, 40, false], ['m', 12, 34, false]]);
      expect(readdirSync(home).filter((f) => f.startsWith('PWNED'))).toEqual([]);
      const argv = readFileSync(join(fake, 'argv.log'), 'utf8').trim().split('\n');
      expect(argv).toHaveLength(1);
      expect(argv[0].endsWith('-- box python3 -I -')).toBe(true);
      expect(argv[0]).not.toContain('PWNED');
      expect(JSON.stringify(u) + logs.join('\n')).not.toContain(FAKE);
    } finally { await s.close(); }
  });
});

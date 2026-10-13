// The probe's token and meter-log usage kinds, run as the real script against synthetic fixtures and a stub
// messages server. Every token here is fake; nothing reaches the real API.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBE, PYTHON } from './helpers/probe.js';
import { startMessagesStub, type MessagesStub } from './helpers/stub-messages.js';

const execFileP = promisify(execFile);
const FAKE = 'FAKE-setup-token-9f8e7d6c5b4a';

async function probe(accounts: object[], env: Record<string, string | undefined> = {}, home?: string) {
  const e: Record<string, string | undefined> = { ...process.env, ...env };
  delete e.CC_TEST_TOKEN;
  if (env.CC_TEST_TOKEN !== undefined) e.CC_TEST_TOKEN = env.CC_TEST_TOKEN;
  if (home) e.HOME = home;
  const { stdout, stderr } = await execFileP(PYTHON, [PROBE, JSON.stringify({ mode: 'usage', accounts })], { encoding: 'utf8', env: e as NodeJS.ProcessEnv, cwd: home });
  return { r: JSON.parse(stdout), out: stdout + stderr };
}
const dir = () => mkdtempSync(join(tmpdir(), 'cc-up-'));

describe('probe usage: token kind', () => {
  let s: MessagesStub;
  beforeAll(async () => { s = await startMessagesStub(); });
  afterAll(async () => { await s.close(); });
  const env = (extra: Record<string, string | undefined> = {}) => ({ CLAYCLAUDE_MESSAGES_URL: s.url, ...extra });

  it('reads the token from the env file, sends one 1-token call, and turns the headers into percent and ISO times', async () => {
    const home = dir(); mkdirSync(join(home, '.cfg'));
    writeFileSync(join(home, '.cfg', 'env'), `# comment\nOTHER=x\nexport CC_TEST_TOKEN="${FAKE}"\n`);
    s.calls.length = 0;
    const { r, out } = await probe([{ kind: 'token', key: 'work', configDir: join(home, 'cd'), tokenEnv: 'CC_TEST_TOKEN', envFile: '~/.cfg/env' }], env(), home);
    const e = r.accounts[0];
    expect(e).toMatchObject({ key: 'work', ok: true, five_hour: { utilization: 25 }, seven_day: { utilization: 40 } });
    expect(Date.parse(e.five_hour.resets_at)).toBe(Number(s.headers['anthropic-ratelimit-unified-5h-reset']) * 1000);
    expect(Date.parse(e.seven_day.resets_at)).toBe(Number(s.headers['anthropic-ratelimit-unified-7d-reset']) * 1000);
    expect(s.calls).toHaveLength(1);
    expect(s.calls[0].auth).toBe(`Bearer ${FAKE}`);
    expect(s.calls[0].version).toBe('2023-06-01');
    expect(s.calls[0].body).toMatchObject({ max_tokens: 1 });
    expect(s.calls[0].body.model).toMatch(/haiku/);
    expect(out).not.toContain(FAKE);
  });

  it('the process environment wins over the env file', async () => {
    const home = dir();
    writeFileSync(join(home, 'env'), 'CC_TEST_TOKEN=from-file-FAKE\n');
    s.calls.length = 0;
    await probe([{ kind: 'token', key: 'a', configDir: home, tokenEnv: 'CC_TEST_TOKEN', envFile: join(home, 'env') }], env({ CC_TEST_TOKEN: FAKE }));
    expect(s.calls[0].auth).toBe(`Bearer ${FAKE}`);
  });

  it('parses the env file, never runs it', async () => {
    const home = dir();
    const pwned = join(home, 'PWNED');
    writeFileSync(join(home, 'env'), `touch ${pwned}\n$(touch ${pwned})\nCC_TEST_TOKEN=${FAKE}$(touch ${pwned})\n`);
    s.calls.length = 0;
    const { r } = await probe([{ kind: 'token', key: 'a', configDir: home, tokenEnv: 'CC_TEST_TOKEN', envFile: join(home, 'env') }], env());
    expect(existsSync(pwned)).toBe(false);
    expect(s.calls[0]?.auth).toBe(`Bearer ${FAKE}$(touch ${pwned})`); // taken literally
    expect(r.accounts[0].ok).toBe(true);
  });

  it('a missing variable, a missing env file and a bad variable name are errors that name no value', async () => {
    const home = dir();
    writeFileSync(join(home, 'env'), `SOMETHING_ELSE=${FAKE}\n`);
    s.calls.length = 0;
    const { r, out } = await probe([
      { kind: 'token', key: 'a', configDir: home, tokenEnv: 'CC_TEST_TOKEN', envFile: join(home, 'env') },
      { kind: 'token', key: 'b', configDir: home, tokenEnv: 'CC_TEST_TOKEN', envFile: join(home, 'nope') },
      { kind: 'token', key: 'c', configDir: home, tokenEnv: 'X;touch /tmp/x', envFile: join(home, 'env') },
    ], env());
    expect(r.accounts.map((e: any) => e.ok)).toEqual([false, false, false]);
    expect(r.accounts[0].error).toContain('CC_TEST_TOKEN');
    expect(s.calls).toHaveLength(0);
    expect(out).not.toContain(FAKE);
  });

  for (const [status, why] of [[401, 'rejected'], [403, 'forbidden'], [429, 'limited']] as const) {
    it(`a ${status} is an error with its status, and the token is redacted even from a status text that quotes it`, async () => {
      s.status = status; s.reason = `Nope ${FAKE} ${why}`;
      try {
        const { r, out } = await probe([{ kind: 'token', key: 'a', configDir: dir(), tokenEnv: 'CC_TEST_TOKEN' }], env({ CC_TEST_TOKEN: FAKE }));
        expect(r.accounts[0]).toMatchObject({ ok: false, status });
        if (status === 429) expect(r.accounts[0].retryAfterS).toBe(120);
        expect(out).not.toContain(FAKE);
        expect(out).not.toContain(FAKE.slice(4, 20));
      } finally { s.status = 200; s.reason = undefined; }
    });
  }

  it('a connection failure is an error, not a crash', async () => {
    const { r, out } = await probe([{ kind: 'token', key: 'a', configDir: dir(), tokenEnv: 'CC_TEST_TOKEN' }],
      { CLAYCLAUDE_MESSAGES_URL: 'http://127.0.0.1:1/v1/messages', CC_TEST_TOKEN: FAKE });
    expect(r.accounts[0].ok).toBe(false);
    expect(out).not.toContain(FAKE);
  });

  it('a reply without the rate-limit headers is an error, not a reading of nothing', async () => {
    const saved = s.headers; s.headers = {};
    try {
      const { r } = await probe([{ kind: 'token', key: 'a', configDir: dir(), tokenEnv: 'CC_TEST_TOKEN' }], env({ CC_TEST_TOKEN: FAKE }));
      expect(r.accounts[0]).toMatchObject({ ok: false });
      expect(r.accounts[0].error).toMatch(/rate-limit headers/);
    } finally { s.headers = saved; }
  });

  it('never follows a redirect: the bearer token is not sent on to wherever a 30x points', async () => {
    const seen: (string | undefined)[] = [];
    const elsewhere = createServer((req, res) => { seen.push(req.headers.authorization); req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const to = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/grab`;
    const redirector = createServer((req, res) => { req.resume(); res.writeHead(302, { location: to }); res.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    const from = `http://127.0.0.1:${(redirector.address() as AddressInfo).port}`;
    try {
      const home = dir(); mkdirSync(join(home, '.claude-a'));
      writeFileSync(join(home, '.claude-a', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: FAKE, refreshToken: 'r-FAKE', expiresAt: Date.now() + 3600_000 } }));
      const { r, out } = await probe([
        { kind: 'token', key: 'a', configDir: dir(), tokenEnv: 'CC_TEST_TOKEN' },
        { key: 'b', configDir: join(home, '.claude-a'), refresh: false },
      ], { CLAYCLAUDE_MESSAGES_URL: `${from}/v1/messages`, CLAYCLAUDE_USAGE_URL: `${from}/api/oauth/usage`, CC_TEST_TOKEN: FAKE }, home);
      expect(r.accounts.map((e: any) => e.ok)).toEqual([false, false]);
      expect(seen).toEqual([]);
      expect(out).not.toContain(FAKE);
    } finally {
      await new Promise((r) => redirector.close(r)); await new Promise((r) => elsewhere.close(r));
    }
  });

  it('holds (no call) in a lapsed window until a claude run touches <configDir>/sessions', async () => {
    const cd = dir(); mkdirSync(join(cd, 'sessions'));
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(cd, 'sessions'), old, old);
    s.calls.length = 0;
    const a = { kind: 'token', key: 'a', configDir: cd, tokenEnv: 'CC_TEST_TOKEN', idleSinceMs: Date.now() - 600_000 };
    let { r } = await probe([a], env({ CC_TEST_TOKEN: FAKE }));
    expect(r.accounts[0]).toMatchObject({ ok: true, held: 'lapsed' });
    expect(s.calls).toHaveLength(0);
    writeFileSync(join(cd, 'sessions', 'new.json'), '{}'); // a claude run since the reset
    ({ r } = await probe([a], env({ CC_TEST_TOKEN: FAKE })));
    expect(r.accounts[0]).toMatchObject({ ok: true, five_hour: { utilization: 25 } });
    expect(s.calls).toHaveLength(1);
  });
});

describe('probe usage: meter-log kind', () => {
  const line = (ts: string, u5: number, extra: object = {}) => JSON.stringify({ ts, account: 'work', identity: 'abc',
    five_hour: { utilization: u5, resets_at: '2026-10-13T02:30:00+00:00' }, seven_day: { utilization: 22.0, resets_at: '2026-10-15T23:00:00+00:00' },
    source: 'ratelimit_headers', model: 'm', ratelimit: { status: 'allowed' }, ...extra });

  it('takes the newest complete reading; a partial trailing line, a malformed line and an error line are skipped', async () => {
    const home = dir(); mkdirSync(join(home, 'ops'));
    writeFileSync(join(home, 'ops', 'm.log'), [
      line('2026-10-12T22:50:00+00:00', 5),
      line('2026-10-12T22:56:45+00:00', 7),
      '{"ts": "2026-10-12T22:57:00+00:00", "error": "HTTPError", "reason": "429"}',
      '{not json',
      '{"ts": "2026-10-12T23:01:00+00:00", "five_hour": {"utiliz', // still being written: no newline yet
    ].join('\n'));
    const { r } = await probe([{ kind: 'meter-log', key: 'work', configDir: home, log: '~/ops/m.log' }], {}, home);
    expect(r.accounts[0]).toEqual({ key: 'work', configDir: home, email: null, ok: true, ts: '2026-10-12T22:56:45+00:00', idle: true,
      five_hour: { utilization: 7, resets_at: '2026-10-13T02:30:00+00:00' }, seven_day: { utilization: 22, resets_at: '2026-10-15T23:00:00+00:00' } });
  });

  it('reports idle only while <configDir>/sessions is missing or untouched since the reading\'s five-hour reset', async () => {
    const home = dir(); mkdirSync(join(home, 'ops'));
    writeFileSync(join(home, 'ops', 'm.log'), line('2026-10-12T22:56:45+00:00', 7) + '\n'); // five-hour reset 2026-10-13T02:30Z
    const a = { kind: 'meter-log', key: 'work', configDir: home, log: '~/ops/m.log' };
    const idle = async () => (await probe([a], {}, home)).r.accounts[0].idle;
    expect(await idle()).toBe(true); // no sessions directory: no claude run at all
    mkdirSync(join(home, 'sessions'));
    const at = (iso: string) => { const d = new Date(iso); utimesSync(join(home, 'sessions'), d, d); };
    at('2026-10-13T02:00:00Z');
    expect(await idle()).toBe(true);
    at('2026-10-13T02:31:00Z'); // a claude run after the reset
    expect(await idle()).toBe(false);
    writeFileSync(join(home, 'ops', 'm.log'), JSON.stringify({ ts: 'x', five_hour: { utilization: 1, resets_at: 'garbage' } }) + '\n');
    expect(await idle()).toBe(false); // no reset time to be idle since
  });

  it('is not idle while a registry file in <configDir>/sessions was written since the reset (a run spanning it)', async () => {
    const home = dir(); mkdirSync(join(home, 'ops')); mkdirSync(join(home, 'sessions'));
    writeFileSync(join(home, 'ops', 'm.log'), line('2026-10-12T22:56:45+00:00', 7) + '\n'); // five-hour reset 2026-10-13T02:30Z
    const a = { kind: 'meter-log', key: 'work', configDir: home, log: '~/ops/m.log' };
    const f = join(home, 'sessions', '42.json');
    writeFileSync(f, '{}');
    const set = (p: string, iso: string) => { const d = new Date(iso); utimesSync(p, d, d); };
    set(f, '2026-10-13T02:00:00Z'); set(join(home, 'sessions'), '2026-10-13T02:00:00Z');
    expect((await probe([a], {}, home)).r.accounts[0].idle).toBe(true);
    set(f, '2026-10-13T02:45:00Z'); // the session that started before the reset is still updating its registry
    expect((await probe([a], {}, home)).r.accounts[0].idle).toBe(false);
  });

  it('reads only the end of a large log', async () => {
    const home = dir();
    const filler = line('2020-01-01T00:00:00+00:00', 1) + '\n';
    writeFileSync(join(home, 'big.log'), filler.repeat(Math.ceil(17e6 / filler.length)) + line('2026-10-12T22:56:45+00:00', 9) + '\n');
    const t0 = Date.now();
    const { r } = await probe([{ kind: 'meter-log', key: 'd', configDir: home, log: join(home, 'big.log') }]);
    expect(r.accounts[0]).toMatchObject({ ok: true, five_hour: { utilization: 9 } });
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it('a missing log, a log with no reading and a directory are errors, not crashes', async () => {
    const home = dir();
    writeFileSync(join(home, 'junk.log'), 'nope\n{"error": "x"}\n');
    const { r } = await probe([
      { kind: 'meter-log', key: 'a', configDir: home, log: join(home, 'missing.log') },
      { kind: 'meter-log', key: 'b', configDir: home, log: join(home, 'junk.log') },
      { kind: 'meter-log', key: 'c', configDir: home, log: home },
    ]);
    expect(r.accounts.map((e: any) => e.ok)).toEqual([false, false, false]);
  });

  it('~ is the home only: ~user is not expanded, and shell syntax in a path is just characters', async () => {
    const home = dir();
    const { r } = await probe([
      { kind: 'meter-log', key: 'a', configDir: home, log: '~root/.bashrc' },
      { kind: 'meter-log', key: 'b', configDir: home, log: '~/$(touch PWNED)`touch PWNED2`;touch PWNED3' },
    ], {}, home);
    expect(r.accounts.map((e: any) => e.ok)).toEqual([false, false]);
    expect(readdirSync(home)).toEqual([]);
  });
});

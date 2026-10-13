// Task 46: the probe's `models` mode, run as the real script against a stub GET /v1/models. Every token here is fake;
// nothing reaches the real API.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PROBE, PYTHON } from './helpers/probe.js';

const execFileP = promisify(execFile);
const FAKE = 'FAKE-oauth-access-7a6b5c4d3e2f';
const FAKE_SETUP = 'FAKE-setup-token-1a2b3c4d5e6f';

interface Call { url: string; auth?: string; version?: string; beta?: string; ua?: string }
const PAGE1 = [
  { type: 'model', id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
  { type: 'model', id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', created_at: '2026-09-02T00:00:00Z' },
];
const PAGE2 = [
  { type: 'model', id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-02-01T00:00:00Z', extra: 'dropped' },
  { type: 'model', id: '--dangerously-skip-permissions', display_name: 'bad id' },
];

let srv: Server; let base = ''; const calls: Call[] = [];
let status = 200; let reason = '';
beforeAll(async () => {
  srv = createServer((req, res) => {
    calls.push({ url: req.url!, auth: req.headers.authorization, version: req.headers['anthropic-version'] as string,
      beta: req.headers['anthropic-beta'] as string, ua: req.headers['user-agent'] });
    if (status !== 200) { res.writeHead(status, reason, { 'content-type': 'application/json' }); res.end('{"error":{"message":"stub"}}'); return; }
    const u = new URL(req.url!, 'http://x');
    const second = u.searchParams.get('after_id') === 'claude-sonnet-5-5';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(second ? { data: PAGE2, has_more: false, first_id: 'claude-opus-4-8', last_id: 'x' }
      : { data: PAGE1, has_more: true, first_id: 'claude-opus-5-5', last_id: 'claude-sonnet-5-5' }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1/models`;
});
afterAll(async () => { srv.closeAllConnections(); await new Promise((r) => srv.close(r)); });
beforeEach(() => { calls.length = 0; status = 200; reason = ''; });

async function probe(accounts: object[], env: Record<string, string> = {}, home?: string) {
  const e: Record<string, string | undefined> = { ...process.env, CLAYCLAUDE_MODELS_URL: base, ...env };
  if (!env.CC_TEST_TOKEN) delete e.CC_TEST_TOKEN;
  if (home) e.HOME = home;
  const { stdout, stderr } = await execFileP(PYTHON, [PROBE, JSON.stringify({ mode: 'models', accounts })], { encoding: 'utf8', env: e as NodeJS.ProcessEnv });
  return { r: JSON.parse(stdout), out: stdout + stderr };
}
function oauthDir(expiresAt = Date.now() + 3_600_000) {
  const d = mkdtempSync(join(tmpdir(), 'cc-models-'));
  writeFileSync(join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: FAKE, refreshToken: `r-${FAKE}`, expiresAt } }));
  return d;
}

describe('probe models mode', () => {
  it('lists the models with the account\'s OAuth token, following pages, and returns only id, display_name and created_at', async () => {
    const d = oauthDir();
    const { r, out } = await probe([{ key: 'a', configDir: d, kind: 'oauth' }]);
    expect(r.ok).toBe(true);
    expect(r.accounts).toEqual([{ key: 'a', ok: true, models: [
      { id: 'claude-opus-5-5', display_name: 'Opus 5.5', created_at: '2026-09-01T00:00:00Z' },
      { id: 'claude-sonnet-5-5', display_name: 'Sonnet 5.5', created_at: '2026-09-02T00:00:00Z' },
      { id: 'claude-opus-4-8', display_name: 'Opus 4.8', created_at: '2026-02-01T00:00:00Z' },
    ] }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ auth: `Bearer ${FAKE}`, version: '2023-06-01', beta: 'oauth-2025-04-20' });
    expect(calls[0].ua).toMatch(/^claude-code\//);
    expect(new URL(calls[1].url, 'http://x').searchParams.get('after_id')).toBe('claude-sonnet-5-5');
    expect(out).not.toContain(FAKE);
  });

  it('uses a setup token from the env file for a token account', async () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-models-'));
    writeFileSync(join(home, 'env'), `CC_TEST_TOKEN=${FAKE_SETUP}\n`);
    const { r, out } = await probe([{ key: 'b', configDir: join(home, 'cd'), kind: 'token', tokenEnv: 'CC_TEST_TOKEN', envFile: '~/env' }], {}, home);
    expect(r.accounts[0]).toMatchObject({ key: 'b', ok: true });
    expect(calls[0].auth).toBe(`Bearer ${FAKE_SETUP}`);
    expect(out).not.toContain(FAKE_SETUP);
  });

  it('never refreshes: an expired token is an error and nothing is sent; the credentials file is left as it was', async () => {
    const d = oauthDir(Date.now() - 1000);
    const before = readFileSync(join(d, '.credentials.json'), 'utf8');
    const { r, out } = await probe([{ key: 'a', configDir: d, kind: 'oauth' }]);
    expect(r.accounts[0]).toMatchObject({ key: 'a', ok: false });
    expect(r.accounts[0].error).toMatch(/expired/);
    expect(calls).toHaveLength(0);
    expect(readFileSync(join(d, '.credentials.json'), 'utf8')).toBe(before);
    expect(out).not.toContain(FAKE);
  });

  it('reports an HTTP failure with its status, and a hostile reason line never carries the token out', async () => {
    status = 401; reason = `bad token ${FAKE}`;
    const d = oauthDir();
    const { r, out } = await probe([{ key: 'a', configDir: d, kind: 'oauth' }, { key: 'm', configDir: join(d, 'missing'), kind: 'oauth' }]);
    expect(r.accounts[0]).toMatchObject({ key: 'a', ok: false, status: 401 });
    expect(r.accounts[1]).toMatchObject({ key: 'm', ok: false });
    expect(out).not.toContain(FAKE);
  });

  it('never follows a redirect: the bearer token is not sent on to wherever a 30x points', async () => {
    const seen: (string | undefined)[] = [];
    const elsewhere = createServer((req, res) => { seen.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"data":[]}'); });
    await new Promise<void>((r) => elsewhere.listen(0, '127.0.0.1', r));
    const to = `http://127.0.0.1:${(elsewhere.address() as AddressInfo).port}/grab`;
    const redirector = createServer((req, res) => { res.writeHead(302, { location: to }); res.end(); });
    await new Promise<void>((r) => redirector.listen(0, '127.0.0.1', r));
    try {
      const { r, out } = await probe([{ key: 'a', configDir: oauthDir(), kind: 'oauth' }],
        { CLAYCLAUDE_MODELS_URL: `http://127.0.0.1:${(redirector.address() as AddressInfo).port}/v1/models` });
      expect(r.accounts[0]).toMatchObject({ ok: false, status: 302 });
      expect(seen).toEqual([]);
      expect(out).not.toContain(FAKE);
    } finally {
      await new Promise((r) => redirector.close(r)); await new Promise((r) => elsewhere.close(r));
    }
  });

  it('stops paging when the API repeats a cursor', async () => {
    const loop = createServer((req, res) => {
      calls.push({ url: req.url! });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: PAGE1, has_more: true, last_id: 'claude-sonnet-5-5' }));
    });
    await new Promise<void>((r) => loop.listen(0, '127.0.0.1', r));
    try {
      const { r } = await probe([{ key: 'a', configDir: oauthDir(), kind: 'oauth' }], { CLAYCLAUDE_MODELS_URL: `http://127.0.0.1:${(loop.address() as AddressInfo).port}/v1/models` });
      expect(r.accounts[0].ok).toBe(true);
      expect(r.accounts[0].models.map((m: any) => m.id)).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
      expect(calls.length).toBeLessThanOrEqual(2);
    } finally { loop.closeAllConnections(); await new Promise((r) => loop.close(r)); }
  });

  it('refuses a malformed request', async () => {
    await expect(execFileP(PYTHON, [PROBE, JSON.stringify({ mode: 'models', accounts: 'x' })])).rejects.toMatchObject({ code: 2 });
  });
});

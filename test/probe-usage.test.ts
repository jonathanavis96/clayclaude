import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, lstatSync, chmodSync, existsSync, renameSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE } from './helpers/probe.js';
import { startStub } from './helpers/stub-oauth.js';

const execFileP = promisify(execFile);

function acct(expiresAt: number | null) {
  const d = mkdtempSync(join(tmpdir(), 'cc-u-'));
  const creds = { claudeAiOauth: { accessToken: 'old', refreshToken: 'r1', expiresAt, scopes: ['x'] }, other: 1 };
  writeFileSync(join(d, '.credentials.json'), JSON.stringify(creds));
  chmodSync(join(d, '.credentials.json'), 0o600);
  writeFileSync(join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c' } }));
  return d;
}
async function run(stubUrl: string, accounts: object[], budgetMs?: number, env: Record<string, string> = {}) {
  const { stdout } = await execFileP('python3', [PROBE, JSON.stringify({ mode: 'usage', accounts, ...(budgetMs ? { budgetMs } : {}) })], {
    encoding: 'utf8', env: { ...process.env, CLAYCLAUDE_USAGE_URL: stubUrl + '/usage', CLAYCLAUDE_TOKEN_URL: stubUrl + '/token', ...env },
  });
  return JSON.parse(stdout);
}
const far = () => Date.now() + 3600_000;

describe('probe usage', () => {
  it('fetches usage with a valid token, no refresh, no write', async () => {
    const s = await startStub({ usageStatusForOld: 200, tokenStatus: 200 });
    const d = acct(far());
    const before = readFileSync(join(d, '.credentials.json'));
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0]).toMatchObject({ ok: true, email: 'a@b.c', five_hour: { utilization: 42 } });
    expect(readFileSync(join(d, '.credentials.json'))).toEqual(before);
    expect(s.calls.map((c) => c.path)).toEqual(['/usage']);
    await s.close();
  });

  it('refreshes proactively near expiry, keeps mode and other keys, writes .bak', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    await run(s.url, [{ configDir: d, refresh: true }]);
    const c = JSON.parse(readFileSync(join(d, '.credentials.json'), 'utf8'));
    expect(c.claudeAiOauth).toMatchObject({ accessToken: 'new', refreshToken: 'r2', scopes: ['x'] });
    expect(c.other).toBe(1);
    expect(c.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600_000);
    expect(statSync(join(d, '.credentials.json')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(d, '.credentials.json.bak'))).toBe(true);
    expect(s.calls[0].body).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'r1' });
    await s.close();
  });

  // Simulate a kill at the worst moment by making one step raise, then check what was left on disk.
  async function killedDuring(creds: string, patch: string) {
    const script = [
      'import os, sys', 'sys.path.insert(0, os.path.dirname(sys.argv[1]))', 'import probe',
      'def boom(*a, **k): raise SystemExit(9)', patch,
      'probe._write_creds(sys.argv[2], {"claudeAiOauth": {"accessToken": "new"}})',
    ].join('\n');
    await expect(execFileP('sh', ['-c', 'umask 022; exec python3 -c "$0" "$1" "$2"', script, PROBE, creds])).rejects.toMatchObject({ code: 9 });
  }

  it('never leaves the token temp file readable by others, even if killed mid-write', async () => {
    const creds = join(acct(far()), '.credentials.json');
    await killedDuring(creds, 'probe.json.dump = boom');
    expect(statSync(creds + '.tmp').mode & 0o777).toBe(0o600);
  });

  it('never leaves the backup readable by others, even if killed mid-copy', async () => {
    const creds = join(acct(far()), '.credentials.json');
    await killedDuring(creds, 'probe.shutil.copystat = boom; probe.shutil.copymode = boom; probe.os.replace = boom');
    expect(statSync(creds + '.bak').mode & 0o777).toBe(0o600);
  });

  it('replaces a stale, wider temp file instead of reusing its mode', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    const creds = join(d, '.credentials.json');
    writeFileSync(creds + '.tmp', 'stale'); chmodSync(creds + '.tmp', 0o644);
    await run(s.url, [{ configDir: d, refresh: true }]);
    expect(statSync(creds).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(creds, 'utf8')).claudeAiOauth.accessToken).toBe('new');
    await s.close();
  });

  it('refreshes once on 401', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(far());
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0].ok).toBe(true);
    expect(s.calls.map((c) => c.path)).toEqual(['/usage', '/token', '/usage']);
    await s.close();
  });

  it('leaves the file byte-identical when refresh fails', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 400 });
    const d = acct(Date.now() - 1000);
    const before = readFileSync(join(d, '.credentials.json'));
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0].ok).toBe(false);
    expect(readFileSync(join(d, '.credentials.json'))).toEqual(before);
    expect(JSON.stringify(r)).not.toContain('r1');
    await s.close();
  });

  it('never refreshes when refresh:false, even on a 401', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(far());
    const r = await run(s.url, [{ configDir: d, refresh: false }]);
    expect(r.accounts[0].ok).toBe(false);
    expect(s.calls.map((c) => c.path)).toEqual(['/usage']);
    await s.close();
  });

  it('a malformed .claude.json does not sink the other accounts on the host', async () => {
    const s = await startStub({ usageStatusForOld: 200, tokenStatus: 200 });
    const bad1 = acct(far()); writeFileSync(join(bad1, '.claude.json'), '[1, 2]');
    const bad2 = acct(far()); writeFileSync(join(bad2, '.claude.json'), JSON.stringify({ oauthAccount: 'x' }));
    const good = acct(far());
    const r = await run(s.url, [{ configDir: bad1, refresh: true }, { configDir: bad2, refresh: true }, { configDir: good, refresh: true }]);
    expect(r.accounts.map((a: any) => [a.ok, a.email])).toEqual([[true, null], [true, null], [true, 'a@b.c']]);
    await s.close();
  });

  it('reports a 429 with its status and Retry-After, and does not refresh', async () => {
    const s = await startStub({ usageStatusForOld: 429, tokenStatus: 200, usageErrorHeaders: { 'retry-after': '120' } });
    const d = acct(far());
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0]).toMatchObject({ ok: false, status: 429, retryAfterS: 120 });
    expect(s.calls.map((c) => c.path)).toEqual(['/usage']);
    await s.close();
  });

  it('refreshes at most once per poll (proactive refresh, then a 401 on the new token)', async () => {
    const s = await startStub({ usageStatusForOld: 401, usageStatusForNew: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0]).toMatchObject({ ok: false, status: 401 });
    expect(s.calls.filter((c) => c.path === '/token')).toHaveLength(1);
    await s.close();
  });

  it('honours expires_in when the token endpoint gives one', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200, tokenBody: { access_token: 'new', expires_in: 600 } });
    const d = acct(Date.now() + 60_000);
    await run(s.url, [{ configDir: d, refresh: true }]);
    const c = JSON.parse(readFileSync(join(d, '.credentials.json'), 'utf8')).claudeAiOauth;
    expect(c.expiresAt).toBeGreaterThan(Date.now() + 500_000);
    expect(c.expiresAt).toBeLessThan(Date.now() + 700_000);
    expect(c.refreshToken).toBe('r1'); // none returned: the old one is kept
    await s.close();
  });

  it('never echoes a token in an error, even one the HTTP library rejects', async () => {
    const s = await startStub({ usageStatusForOld: 200, tokenStatus: 200 });
    const d = acct(far());
    const p = join(d, '.credentials.json');
    writeFileSync(p, JSON.stringify({ claudeAiOauth: { accessToken: 'SECRETAT\nx', refreshToken: 'SECRETRT', expiresAt: far() } }));
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0].ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    await s.close();
  });

  it('two overlapping probes on one account refresh only once', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200, tokenDelayMs: 800 });
    const d = acct(Date.now() + 60_000);
    const [a, b] = await Promise.all([run(s.url, [{ configDir: d, refresh: true }]), run(s.url, [{ configDir: d, refresh: true }])]);
    expect([a.accounts[0].ok, b.accounts[0].ok]).toEqual([true, true]);
    expect(s.calls.filter((c) => c.path === '/token')).toHaveLength(1);
    await s.close();
  });

  it('keeps a field another writer added while the refresh was in flight', async () => {
    const d = acct(Date.now() + 60_000);
    const p = join(d, '.credentials.json');
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200, onToken: () => {
      const c = JSON.parse(readFileSync(p, 'utf8')); c.mcpOAuth = { x: 1 }; writeFileSync(p, JSON.stringify(c));
    } });
    await run(s.url, [{ configDir: d, refresh: true }]);
    const c = JSON.parse(readFileSync(p, 'utf8'));
    expect(c.claudeAiOauth.accessToken).toBe('new');
    expect(c.mcpOAuth).toEqual({ x: 1 });
    expect(c.other).toBe(1);
    await s.close();
  });

  it('does not call the API with a token it knows has expired when refresh is off', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() - 1000);
    const r = await run(s.url, [{ configDir: d, refresh: false }]);
    expect(r.accounts[0]).toMatchObject({ ok: false });
    expect(r.accounts[0].error).toMatch(/expired/);
    expect(s.calls).toEqual([]);
    await s.close();
  });

  it('never starts a refresh it may not finish inside the time budget', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    const before = readFileSync(join(d, '.credentials.json'));
    const r = await run(s.url, [{ configDir: d, refresh: true }], 1000);
    expect(r.accounts[0].ok).toBe(false);
    expect(s.calls.filter((c) => c.path === '/token')).toHaveLength(0);
    expect(readFileSync(join(d, '.credentials.json'))).toEqual(before);
    await s.close();
  });

  it('reads the email from $HOME only for the default ~/.claude', async () => {
    const s = await startStub({ usageStatusForOld: 200, tokenStatus: 200 });
    const home = mkdtempSync(join(tmpdir(), 'cc-home-'));
    writeFileSync(join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'home@x' } }));
    const def = join(home, '.claude'); mkdirSync(def);
    writeFileSync(join(def, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: far() } }));
    const other = join(home, 'proj', '.claude'); mkdirSync(other, { recursive: true });
    writeFileSync(join(home, 'proj', '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'proj@x' } }));
    writeFileSync(join(other, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'old', refreshToken: 'r', expiresAt: far() } }));
    const r = await run(s.url, [{ configDir: '~/.claude', refresh: false }, { configDir: other, refresh: false }], undefined, { HOME: home });
    expect(r.accounts.map((a: any) => a.email)).toEqual(['home@x', null]);
    await s.close();
  });

  it('reads the name and plan beside the email, and leaves them out when .claude.json does not have them', async () => {
    const s = await startStub({ usageStatusForOld: 200, tokenStatus: 200 });
    const d = acct(far());
    writeFileSync(join(d, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@b.c', displayName: 'Ann',
      organizationType: 'claude_max', organizationRateLimitTier: 'default_claude_max_20x', userRateLimitTier: null } }));
    const bare = acct(far());
    const r = await run(s.url, [{ configDir: d, refresh: false }, { configDir: bare, refresh: false }]);
    expect(r.accounts[0]).toMatchObject({ ok: true, email: 'a@b.c', name: 'Ann', plan: 'claude_max', planTier: 'default_claude_max_20x' });
    expect(r.accounts[1].email).toBe('a@b.c');
    expect(r.accounts[1]).not.toHaveProperty('name');
    expect(r.accounts[1]).not.toHaveProperty('plan');
    expect(r.accounts[1]).not.toHaveProperty('planTier');
    await s.close();
  });

  it('writes through a symlinked credentials file instead of replacing the link', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    const real = join(mkdtempSync(join(tmpdir(), 'cc-real-')), 'creds.json');
    renameSync(join(d, '.credentials.json'), real);
    symlinkSync(real, join(d, '.credentials.json'));
    const r = await run(s.url, [{ configDir: d, refresh: true }]);
    expect(r.accounts[0].ok).toBe(true);
    expect(lstatSync(join(d, '.credentials.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).claudeAiOauth.accessToken).toBe('new');
    await s.close();
  });

  it('does not refresh when it could not write the result (the rotated token would be lost)', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    const before = readFileSync(join(d, '.credentials.json'));
    chmodSync(d, 0o500);
    try {
      const r = await run(s.url, [{ configDir: d, refresh: true }]);
      expect(r.accounts[0].ok).toBe(false);
      expect(s.calls.filter((c) => c.path === '/token')).toHaveLength(0);
      expect(readFileSync(join(d, '.credentials.json'))).toEqual(before);
    } finally { chmodSync(d, 0o700); }
    await s.close();
  });

  it('identifies as Claude Code (the usage endpoint answers 429 to any other User-Agent)', async () => {
    const s = await startStub({ usageStatusForOld: 401, tokenStatus: 200 });
    const d = acct(Date.now() + 60_000);
    await run(s.url, [{ configDir: d, refresh: true }]);
    expect(s.calls.map((c) => c.path)).toEqual(['/token', '/usage']);
    for (const c of s.calls) expect(c.ua).toMatch(/^claude-code\//);
    await s.close();
  });
});


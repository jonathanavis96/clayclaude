// tools/live-daemon.sh restarts the real daemon, so it must refuse a config that would poll usage with OAuth refresh
// on: every account whose usage provider is oauth, including the default when an account has no `usage` key at all,
// must say `refresh: false`. The refusal comes before anything is stopped or started.
// Every run sets CLAYCLAUDE_NO_SYSTEMD or stubs systemctl: a substitute HOME does not select another systemd user
// manager, so a real `systemctl --user` call would stop the developer's own clayclaude.service.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const acct = (id: string, extra = '') => `  - {id: ${id}, label: ${id}, colour: "#fff", host: local, configDir: /c/${id}${extra}}\n`;
// Port 1: nothing listens there, so even a broken guard could not stop a process of anyone's.
const config = (accounts: string) => `port: 1\nhosts: [{id: local}]\naccounts:\n${accounts}`;

function run(cfgText: string) {
  const home = mkdtempSync(join(tmpdir(), 'cc-live-home-'));
  mkdirSync(join(home, '.config', 'clayclaude'), { recursive: true });
  writeFileSync(join(home, '.config', 'clayclaude', 'config.yaml'), cfgText);
  const wt = mkdtempSync(join(tmpdir(), 'cc-live-wt-'));
  mkdirSync(join(wt, 'dist'));
  writeFileSync(join(wt, 'dist', 'cli.js'), 'process.exit(0)\n');
  return spawnSync('bash', [join(ROOT, 'tools', 'live-daemon.sh'), wt, join(home, 'serve.log')],
    { encoding: 'utf8', env: { ...process.env, HOME: home, CLAYCLAUDE_NO_SYSTEMD: '1' }, timeout: 10_000 });
}

describe('live-daemon.sh refresh guard', () => {
  it('refuses an account with no usage key (the default is oauth with refresh on)', () => {
    const r = run(config(acct('a', ', usage: {provider: oauth, refresh: false}') + acct('b')));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refresh: false/);
    expect(r.stderr).toMatch(/\bb\b/);
  });

  it('refuses an oauth account written in block style without refresh: false', () => {
    const r = run(config('  - id: a\n    label: a\n    colour: "#fff"\n    host: local\n    configDir: /c/a\n    usage:\n      provider: oauth\n'));
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/refresh: false/);
  });

  it('refuses a config it cannot read as YAML', () => {
    const r = run('accounts: [unclosed\n');
    expect(r.status).toBe(1);
  });

  it('passes the guard check alone for refresh: false (either style) and non-oauth providers', () => {
    const ok = config(acct('a', ', usage: {provider: oauth, refresh: false}') + acct('h', ', usage: {provider: http, url: "http://x/u", key: k}')
      + acct('t', ', usage: {provider: token, tokenEnv: T}') + acct('n', ', usage: {provider: none}')
      + '  - id: b\n    label: b\n    colour: "#fff"\n    host: local\n    configDir: /c/b\n    usage:\n      provider: oauth\n      refresh: false\n');
    const f = join(mkdtempSync(join(tmpdir(), 'cc-live-cfg-')), 'config.yaml');
    writeFileSync(f, ok);
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'refresh-guard.mjs'), f], { encoding: 'utf8' });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});

describe('live-daemon.sh first start', () => {
  /** curl, ss and sleep replaced by stubs on PATH: no real port is touched, nothing waits, the fake daemon exits at once. */
  function stubs(): string {
    const bin = mkdtempSync(join(tmpdir(), 'cc-live-bin-'));
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub('curl', 'echo ok');
    stub('ss', 'exit 0');
    stub('sleep', 'exit 0');
    return bin;
  }

  it('prints nothing about a missing log when the log does not exist yet, and creates it', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-live-home-'));
    mkdirSync(join(home, '.config', 'clayclaude'), { recursive: true });
    writeFileSync(join(home, '.config', 'clayclaude', 'config.yaml'), config(acct('a', ', usage: {provider: none}')));
    const wt = mkdtempSync(join(tmpdir(), 'cc-live-wt-'));
    mkdirSync(join(wt, 'dist'));
    writeFileSync(join(wt, 'dist', 'cli.js'), 'process.exit(0)\n');
    const log = join(home, 'logs', 'nested', 'serve.log');
    const r = spawnSync('bash', [join(ROOT, 'tools', 'live-daemon.sh'), wt, log],
      { encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${stubs()}:${process.env.PATH}`, CLAYCLAUDE_NO_SYSTEMD: '1' }, timeout: 10_000 });
    expect(r.stderr).not.toMatch(/No such file/);
    expect(r.status).toBe(0);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, 'utf8')).toMatch(/^=== .* live-daemon: node /);
    expect(r.stdout).toMatch(/^=== .* live-daemon: node /m);
  });
});

describe('live-daemon.sh under systemd', () => {
  it('installs the unit, carries the environment the daemon reads, and restarts the unit', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-live-home-'));
    mkdirSync(join(home, '.config', 'clayclaude'), { recursive: true });
    writeFileSync(join(home, '.config', 'clayclaude', 'config.yaml'),
      config(acct('a', ', usage: {provider: none}') + acct('t', ', usage: {provider: token, tokenEnv: FOO_TOKEN}')));
    const wt = mkdtempSync(join(tmpdir(), 'cc-live-wt-'));
    mkdirSync(join(wt, 'dist'));
    writeFileSync(join(wt, 'dist', 'cli.js'), 'process.exit(0)\n');
    mkdirSync(join(wt, 'tools'));
    copyFileSync(join(ROOT, 'tools', 'clayclaude.service'), join(wt, 'tools', 'clayclaude.service'));
    // A stub systemctl records its calls; the real user manager is never reached.
    const bin = mkdtempSync(join(tmpdir(), 'cc-live-bin-'));
    const stub = (name: string, body: string) => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    stub('systemctl', `echo "$*" >> "${join(home, 'systemctl.log')}"`);
    stub('curl', 'echo ok');
    stub('ss', 'exit 0');
    stub('sleep', 'exit 0');
    const env: Record<string, string | undefined> = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`,
      FOO_TOKEN: 'a"b$c\\d', CLAYCLAUDE_CHROMIUM: '/x/chrome', WSL_DISTRO_NAME: 'Ubuntu', UNRELATED_SECRET: 'no' };
    delete env.CLAYCLAUDE_NO_SYSTEMD;
    const r = spawnSync('bash', [join(ROOT, 'tools', 'live-daemon.sh'), wt, join(home, 'ignored.log')], { encoding: 'utf8', env, timeout: 10_000 });
    expect(r.stderr).toMatch(/ignoring/);
    expect(r.status).toBe(0);

    const calls = readFileSync(join(home, 'systemctl.log'), 'utf8').trim().split('\n');
    expect(calls).toEqual(['--user show-environment', '--user stop clayclaude.service', '--user daemon-reload',
      '--user enable --quiet clayclaude.service', '--user start clayclaude.service']);
    expect(readFileSync(join(home, '.config', 'systemd', 'user', 'clayclaude.service'), 'utf8'))
      .toBe(readFileSync(join(ROOT, 'tools', 'clayclaude.service'), 'utf8'));

    const envFile = join(home, '.config', 'clayclaude', 'daemon.env');
    expect(statSync(envFile).mode & 0o777).toBe(0o600);
    const lines = readFileSync(envFile, 'utf8').split('\n');
    expect(lines).toContain(`CLAYCLAUDE_WT="${wt}"`);
    expect(lines).toContain('FOO_TOKEN="a\\"b\\$c\\\\d"');
    expect(lines).toContain('CLAYCLAUDE_CHROMIUM="/x/chrome"');
    expect(lines).toContain('WSL_DISTRO_NAME="Ubuntu"');
    expect(lines.some((l) => l.startsWith('PATH="'))).toBe(true);
    expect(lines.some((l) => l.startsWith('UNRELATED_SECRET='))).toBe(false);
    expect(existsSync(join(home, '.local', 'state', 'clayclaude', 'serve.log'))).toBe(true);
    expect(existsSync(join(home, 'ignored.log'))).toBe(false);
  });
});

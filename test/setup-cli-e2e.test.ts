import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../src/config.js';
import { detectPlatform } from '../src/actions/platform.js';

const root = fileURLToPath(new URL('..', import.meta.url));

/** mtime and size of every file setup could conceivably touch in the real home. Read-only. */
function realFootprint(): string {
  const home = userInfo().homedir;
  const out: string[] = [];
  let names: string[] = [];
  try { names = readdirSync(home).filter((n) => n.startsWith('.claude')); } catch { /* no home */ }
  for (const n of names) for (const f of ['settings.json', 'clayclaude/hook.py']) {
    const p = join(home, n, f);
    if (existsSync(p)) { const s = statSync(p); out.push(`${p} ${s.mtimeMs} ${s.size}`); }
  }
  const cfg = join(home, '.config', 'clayclaude');
  if (existsSync(cfg)) for (const f of readdirSync(cfg)) { const s = statSync(join(cfg, f)); out.push(`${f} ${s.mtimeMs} ${s.size}`); }
  return out.join('\n');
}

/** `clayclaude setup` as a real process: temp $HOME, the real local probe, answers piped on stdin. */
function runSetupCli(home: string, answers: string[]) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/cli.ts'), 'setup'], {
      cwd: root, env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let out = '';
    child.stdout.on('data', (b) => { out += b; });
    child.stderr.on('data', (b) => { out += b; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 40_000);
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
    child.stdin.end(answers.join('\n') + '\n');
  });
}

describe('clayclaude setup, end to end (temp HOME, scripted answers)', () => {
  it('discovers fake ~/.claude* dirs, shows the hooks diff, backs up before applying, writes a 0600 config the loader accepts', async () => {
    const before = realFootprint();
    const home = mkdtempSync(join(tmpdir(), 'cc-setup-e2e-'));
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeFileSync(join(home, '.claude', 'sessions', '1.json'), '{"pid":1}');
    const mainSettings = '{\n  "model": "opus"\n}\n';
    writeFileSync(join(home, '.claude', 'settings.json'), mainSettings);
    mkdirSync(join(home, '.claude-work', 'projects'), { recursive: true });
    writeFileSync(join(home, '.claude-work', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"FAKE"}}');
    const workSettings = '{"theme":"dark"}\n';
    writeFileSync(join(home, '.claude-work', 'settings.json'), workSettings);
    mkdirSync(join(home, '.claude-empty'));   // nothing Claude-like inside: not offered
    writeFileSync(join(home, '.claude.json'), '{"oauthAccount":{"emailAddress":"main@example.test"}}');

    const kind = detectPlatform().kind;
    const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
    const answers = [
      '',              // other ssh aliases: none (no ~/.ssh/config, so no list is shown)
      '', '',          // tmux session, repo roots: defaults
      // ~/.claude
      'y', '', '',     // add, label, colour
      '1', 'y',        // oauth; another tool refreshes it -> refresh: false
      '3',             // open: tmux only
      'y', 'y',        // install hooks; apply
      'n',             // status line bridge: not now
      // ~/.claude-work
      'y', 'Work', '#4fd1c5',
      '3',             // usage: none
      '2',             // open: app
      'y', 'n',        // offer hooks, then decline the diff
      '',              // status line bridge: the default is no
      'n',             // tablet: not now
      ...(kind === 'wsl' || kind === 'win32' ? ['n'] : []),   // hotkey
      'y', ...(ips.length ? ['none'] : []), 'board.example.test',   // LAN on, by name only
      'y',             // write
    ];
    const r = await runSetupCli(home, answers);
    expect(r.code, r.out).toBe(0);

    // discovery: both real-looking dirs, not the empty one
    expect(r.out).toContain('local: found 2 Claude config directories.');
    expect(r.out).toContain('Add .claude on local (main@example.test)');
    expect(r.out).not.toContain('.claude-empty');

    // hooks: the diff is shown before applying, and a backup holds the original
    expect(r.out).toContain(`Changes to ${join(home, '.claude', 'settings.json')}:`);
    expect(r.out).toMatch(/^\s+\+ .*"hooks"/m);
    expect(r.out.indexOf('Changes to')).toBeLessThan(r.out.indexOf('Backup:'));
    const backups = readdirSync(join(home, '.claude')).filter((f) => f.startsWith('settings.json.bak-clayclaude-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(home, '.claude', backups[0]), 'utf8')).toBe(mainSettings);
    const installed = JSON.parse(readFileSync(join(home, '.claude', 'settings.json'), 'utf8'));
    expect(installed.model).toBe('opus');
    expect(Object.keys(installed.hooks)).toEqual(['Notification', 'Stop', 'PreCompact', 'SessionStart', 'SessionEnd']);
    expect(existsSync(join(home, '.claude', 'clayclaude', 'hook.py'))).toBe(true);
    // declined: untouched, no backup, no hook script
    expect(readFileSync(join(home, '.claude-work', 'settings.json'), 'utf8')).toBe(workSettings);
    expect(readdirSync(join(home, '.claude-work')).some((f) => f.includes('.bak'))).toBe(false);

    // config: 0600, loads, carries the answers
    const cfgPath = join(home, '.config', 'clayclaude', 'config.yaml');
    expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    const cfg = parseConfig(readFileSync(cfgPath, 'utf8'), home);
    expect(cfg.accounts.map((a) => [a.id, a.configDir, a.usage, a.open.type])).toEqual([
      ['main', join(home, '.claude'), { provider: 'oauth', refresh: false }, 'tmux'],
      ['work', join(home, '.claude-work'), { provider: 'none' }, 'app'],
    ]);
    expect(cfg.lan.enabled).toBe(true);
    expect(cfg.lan.hosts).toEqual(['board.example.test']);
    expect(r.out).toContain(cfg.lan.token!);
    expect(readFileSync(cfgPath, 'utf8')).not.toContain('FAKE');

    // nothing in the real home moved
    expect(realFootprint()).toBe(before);
  }, 60_000);
});

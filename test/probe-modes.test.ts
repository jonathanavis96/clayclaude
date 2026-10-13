import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROBE, makeDir, runProbeSync, sleeper, writeJson } from './helpers/probe.js';

const kids: ReturnType<typeof sleeper>[] = [];
afterEach(() => { kids.splice(0).forEach((k) => k.kill()); });
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-modes-'));
const probeAs = (home: string, req: object) =>
  JSON.parse(execFileSync('python3', [PROBE, JSON.stringify(req)], { encoding: 'utf8', env: { ...process.env, HOME: home } }));

describe('snapshot only', () => {
  it('returns just the requested session', () => {
    const d = makeDir();
    const k = sleeper(); kids.push(k);
    for (const sid of ['one', 'two']) writeJson(join(d, 'sessions', `${sid}.json`), { pid: k.pid, sessionId: sid, cwd: '/x', startedAt: 1 });
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], only: 'two' });
    expect(r.dirs[0].registries.map((x: any) => x.data.sessionId)).toEqual(['two']);
  });
});

describe('probe repos', () => {
  it('lists git repos to depth 2, skips hidden and node_modules, orders by last use', () => {
    const home = tmp();
    const root = join(home, 'code');
    for (const p of ['alpha/.git', 'beta/.git', 'group/gamma/.git', 'node_modules/x/.git', '.hidden/.git', 'notrepo/src']) mkdirSync(join(root, p), { recursive: true });
    const cfgDir = join(home, '.claude');
    const slug = (p: string) => p.replace(/[^A-Za-z0-9]/g, '-');
    mkdirSync(join(cfgDir, 'projects', slug(join(root, 'beta'))), { recursive: true });
    const old = new Date(Date.now() - 86_400_000);
    mkdirSync(join(cfgDir, 'projects', slug(join(root, 'alpha'))), { recursive: true });
    utimesSync(join(cfgDir, 'projects', slug(join(root, 'alpha'))), old, old);
    const r = probeAs(home, { mode: 'repos', roots: ['~/code', '~/missing'], configDirs: ['~/.claude'] });
    expect(r.roots).toEqual([{ raw: '~/code', abs: root, exists: true }, { raw: '~/missing', abs: join(home, 'missing'), exists: false }]);
    expect(r.repos.map((x: any) => x.name)).toEqual(['beta', 'alpha', 'gamma']);
    expect(r.repos[2].lastUsedMs).toBe(0);
  });
});

describe('probe cli', () => {
  it('runs --help and --version of the given binary', () => {
    const d = tmp();
    const bin = join(d, 'fakeclaude');
    writeFileSync(bin, '#!/bin/sh\ncase "$1" in --version) echo "9.9.9 (Fake)";; --help) echo "Usage: fake"; echo "  --effort <level>  x (low, high)";; esac\n');
    chmodSync(bin, 0o755);
    const r = runProbeSync({ mode: 'cli', bin });
    expect(r).toMatchObject({ ok: true, version: '9.9.9 (Fake)' });
    expect(r.help).toContain('--effort');
  });
  it('rejects a binary name with shell characters and reports a missing binary', () => {
    expect(runProbeSync({ mode: 'cli', bin: 'x; id' }).ok).toBe(false);
    expect(runProbeSync({ mode: 'cli', bin: '/nonexistent/claude' }).ok).toBe(false);
  });
});

describe('probe discover', () => {
  it('finds .claude* directories that look used, and ignores others', () => {
    const home = tmp();
    mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
    writeJson(join(home, '.claude', 'sessions', '1.json'), { pid: 1 });
    mkdirSync(join(home, '.claude-work'));
    writeFileSync(join(home, '.claude-work', '.credentials.json'), '{}');
    writeJson(join(home, '.claude-work', '.claude.json'), { oauthAccount: { emailAddress: 'w@example.test' } });
    mkdirSync(join(home, '.claude-empty'));
    mkdirSync(join(home, '.claude-odd'));
    writeFileSync(join(home, '.claude-odd', '.credentials.json'), '{}');
    writeFileSync(join(home, '.claude-odd', '.claude.json'), '[1, 2]');   // valid JSON, not an object
    writeFileSync(join(home, '.claudeignore'), 'x');
    const r = probeAs(home, { mode: 'discover' });
    expect(r.home).toBe(home);
    expect(r.dirs.map((d: any) => d.name)).toEqual(['.claude', '.claude-odd', '.claude-work']);
    expect(r.dirs[2]).toMatchObject({ hasCredentials: true, email: 'w@example.test', sessionFiles: 0 });
    expect(r.dirs[1]).toMatchObject({ hasCredentials: true, email: null });
    expect(r.dirs[0].sessionFiles).toBe(1);
    expect(JSON.stringify(r)).not.toContain('accessToken');
  });
});

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyHooks, hookCommand, hookSource, lineDiff, localIO, planHooks, previewHooks, remoteIO } from '../src/hooks/install.js';
import { makeExec } from '../src/actions/exec.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cc-hooks-'));
// The exact text in use on real hosts: a re-run of setup must see it as installed, so it must not drift.
const CMD = (ev: string) => `python3 "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/clayclaude/hook.py" ${ev} 2>/dev/null || true`;
const OLD = (dir: string, ev: string) => `python3 "${dir}/clayclaude/hook.py" ${ev} 2>/dev/null || true`;
const EVENTS = ['Notification', 'Stop', 'PreCompact', 'SessionStart', 'SessionEnd'];
/** Run an installed hook command the way Claude Code does: through the shell, with the account's environment. */
const runCommand = (command: string, env: Record<string, string>, input: string) =>
  execFileSync('sh', ['-c', command], { input, encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } });
const ourCommands = (settings: any, ev: string): string[] =>
  (settings.hooks?.[ev] ?? []).flatMap((g: any) => g.hooks ?? []).map((h: any) => h.command).filter((c: string) => c.includes('/clayclaude/hook.py'));

describe('planHooks', () => {
  it('adds our hook to all five events and keeps everything else', () => {
    const before = { model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [] }] } };
    const { next, added } = planHooks(before);
    expect(added).toEqual(EVENTS);
    expect(next.model).toBe('opus');
    expect(next.hooks.PreToolUse).toEqual(before.hooks.PreToolUse);
    expect(next.hooks.Stop).toHaveLength(2);
    expect(next.hooks.Stop[0]).toEqual(before.hooks.Stop[0]);
    expect(next.hooks.Notification[0].hooks[0].command).toBe(CMD('Notification'));
    expect(hookCommand('Stop')).toBe(CMD('Stop'));
    expect(before.hooks.Stop).toHaveLength(1); // input not mutated
  });
  it('is idempotent', () => {
    const once = planHooks({}).next;
    expect(planHooks(once)).toEqual({ next: once, added: [], upgraded: [] });
  });
  it('rewrites the old absolute form to the account-relative one, once, keeping its place and every other hook', () => {
    const before = { hooks: Object.fromEntries(EVENTS.map((ev) => [ev, [
      { hooks: [{ type: 'command', command: 'notify-send hi' }, { type: 'command', command: OLD('/home/a/.claude-work', ev) }] }]])) };
    const { next, added, upgraded } = planHooks(before);
    expect(added).toEqual([]);
    expect(upgraded).toEqual(EVENTS);
    for (const ev of EVENTS) {
      expect(next.hooks[ev]).toEqual([{ hooks: [{ type: 'command', command: 'notify-send hi' }, { type: 'command', command: CMD(ev) }] }]);
    }
    expect(planHooks(next)).toEqual({ next, added: [], upgraded: [] });
  });
  it('leaves one entry per event when old forms from several accounts sit beside the new one', () => {
    const before = { hooks: { Stop: [
      { hooks: [{ type: 'command', command: OLD('/home/a/.claude', 'Stop') }] },
      { hooks: [{ type: 'command', command: CMD('Stop') }] },
      { matcher: '', hooks: [{ type: 'command', command: OLD('/home/a/.claude-two', 'Stop') }, { type: 'command', command: 'say done' }] }] } };
    const { next, upgraded } = planHooks(before);
    expect(upgraded).toContain('Stop');
    expect(ourCommands(next, 'Stop')).toEqual([CMD('Stop')]);
    expect(next.hooks.Stop).toEqual([{ hooks: [{ type: 'command', command: CMD('Stop') }] }, { matcher: '', hooks: [{ type: 'command', command: 'say done' }] }]);
  });
  it('counts a hand-written command that runs our hook as installed and leaves it alone', () => {
    const custom = '/usr/bin/python3 ~/.claude/clayclaude/hook.py Stop';
    const { next, added, upgraded } = planHooks({ hooks: { Stop: [{ hooks: [{ type: 'command', command: custom }] }] } });
    expect(added).not.toContain('Stop');
    expect(upgraded).toEqual([]);
    expect(ourCommands(next, 'Stop')).toEqual([custom]);
  });
  it('the installed command exits 0 even when hook.py is missing (exit 2 would block a Stop)', () => {
    const d = tmp(); // no clayclaude/hook.py here
    expect(runCommand(hookCommand('Stop'), { CLAUDE_CONFIG_DIR: d, HOME: d }, '{"session_id":"s"}')).toBe('');
  });
  it('refuses odd shapes', () => {
    expect(() => planHooks({ hooks: [] })).toThrow(/not an object/);
    expect(() => planHooks({ hooks: { Stop: {} } })).toThrow(/not a list/);
    expect(() => hookCommand('Stop; rm -rf ~')).toThrow();
  });
});

describe('lineDiff', () => {
  it('marks additions and removals', () => {
    expect(lineDiff('a\nb\nc', 'a\nx\nb\nc')).toBe('+ x');
    expect(lineDiff('a\nb', 'a')).toBe('- b');
  });
});

describe('applyHooks (temp directories only)', () => {
  it('writes the hook script, backs up the original settings byte for byte, and keeps the file mode', async () => {
    const d = tmp();
    const original = '{\n    "model": "opus",\n    "env": { "A": "1" }\n}\n';
    writeFileSync(join(d, 'settings.json'), original);
    chmodSync(join(d, 'settings.json'), 0o640);
    const r = await applyHooks(localIO(), d, Date.parse('2026-10-12T10:11:12Z'));
    expect(r.backup).toBe(join(d, 'settings.json.bak-clayclaude-20261012101112'));
    expect(readFileSync(r.backup!, 'utf8')).toBe(original);
    const next = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(next.model).toBe('opus');
    expect(next.env).toEqual({ A: '1' });
    expect(next.hooks.SessionEnd).toHaveLength(1);
    expect(statSync(join(d, 'settings.json')).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toMatch(/\n    "model"/); // kept the 4-space indent
    expect(existsSync(join(d, 'clayclaude', 'hook.py'))).toBe(true);
    expect((await applyHooks(localIO(), d)).added).toEqual([]);          // second run: no change, no new backup
    expect(readdirSync(d).filter((f) => f.includes('.bak-'))).toHaveLength(1);
  });
  it('writes through a symlinked settings.json and keeps the link (dotfiles setups)', async () => {
    const d = tmp();
    const real = join(d, 'dotfiles-settings.json');
    writeFileSync(real, '{"model":"opus"}\n');
    symlinkSync(real, join(d, 'settings.json'));
    await applyHooks(localIO(), d);
    expect(lstatSync(join(d, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(real, 'utf8')).hooks.Stop).toHaveLength(1);
  });
  it('restores a missing or outdated hook.py when the settings already have the hooks, without a new backup', async () => {
    const d = tmp();
    writeFileSync(join(d, 'settings.json'), '{}\n');
    await applyHooks(localIO(), d);
    const settings = readFileSync(join(d, 'settings.json'), 'utf8');
    rmSync(join(d, 'clayclaude', 'hook.py'));
    expect((await applyHooks(localIO(), d)).added).toEqual([]);
    expect(readFileSync(join(d, 'clayclaude', 'hook.py'), 'utf8')).toBe(hookSource());
    writeFileSync(join(d, 'clayclaude', 'hook.py'), '# old version\n');
    const r = await applyHooks(localIO(), d);
    expect(r).toEqual({ added: [], upgraded: [] });
    expect(readFileSync(join(d, 'clayclaude', 'hook.py'), 'utf8')).toBe(hookSource());
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(settings);
    expect(readdirSync(d).filter((f) => f.includes('.bak-'))).toHaveLength(1);
  });
  it('creates settings.json when there is none, with a private mode and no backup', async () => {
    const d = tmp();
    const r = await applyHooks(localIO(), d);
    expect(r.backup).toBeUndefined();
    expect(statSync(join(d, 'settings.json')).mode & 0o777).toBe(0o600);
  });
  it('refuses a settings.json that is not valid JSON and changes nothing', async () => {
    const d = tmp();
    writeFileSync(join(d, 'settings.json'), '{ "model": ');
    await expect(applyHooks(localIO(), d)).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe('{ "model": ');
    expect(existsSync(join(d, 'clayclaude'))).toBe(false);
  });
  it('one settings.json shared by two accounts through symlinks: one set of entries, each account logs to its own events.jsonl', async () => {
    const root = tmp();
    const shared = join(root, 'dotfiles', 'claude-settings.json');
    mkdirSync(join(root, 'dotfiles'));
    writeFileSync(shared, '{"model":"opus"}\n');
    const a = join(root, '.claude-a'), b = join(root, '.claude-b');
    for (const d of [a, b]) { mkdirSync(d); symlinkSync(shared, join(d, 'settings.json')); }
    const pa = await previewHooks(localIO(), a);
    expect(pa.changed).toBe(true);
    expect(pa.shared).toContain(shared);
    expect((await applyHooks(localIO(), a)).added).toEqual(EVENTS);
    const pb = await previewHooks(localIO(), b);
    expect(pb.changed).toBe(false);
    expect(pb.shared).toContain(shared);
    expect((await applyHooks(localIO(), b)).added).toEqual([]);
    for (const d of [a, b]) {
      expect(lstatSync(join(d, 'settings.json')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(d, 'clayclaude', 'hook.py'), 'utf8')).toBe(hookSource());
    }
    const settings = JSON.parse(readFileSync(shared, 'utf8'));
    for (const ev of EVENTS) expect(ourCommands(settings, ev)).toEqual([CMD(ev)]);
    const stop = ourCommands(settings, 'Stop')[0];
    runCommand(stop, { CLAUDE_CONFIG_DIR: a, HOME: root }, JSON.stringify({ session_id: 'sess-a' }));
    runCommand(stop, { CLAUDE_CONFIG_DIR: b, HOME: root }, JSON.stringify({ session_id: 'sess-b' }));
    const events = (d: string) => readFileSync(join(d, 'clayclaude', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).sessionId);
    expect(events(a)).toEqual(['sess-a']);
    expect(events(b)).toEqual(['sess-b']);
  });
  it('says so in the preview when settings.json is hard-linked, and nothing when it is a plain file', async () => {
    const root = tmp();
    mkdirSync(join(root, 'x'));
    writeFileSync(join(root, 'x', 'settings.json'), '{}\n');
    expect((await previewHooks(localIO(), join(root, 'x'))).shared).toBeUndefined();
    mkdirSync(join(root, 'y'));
    linkSync(join(root, 'x', 'settings.json'), join(root, 'y', 'settings.json'));
    expect((await previewHooks(localIO(), join(root, 'x'))).shared).toMatch(/2 names|hard link/);
  });
  it('upgrades an install in the old absolute form, with a backup, and a re-run changes nothing', async () => {
    const d = tmp();
    const old = { model: 'opus', hooks: Object.fromEntries(EVENTS.map((ev) => [ev, [{ hooks: [{ type: 'command', command: OLD('/somewhere/else/.claude', ev) }] }]])) };
    writeFileSync(join(d, 'settings.json'), JSON.stringify(old, null, 2) + '\n');
    const p = await previewHooks(localIO(), d);
    expect(p.changed).toBe(true);
    expect(p.added).toEqual([]);
    expect(p.upgraded).toEqual(EVENTS);
    expect(p.diff).toContain('${CLAUDE_CONFIG_DIR:-$HOME/.claude}');
    const r = await applyHooks(localIO(), d);
    expect(r.backup).toBeDefined();
    expect(r.upgraded).toEqual(EVENTS);
    const next = JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8'));
    expect(next.model).toBe('opus');
    for (const ev of EVENTS) expect(ourCommands(next, ev)).toEqual([CMD(ev)]);
    const text = readFileSync(join(d, 'settings.json'), 'utf8');
    expect(await applyHooks(localIO(), d)).toEqual({ added: [], upgraded: [] });
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(text);
    expect(readdirSync(d).filter((f) => f.includes('.bak-'))).toHaveLength(1);
  });
  it('the default ~/.claude works with CLAUDE_CONFIG_DIR unset', async () => {
    const home = tmp();
    const d = join(home, '.claude');
    mkdirSync(d);
    await applyHooks(localIO(), d);
    const stop = ourCommands(JSON.parse(readFileSync(join(d, 'settings.json'), 'utf8')), 'Stop')[0];
    expect(runCommand(stop, { HOME: home }, JSON.stringify({ session_id: 'sess-default' }))).toBe('');
    expect(JSON.parse(readFileSync(join(d, 'clayclaude', 'events.jsonl'), 'utf8').trim()).sessionId).toBe('sess-default');
  });
  it('previews with a diff before anything is written', async () => {
    const d = tmp();
    writeFileSync(join(d, 'settings.json'), '{}\n');
    const p = await previewHooks(localIO(), d);
    expect(p.changed).toBe(true);
    expect(p.diff).toContain('+ ');
    expect(p.diff).toContain('hook.py');
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe('{}\n');
  });
  it('works on a "remote" host through ssh quoting', async () => {
    const remoteHome = tmp();
    const dir = join(remoteHome, '.claude-work dir');
    mkdirSync(dir);
    writeFileSync(join(dir, 'real settings.json'), '{"theme":"dark"}');
    symlinkSync(join(dir, 'real settings.json'), join(dir, 'settings.json'));
    const f = makeFakeSsh(remoteHome);
    const host = { id: 'box', ssh: 'box', tmuxSession: 's', repoRoots: [], claudeBin: 'claude' };
    expect((await previewHooks(remoteIO(host, makeExec({ sshBin: f.bin })), dir)).shared).toContain(join(dir, 'real settings.json'));
    const r = await applyHooks(remoteIO(host, makeExec({ sshBin: f.bin })), dir);
    expect(r.added).toHaveLength(5);
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, 'real settings.json'), 'utf8')).theme).toBe('dark');
    expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks.Stop).toHaveLength(1);
    expect(readFileSync(join(dir, 'clayclaude', 'hook.py'), 'utf8')).toContain('never prints');
    expect(readdirSync(dir).some((n) => n.startsWith('settings.json.bak-clayclaude-'))).toBe(true);
  });
});

describe('hook script', () => {
  const run = (dir: string, args: string[], input: string) =>
    execFileSync('python3', [join(dir, 'clayclaude', 'hook.py'), ...args], { input, encoding: 'utf8' });
  async function installed() { const d = tmp(); await applyHooks(localIO(), d); return d; }

  it('appends one JSON line per event, in the shape the collector reads', async () => {
    const d = await installed();
    expect(run(d, ['Notification'], JSON.stringify({ session_id: 's1', hook_event_name: 'Notification', message: 'Claude needs your permission to use Bash' }))).toBe('');
    run(d, ['Stop'], JSON.stringify({ session_id: 's1' }));
    const lines = readFileSync(join(d, 'clayclaude', 'events.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ event: 'Notification', sessionId: 's1', message: 'Claude needs your permission to use Bash' });
    expect(typeof lines[0].ts).toBe('number');
    expect(lines[0].ts).toBeGreaterThan(1.7e12);
    expect(lines[1]).toMatchObject({ event: 'Stop', sessionId: 's1' });
    expect(lines[1].message).toBeUndefined();
  });
  // The events carry session ids and notification text; ~/.claude is often 0755, so the file must not be world-readable.
  it('keeps the events file private, also after rotating it', async () => {
    const d = await installed();
    const ev = join(d, 'clayclaude', 'events.jsonl');
    execFileSync('sh', ['-c', 'umask 022; exec python3 "$1" Stop', '_', join(d, 'clayclaude', 'hook.py')], { input: JSON.stringify({ session_id: 's' }) });
    expect(statSync(ev).mode & 0o777).toBe(0o600);
    writeFileSync(ev, 'x'.repeat(1_100_000) + '\n', { mode: 0o600 });
    execFileSync('sh', ['-c', 'umask 022; exec python3 "$1" Stop', '_', join(d, 'clayclaude', 'hook.py')], { input: JSON.stringify({ session_id: 's' }) });
    expect(statSync(ev).size).toBeLessThan(300_000);
    expect(statSync(ev).mode & 0o777).toBe(0o600);
  });
  it('never fails or prints, whatever it is fed', async () => {
    const d = await installed();
    for (const input of ['', 'not json', '[]', '{"session_id": 5}', '{}']) expect(run(d, ['Stop'], input)).toBe('');
    expect(existsSync(join(d, 'clayclaude', 'events.jsonl'))).toBe(false);
  });
  it('keeps the events file from growing without bound', async () => {
    const d = await installed();
    const big = Array.from({ length: 26000 }, (_, i) => JSON.stringify({ event: 'Stop', sessionId: 's', ts: i })).join('\n') + '\n';
    writeFileSync(join(d, 'clayclaude', 'events.jsonl'), big);
    run(d, ['Stop'], JSON.stringify({ session_id: 's' }));
    expect(statSync(join(d, 'clayclaude', 'events.jsonl')).size).toBeLessThan(300_000);
    const last = readFileSync(join(d, 'clayclaude', 'events.jsonl'), 'utf8').trim().split('\n').pop()!;
    expect(JSON.parse(last).sessionId).toBe('s');
  });
});

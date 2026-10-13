import { describe, it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookSource, localIO } from '../src/hooks/install.js';
import { applyStatusLine, bridgeCommand, parseBridge, planStatusLine, previewStatusLine } from '../src/hooks/statusline.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'cc-statusline-'));
const SH = execFileSync('which', ['sh'], { encoding: 'utf8' }).trim();

/** An account directory with hook.py in place, as setup leaves it. */
function account(settings?: object | string) {
  const d = tmp();
  mkdirSync(join(d, 'clayclaude'));
  writeFileSync(join(d, 'clayclaude', 'hook.py'), hookSource());
  if (settings !== undefined) writeFileSync(join(d, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings, null, 2) + '\n');
  return d;
}

/** Run a status line command the way Claude Code does: through the shell, with the account's environment and the JSON on stdin. */
function runLine(command: string, dir: string, input: string, path = process.env.PATH ?? '/usr/bin:/bin') {
  const r = spawnSync(SH, ['-c', command], { input, env: { PATH: path, HOME: dir, CLAUDE_CONFIG_DIR: dir } });
  return { out: r.stdout, err: r.stderr.toString('utf8'), code: r.status };
}

const statusInput = (o: { sid?: string; size?: number; used?: number | null; total?: number; model?: string } = {}) => JSON.stringify({
  session_id: o.sid ?? 'sess-1', transcript_path: '/x/t.jsonl', cwd: '/x', session_name: 'secret name',
  model: { id: o.model ?? 'claude-opus-5-5[1m]', display_name: 'Opus' }, workspace: { current_dir: '/x' },
  cost: { total_cost_usd: 1.23 },
  context_window: { total_input_tokens: o.total ?? 226_000, total_output_tokens: 900, context_window_size: o.size ?? 1_000_000,
    current_usage: { input_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 225_999, output_tokens: 900 },
    used_percentage: o.used === undefined ? 23 : o.used, remaining_percentage: 77 },
});
const record = (dir: string, sid = 'sess-1') => JSON.parse(readFileSync(join(dir, 'clayclaude', 'context', `${sid}.json`), 'utf8'));

// Commands a person might really have as their status line: quotes of both kinds, $, backslashes, newlines, a comment.
const TRICKY = [
  'bash ~/.claude/statusline.sh',
  `printf '%s' "$(jq -r '.model.display_name')"`,
  `echo 'it'"'"'s' \\ $HOME # comment`,
  'line1\nline2',
  `''`,
  '',
];

describe('bridgeCommand / parseBridge', () => {
  it('round-trips any previous command exactly', () => {
    for (const prev of TRICKY) expect(parseBridge(bridgeCommand(prev)), JSON.stringify(prev)).toEqual({ prev });
    expect(parseBridge(bridgeCommand())).toEqual({ prev: null });
  });
  it('does not take a command that merely mentions the hook for one it can restore', () => {
    expect(parseBridge('bash ~/.claude/statusline.sh')).toBeNull();
    expect(parseBridge(bridgeCommand('x').replace('printf', 'printf  '))).toBeNull();
  });
});

describe('planStatusLine', () => {
  it('wraps an existing status line, keeping its other keys and their order', () => {
    const before = { model: 'opus', statusLine: { type: 'command', command: 'bash ~/sl.sh', padding: 2 }, hooks: { Stop: [] } };
    const { next, changed, previous } = planStatusLine(before, 'install');
    expect(changed).toBe(true);
    expect(previous).toBe('bash ~/sl.sh');
    expect(Object.keys(next.statusLine)).toEqual(['type', 'command', 'padding']);
    expect(next.statusLine.padding).toBe(2);
    expect(parseBridge(next.statusLine.command)).toEqual({ prev: 'bash ~/sl.sh' });
    expect(next.model).toBe('opus');
    expect(next.hooks).toEqual({ Stop: [] });
    expect(before.statusLine.command).toBe('bash ~/sl.sh'); // input not mutated
  });
  it('adds a bridge that prints nothing when there is no status line', () => {
    const { next, previous } = planStatusLine({}, 'install');
    expect(previous).toBeNull();
    expect(next.statusLine).toEqual({ type: 'command', command: bridgeCommand(), padding: 0 });
  });
  it('never wraps the wrapper', () => {
    const once = planStatusLine({ statusLine: { type: 'command', command: 'x' } }, 'install').next;
    expect(planStatusLine(once, 'install')).toMatchObject({ next: once, changed: false, previous: 'x' });
  });
  it('removing restores the previous command exactly, or drops a status line it added', () => {
    for (const prev of TRICKY) {
      const before = { statusLine: { type: 'command', command: prev, padding: 0 } };
      const wrapped = planStatusLine(before, 'install').next;
      expect(planStatusLine(wrapped, 'remove')).toMatchObject({ next: before, changed: true, previous: prev });
    }
    const added = planStatusLine({ theme: 'dark' }, 'install').next;
    expect(planStatusLine(added, 'remove').next).toEqual({ theme: 'dark' });
    expect(planStatusLine({ theme: 'dark' }, 'remove')).toMatchObject({ changed: false });
  });
  it('refuses shapes it cannot safely change', () => {
    expect(() => planStatusLine({ statusLine: 'echo hi' }, 'install')).toThrow(/not an object/);
    expect(() => planStatusLine({ statusLine: { type: 'command' } }, 'install')).toThrow(/command/);
    expect(() => planStatusLine({ statusLine: { type: 'other', command: 'x' } }, 'install')).toThrow(/command/);
    const edited = { statusLine: { type: 'command', command: bridgeCommand('x') + ' | tr a b' } };
    expect(planStatusLine(edited, 'install')).toMatchObject({ changed: false, handEdited: true });
    expect(() => planStatusLine(edited, 'remove')).toThrow(/by hand/);
  });
});

describe('applyStatusLine (temp directories only)', () => {
  it('backs up settings.json byte for byte, keeps its mode, writes hook.py; removing restores the original text', async () => {
    const d = tmp();
    const original = '{\n    "model": "opus",\n    "statusLine": {\n        "type": "command",\n        "command": "bash ~/sl.sh"\n    }\n}\n';
    writeFileSync(join(d, 'settings.json'), original);
    chmodSync(join(d, 'settings.json'), 0o640);
    const io = localIO();
    const p = await previewStatusLine(io, d, 'install');
    expect(p).toMatchObject({ changed: true, installed: false, previous: 'bash ~/sl.sh' });
    expect(p.diff).toMatch(/^\+ .*statusline/m);
    expect(existsSync(join(d, 'settings.json.bak-clayclaude-20261012101112'))).toBe(false); // preview writes nothing
    const r = await applyStatusLine(io, d, 'install', Date.parse('2026-10-12T10:11:12Z'));
    expect(r.backup).toBe(join(d, 'settings.json.bak-clayclaude-20261012101112'));
    expect(readFileSync(r.backup!, 'utf8')).toBe(original);
    expect(statSync(join(d, 'settings.json')).mode & 0o777).toBe(0o640);
    expect(readFileSync(join(d, 'clayclaude', 'hook.py'), 'utf8')).toBe(hookSource());
    expect((await previewStatusLine(io, d, 'install'))).toMatchObject({ changed: false, installed: true, previous: 'bash ~/sl.sh' });
    expect(await applyStatusLine(io, d, 'install', Date.parse('2026-10-12T10:11:13Z'))).toEqual({ changed: false });
    await applyStatusLine(io, d, 'remove', Date.parse('2026-10-12T10:11:14Z'));
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe(original);
  });
  it('writes through a symlinked settings.json and keeps the link', async () => {
    const d = tmp(), dots = tmp();
    writeFileSync(join(dots, 'settings.json'), '{"theme":"dark"}\n');
    symlinkSync(join(dots, 'settings.json'), join(d, 'settings.json'));
    await applyStatusLine(localIO(), d, 'install');
    expect(lstatSync(join(d, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(join(dots, 'settings.json'), 'utf8')).statusLine.command).toBe(bridgeCommand());
  });
  it('refuses a settings.json that is not valid JSON and changes nothing', async () => {
    const d = tmp();
    writeFileSync(join(d, 'settings.json'), '{"statusLine": ');
    await expect(applyStatusLine(localIO(), d, 'install')).rejects.toThrow(/not valid JSON/);
    expect(readFileSync(join(d, 'settings.json'), 'utf8')).toBe('{"statusLine": ');
    expect(readdirSync(d)).toEqual(['settings.json']);
  });
});

describe('status line bridge, as Claude Code runs it', () => {
  it('records the context window for the session and prints the previous status line unchanged', () => {
    const d = account();
    const prev = `cat >"${join(d, 'seen')}"; printf '\\033[2m%s\\033[0m' "$(sed -n 's/.*"display_name":"\\([^"]*\\)".*/\\1/p' "${join(d, 'seen')}")"`;
    const input = statusInput();
    const r = runLine(bridgeCommand(prev), d, input);
    expect(r.code).toBe(0);
    expect(r.out.toString('utf8')).toBe('\x1b[2mOpus\x1b[0m');
    expect(readFileSync(join(d, 'seen'), 'utf8')).toBe(input); // the same stdin, byte for byte
    const rec = record(d);
    expect(Object.keys(rec)).toEqual(['sessionId', 'ts', 'contextWindowSize', 'usedPercentage', 'totalInputTokens', 'model']);
    expect(rec).toMatchObject({ sessionId: 'sess-1', contextWindowSize: 1_000_000, usedPercentage: 23, totalInputTokens: 226_000, model: 'claude-opus-5-5[1m]' });
    expect(Math.abs(rec.ts - Date.now())).toBeLessThan(60_000);
    expect(JSON.stringify(rec)).not.toContain('secret name');
    expect(statSync(join(d, 'clayclaude', 'context', 'sess-1.json')).mode & 0o777).toBe(0o600);
  });
  it('keeps trailing newlines of the input and of the previous output', () => {
    const d = account();
    const r = runLine(bridgeCommand('cat; printf "\\n\\n"'), d, statusInput() + '\n\n');
    expect(r.out.toString('utf8')).toBe(statusInput() + '\n\n\n\n');
  });
  it('a recorder that hangs gives up after 2 seconds, so the status line is never held up for long', async () => {
    const d = account();
    const t = Date.now();
    // stdin left open: the recorder blocks reading it, as it would on a hung disk
    const child = spawn('python3', [join(d, 'clayclaude', 'hook.py'), 'statusline'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const code = await new Promise<number | null>((res) => child.on('exit', (c, sig) => res(c ?? (sig ? -1 : null))));
    const took = Date.now() - t;
    child.stdin.destroy();
    expect(code).not.toBe(0);
    expect(took).toBeGreaterThan(1500);
    expect(took).toBeLessThan(4000);
  }, 10_000);

  it('rewrites the record only when the values change', () => {
    const d = account();
    const path = join(d, 'clayclaude', 'context', 'sess-1.json');
    runLine(bridgeCommand(), d, statusInput());
    const first = readFileSync(path, 'utf8');
    const old = new Date(Date.now() - 3600_000);
    utimesSync(path, old, old);
    runLine(bridgeCommand(), d, statusInput());
    expect(readFileSync(path, 'utf8')).toBe(first);
    expect(Math.round(statSync(path).mtimeMs)).toBe(old.getTime());
    runLine(bridgeCommand(), d, statusInput({ total: 300_000, used: 30 }));
    expect(record(d)).toMatchObject({ totalInputTokens: 300_000, usedPercentage: 30 });
    expect(readdirSync(join(d, 'clayclaude', 'context'))).toEqual(['sess-1.json']); // no temp files left
  });
  it('with no previous status line prints nothing and still records', () => {
    const d = account();
    const r = runLine(bridgeCommand(), d, statusInput());
    expect(r.out.length).toBe(0);
    expect(r.code).toBe(0);
    expect(record(d).contextWindowSize).toBe(1_000_000);
  });
  it('fails safe: whatever breaks in the recording step, the previous status line still prints', () => {
    const prev = 'printf "ok:%s" "$(head -c 13)"';
    const want = 'ok:' + statusInput().slice(0, 13);
    // the context directory cannot be created (a file is in its place)
    const a = account();
    writeFileSync(join(a, 'clayclaude', 'context'), 'not a dir');
    expect(runLine(bridgeCommand(prev), a, statusInput()).out.toString()).toBe(want);
    // hook.py is missing (another account sharing this settings.json, never set up)
    const b = tmp();
    expect(runLine(bridgeCommand(prev), b, statusInput()).out.toString()).toBe(want);
    // python3 is not installed at all: a PATH with only cat and head on it
    const bin = tmp();
    for (const t of ['cat', 'head']) symlinkSync(execFileSync('which', [t], { encoding: 'utf8' }).trim(), join(bin, t));
    const c = account();
    const r = runLine(bridgeCommand(prev), c, statusInput(), bin);
    expect(r.out.toString()).toBe(want);
    expect(r.err).toBe('');
    // garbage, an odd session id, or a missing window: no record, output unchanged
    for (const input of ['not json', '[]', JSON.stringify({ session_id: '../../escape', context_window: { context_window_size: 1 } }), JSON.stringify({ session_id: 's' })]) {
      const e = account();
      const out = runLine(bridgeCommand('printf fine'), e, input);
      expect(out.out.toString(), input).toBe('fine');
      expect(existsSync(join(e, 'clayclaude', 'context')) ? readdirSync(join(e, 'clayclaude', 'context')) : [], input).toEqual([]);
    }
  });
  it('passes on the previous command\'s exit status', () => {
    const d = account();
    expect(runLine(bridgeCommand('printf x; exit 3'), d, statusInput())).toMatchObject({ code: 3 });
  });
  it('keeps old records bounded: a new session prunes records untouched for over a week', () => {
    const d = account();
    runLine(bridgeCommand(), d, statusInput({ sid: 'old' }));
    runLine(bridgeCommand(), d, statusInput({ sid: 'recent' }));
    const ctx = join(d, 'clayclaude', 'context');
    const weekAgo = new Date(Date.now() - 8 * 86400_000);
    utimesSync(join(ctx, 'old.json'), weekAgo, weekAgo);
    runLine(bridgeCommand(), d, statusInput({ sid: 'new' }));
    expect(readdirSync(ctx).sort()).toEqual(['new.json', 'recent.json']);
  });
  it('adds little time to the status line', () => {
    const d = account();
    const prev = 'cat >/dev/null; printf hi';
    const time = (cmd: string) => {
      const ms: number[] = [];
      for (let i = 0; i < 9; i++) {
        const t0 = process.hrtime.bigint();
        runLine(cmd, d, statusInput({ total: 1000 + i }));
        ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      return ms.sort((x, y) => x - y)[4];
    };
    const overhead = time(bridgeCommand(prev)) - time(prev);
    // The target is under ~60 ms on an idle machine; the bound here leaves room for a loaded test run.
    expect(overhead).toBeLessThan(250);
  });
});


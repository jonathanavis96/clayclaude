import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, appendFileSync, mkdirSync, symlinkSync, readFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join } from 'node:path';
import { runProbeSync, makeDir, procStart, sleeper, writeJson, PROBE, PYTHON } from './helpers/probe.js';

const kids: ReturnType<typeof sleeper>[] = [];
afterEach(() => { kids.splice(0).forEach((k) => k.kill()); });

function live() { const k = sleeper(); kids.push(k); return k.pid!; }

describe('probe snapshot', () => {
  it('marks a running pid with matching procStart live, and a mismatched one dead', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'a', cwd: '/x', startedAt: 1, procStart: procStart(pid) });
    writeJson(join(d, 'sessions', '2.json'), { pid, sessionId: 'b', cwd: '/x', startedAt: 1, procStart: 1 }); // recycled pid
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    const byId = Object.fromEntries(r.dirs[0].registries.map((x: any) => [x.data.sessionId, x.live]));
    expect(byId).toEqual({ a: true, b: false });
  });

  it('survives a process whose 15-byte comm splits a UTF-8 character', () => {
    const d = makeDir();
    // The kernel truncates comm to 15 bytes, so 14 ASCII bytes + 'é' leaves half of the 'é' in /proc/<pid>/stat.
    const exe = join(d, `${'a'.repeat(14)}é`);
    symlinkSync(execFileSync('which', ['sleep'], { encoding: 'utf8' }).trim(), exe);
    const k = spawn(exe, ['30'], { stdio: 'ignore' }); kids.push(k);
    const pid = k.pid!;
    expect(readFileSync(`/proc/${pid}/stat`).includes(Buffer.from([0xc3, 0x29]))).toBe(true); // comm really is split
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'u1', cwd: '/x', startedAt: 1, procStart: procStart(pid) });
    writeJson(join(d, 'sessions', '2.json'), { pid, sessionId: 'u2', cwd: '/x', startedAt: 1, procStart: 1 });
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    const byId = Object.fromEntries(r.dirs[0].registries.map((x: any) => [x.data.sessionId, x.live]));
    expect(byId).toEqual({ u1: true, u2: false });
  });

  it('treats a pid hidden from /proc (hidepid, or exited mid-check) as dead when /proc exists', () => {
    // A recycled pid owned by another user: kill(pid, 0) says EPERM and hidepid=2 hides /proc/<pid>.
    const py = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
real_open = open
def hidden(path, *a, **k):
    if str(path).startswith("/proc/") and not str(path).startswith("/proc/self"):
        raise FileNotFoundError(path)
    return real_open(path, *a, **k)
probe.open = hidden
print(json.dumps([probe.pid_live(1, 12345), probe.pid_live(os.getpid(), 12345)]))
`;
    expect(JSON.parse(execFileSync(PYTHON, ['-c', py, PROBE], { encoding: 'utf8' }))).toEqual([false, false]);
  });

  it('never treats pid 0 or a negative pid as live', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', 'z.json'), { pid: 0, sessionId: 'z', cwd: '/x', startedAt: 1 });
    writeJson(join(d, 'sessions', 'n.json'), { pid: -1, sessionId: 'n', cwd: '/x', startedAt: 1 });
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].registries.map((x: any) => x.live)).toEqual([false, false]);
  });

  it('omits a transcript the caller already has, by size and mtime signature', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'k1', cwd: '/x', startedAt: 1 });
    const t = join(d, 'projects', '-x', 'k1.jsonl');
    writeFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'one' }] } }) + '\n');
    const first = runProbeSync({ mode: 'snapshot', dirs: [d] }).dirs[0].registries[0];
    expect(first.transcript).toHaveLength(1);
    expect(typeof first.tsig).toBe('string');
    const known = { [d]: { k1: first.tsig } };
    const same = runProbeSync({ mode: 'snapshot', dirs: [d], known }).dirs[0].registries[0];
    expect(same).toMatchObject({ same: true, tsig: first.tsig, transcript: [] });
    appendFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'two' }] } }) + '\n');
    const grown = runProbeSync({ mode: 'snapshot', dirs: [d], known }).dirs[0].registries[0];
    expect(grown.same).toBeUndefined();
    expect(grown.transcript).toHaveLength(2);
    expect(grown.tsig).not.toBe(first.tsig);
  });

  it('returns data:null for a half-written registry file', () => {
    const d = makeDir();
    writeFileSync(join(d, 'sessions', '5.json'), '{"pid": 5, "sess');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].registries[0].data).toBeNull();
  });

  it('tails the transcript, drops a partial last line, filters types and clips', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 's1', cwd: '/x', startedAt: 1 });
    const t = join(d, 'projects', '-x', 's1.jsonl');
    const big = 'x'.repeat(1_000_000);
    writeFileSync(t, [
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: big }] }, toolUseResult: big }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }),
    ].join('\n') + '\n' + '{"type":"assis');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], clip: 100, tailBytes: 4_000_000 });
    const lines = r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l));
    expect(lines.map((l: any) => l.type)).toEqual(['user', 'assistant']);
    expect(lines[0].toolUseResult).toBeUndefined();
    expect(lines[0].message.content[0].content.length).toBe(100);
  });

  it('clips string message content and top-level string content', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 's3', cwd: '/x', startedAt: 1 });
    const big = 'z'.repeat(200_000);
    writeFileSync(join(d, 'projects', '-x', 's3.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: big } }),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: big }),
    ].join('\n') + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], clip: 100, tailBytes: 4_000_000 });
    const lines = r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l));
    expect(lines[0].message.content.length).toBe(100);
    expect(lines[1].content.length).toBe(100);
  });

  it('drops image data and wireToolInputs, and clips any other long string', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 's5', cwd: '/x', startedAt: 1 });
    const big = 'b'.repeat(200_000);
    writeFileSync(join(d, 'projects', '-x', 's5.jsonl'), [
      JSON.stringify({ type: 'user', message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
        { type: 'document', source: { type: 'base64', data: big } },
      ] } }),
      JSON.stringify({ type: 'assistant', wireToolInputs: { toolu_1: { script: big } }, extra: { deep: [big] },
        message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { content: big } }] } }),
    ].join('\n') + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], clip: 100, tailBytes: 4_000_000 });
    const raw: string[] = r.dirs[0].registries[0].transcript;
    for (const l of raw) expect(l.length).toBeLessThan(1000);
    const lines = raw.map((l) => JSON.parse(l));
    expect(lines[0].message.content[0].type).toBe('image');
    expect(lines[0].message.content[0].source.data).toBeUndefined();
    expect(lines[0].message.content[0].source.media_type).toBe('image/png');
    expect(lines[1].wireToolInputs).toBeUndefined();
    expect(lines[1].extra.deep[0].length).toBe(100);
    expect(lines[1].message.content[0].input.content.length).toBe(100);
  });

  it('skips transcript lines that are valid JSON but not objects', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 's4', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 's4.jsonl'), ['5', 'null', '"str"', '[1]',
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } })].join('\n') + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l).type)).toEqual(['assistant']);
  });

  it('drops a line cut off by the tail window instead of misparsing it', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 's2', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 's2.jsonl'),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'text', text: 'y'.repeat(500_000) }] } }) + '\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l).type)).toEqual(['assistant']);
  });

  it('returns event lines', () => {
    const d = makeDir();
    mkdirSync(join(d, 'clayclaude'));
    appendFileSync(join(d, 'clayclaude', 'events.jsonl'), '{"event":"Notification","sessionId":"s","ts":1}\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].events).toEqual(['{"event":"Notification","sessionId":"s","ts":1}']);
  });

  it('copes with a missing dir', () => {
    const r = runProbeSync({ mode: 'snapshot', dirs: ['/nonexistent/x'] });
    expect(r.dirs[0]).toEqual({ configDir: '/nonexistent/x', registries: [], events: [] });
  });
});

describe('probe snapshot edge cases', () => {
  it('keeps the first line when the tail window starts exactly on a line boundary', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'b1', cwd: '/x', startedAt: 1 });
    const a = JSON.stringify({ type: 'user', message: { content: 'first' } }) + '\n';
    const b = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'second' }] } }) + '\n';
    writeFileSync(join(d, 'projects', '-x', 'b1.jsonl'), a + b);
    const r = runProbeSync({ mode: 'snapshot', dirs: [d], tailBytes: Buffer.byteLength(b) });
    expect(r.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l).type)).toEqual(['assistant']);
    const r2 = runProbeSync({ mode: 'snapshot', dirs: [d], tailBytes: Buffer.byteLength(b) + 1 }); // starts mid-line: that line is dropped
    expect(r2.dirs[0].registries[0].transcript.map((l: string) => JSON.parse(l).type)).toEqual(['assistant']);
  });

  it('exits 2 for a request that is valid JSON but not an object', () => {
    for (const bad of ['5', '[]', 'null', '{"mode":"snapshot","dirs":"~/.claude"}']) {
      let status: number | null = null;
      try { execFileSync(PYTHON, [PROBE, bad], { stdio: 'pipe' }); } catch (e: any) { status = e.status; }
      expect(status, bad).toBe(2);
    }
  });

  it('never emits NaN or Infinity, which would make the whole host unparseable', () => {
    const d = makeDir();
    writeFileSync(join(d, 'sessions', '7.json'), '{"pid": 7, "sessionId": "n1", "cwd": "/x", "startedAt": NaN}');
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'n2', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 'n2.jsonl'), '{"type":"assistant","x":Infinity,"message":{"content":[]}}\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] }); // JSON.parse throws on NaN
    const regs = Object.fromEntries(r.dirs[0].registries.map((x: any) => [x.file, x]));
    expect(regs['7.json'].data).toBeNull();
    expect(regs[`${pid}.json`].transcript.map((l: string) => JSON.parse(l).message.content[0].text)).toEqual(['ok']);
  });

  it('treats a float that overflows to infinity like NaN, so one registry file cannot take the host offline', () => {
    const d = makeDir();
    writeFileSync(join(d, 'sessions', '7.json'), '{"pid": 7, "sessionId": "o1", "cwd": "/x", "startedAt": -1e400}');
    writeFileSync(join(d, 'sessions', '8.json'), '{"pid": 8, "sessionId": "o2", "cwd": "/x", "startedAt": 1, "procStart": 1e999}');
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'o3', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 'o3.jsonl'), '{"type":"assistant","x":1e999,"message":{"content":[]}}\n'
      + JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    const regs = Object.fromEntries(r.dirs[0].registries.map((x: any) => [x.file, x]));
    expect(regs['7.json'].data).toBeNull();
    expect(regs['8.json'].data).toBeNull();
    expect(regs[`${pid}.json`].data.sessionId).toBe('o3');
    expect(regs[`${pid}.json`].transcript.map((l: string) => JSON.parse(l).message.content[0].text)).toEqual(['ok']);
  });

  it('reads registry files as UTF-8 whatever the host locale', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', '9.json'), { pid: 9, sessionId: 'l1', cwd: '/home/x/Документы', startedAt: 1 });
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] }, { LC_ALL: 'C', LANG: 'C', PYTHONUTF8: '0', PYTHONCOERCECLOCALE: '0' });
    expect(r.dirs[0].registries[0].data?.cwd).toBe('/home/x/Документы');
  });

  it('treats glob metacharacters in the config dir and session id literally', () => {
    const base = makeDir();
    const d = join(base, 'cfg[1]');
    mkdirSync(join(d, 'sessions'), { recursive: true });
    mkdirSync(join(d, 'projects', '-x'), { recursive: true });
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'g1', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 'g1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } }) + '\n');
    writeJson(join(d, 'sessions', '3.json'), { pid, sessionId: '*', cwd: '/x', startedAt: 1 });
    const regs = runProbeSync({ mode: 'snapshot', dirs: [d] }).dirs[0].registries;
    const bySid = Object.fromEntries(regs.map((x: any) => [x.data.sessionId, x.transcript.length]));
    expect(bySid).toEqual({ g1: 1, '*': 0 }); // '*' must not pick up another session's transcript
  });
});

describe('probe snapshot: the auto-compact window', () => {
  const window = (settings: unknown) => {
    const d = makeDir();
    if (settings !== undefined) writeFileSync(join(d, 'settings.json'), typeof settings === 'string' ? settings : JSON.stringify(settings));
    return runProbeSync({ mode: 'snapshot', dirs: [d] }).dirs[0].compactWindow;
  };
  it('reads autoCompactWindow, with the env setting taking precedence', () => {
    expect(window({ autoCompactWindow: 500000, model: 'opus[1m]' })).toBe(500000);
    expect(window({ autoCompactWindow: 500000, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: '300000' } })).toBe(300000);
  });
  it('is absent when unset or nonsense', () => {
    for (const s of [undefined, {}, { autoCompactWindow: 0 }, { autoCompactWindow: '' }, { autoCompactWindow: true }, { autoCompactWindow: -5 }, { autoCompactWindow: 1e12 }, '[1]', '{oops'])
      expect(window(s), JSON.stringify(s)).toBeUndefined();
  });
});

describe('probe snapshot: status line bridge records', () => {
  const rec = (sid: string, o: object = {}) => ({ sessionId: sid, ts: 1_760_000_000_000, contextWindowSize: 1_000_000, usedPercentage: 23, totalInputTokens: 226_000, model: 'claude-opus-5-5[1m]', ...o });
  const ctxDir = (d: string) => { mkdirSync(join(d, 'clayclaude', 'context'), { recursive: true }); return join(d, 'clayclaude', 'context'); };

  it('returns the record of each session it reports, and only those', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'a', cwd: '/x', startedAt: 1, procStart: procStart(pid) });
    writeJson(join(d, 'sessions', '2.json'), { pid: 2, sessionId: 'b', cwd: '/x', startedAt: 1 });
    const c = ctxDir(d);
    writeJson(join(c, 'a.json'), rec('a'));
    writeJson(join(c, 'b.json'), rec('b', { contextWindowSize: 200_000, usedPercentage: null, model: undefined }));
    writeJson(join(c, 'gone.json'), rec('gone'));
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].contexts).toEqual({ a: rec('a'), b: { sessionId: 'b', ts: 1_760_000_000_000, contextWindowSize: 200_000, usedPercentage: null, totalInputTokens: 226_000 } });
  });

  it('ignores garbage: a bad window, a mismatched id, an oversized or non-regular file, odd session ids', () => {
    const d = makeDir();
    const sids = ['w0', 'wneg', 'wstr', 'wbool', 'mis', 'big', 'fifo', 'arr', 'nots'];
    sids.forEach((sid, i) => writeJson(join(d, 'sessions', `${i + 10}.json`), { pid: i + 10, sessionId: sid, cwd: '/x', startedAt: 1 }));
    writeJson(join(d, 'sessions', '99.json'), { pid: 99, sessionId: '../escape', cwd: '/x', startedAt: 1 });
    const c = ctxDir(d);
    writeJson(join(c, 'w0.json'), rec('w0', { contextWindowSize: 0 }));
    writeJson(join(c, 'wneg.json'), rec('wneg', { contextWindowSize: -5 }));
    writeJson(join(c, 'wstr.json'), rec('wstr', { contextWindowSize: '1000000' }));
    writeJson(join(c, 'wbool.json'), rec('wbool', { contextWindowSize: true }));
    writeJson(join(c, 'mis.json'), rec('other'));
    writeFileSync(join(c, 'big.json'), JSON.stringify(rec('big', { model: 'm'.repeat(10_000) })));
    execFileSync('mkfifo', [join(c, 'fifo.json')]);
    writeFileSync(join(c, 'arr.json'), '[1,2]');
    writeFileSync(join(c, 'nots.json'), '{"sessionId":"nots","ts":"soon","contextWindowSize":200000}');
    writeJson(join(d, 'clayclaude', 'escape.json'), rec('../escape'));
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    expect(r.dirs[0].contexts).toBeUndefined();
    expect(r.dirs[0].registries).toHaveLength(sids.length + 1);
  });
});

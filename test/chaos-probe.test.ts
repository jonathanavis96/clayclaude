import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, symlinkSync, chmodSync, utimesSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeDir, sleeper, writeJson, PROBE, PYTHON } from './helpers/probe.js';

const kids: ReturnType<typeof sleeper>[] = [];
afterEach(() => { kids.splice(0).forEach((k) => k.kill()); });
function live() { const k = sleeper(); kids.push(k); return k.pid!; }

/** Runs the probe with a hard timeout, so a hang fails the test instead of the run. */
function probe(req: object, timeout = 5000): any {
  return JSON.parse(execFileSync(PYTHON, ['-I', PROBE, JSON.stringify(req)], { encoding: 'utf8', timeout, maxBuffer: 1 << 30 }));
}
const mkfifo = (p: string) => execFileSync('mkfifo', [p]);

describe('probe chaos: special files', () => {
  it('does not hang on a FIFO registry file', () => {
    const d = makeDir();
    mkfifo(join(d, 'sessions', '1.json'));
    writeJson(join(d, 'sessions', '2.json'), { pid: 2, sessionId: 'ok', cwd: '/x', startedAt: 1 });
    const regs = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries;
    expect(regs.map((r: any) => [r.file, r.data?.sessionId ?? null])).toEqual([['1.json', null], ['2.json', 'ok']]);
  });

  it('does not hang on a FIFO transcript', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'f1', cwd: '/x', startedAt: 1 });
    mkfifo(join(d, 'projects', '-x', 'f1.jsonl'));
    const reg = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries[0];
    expect(reg.live).toBe(true);
    expect(reg.transcript).toEqual([]);
  });

  it('does not hang on a FIFO events.jsonl', () => {
    const d = makeDir();
    mkdirSync(join(d, 'clayclaude'));
    mkfifo(join(d, 'clayclaude', 'events.jsonl'));
    expect(probe({ mode: 'snapshot', dirs: [d] }).dirs[0].events).toEqual([]);
  });

  it('does not read a registry symlinked to an endless device', () => {
    const d = makeDir();
    symlinkSync('/dev/zero', join(d, 'sessions', 'z.json'));
    symlinkSync('/dev/urandom', join(d, 'sessions', 'r.json'));
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'd1', cwd: '/x', startedAt: 1 });
    symlinkSync('/dev/zero', join(d, 'projects', '-x', 'd1.jsonl'));
    mkdirSync(join(d, 'clayclaude'));
    symlinkSync('/dev/urandom', join(d, 'clayclaude', 'events.jsonl'));
    const out = probe({ mode: 'snapshot', dirs: [d] });
    const regs = Object.fromEntries(out.dirs[0].registries.map((r: any) => [r.file, r]));
    expect(regs['z.json'].data).toBeNull();
    expect(regs['r.json'].data).toBeNull();
    expect(regs[`${pid}.json`].transcript).toEqual([]);
    expect(out.dirs[0].events).toEqual([]);
  });
});

describe('probe chaos: hostile contents', () => {
  it('survives a deeply nested registry file (RecursionError is not a ValueError)', () => {
    const d = makeDir();
    writeFileSync(join(d, 'sessions', 'deep.json'), '['.repeat(100_000) + ']'.repeat(100_000));
    writeFileSync(join(d, 'sessions', 'deepobj.json'), '{"a":'.repeat(50_000) + '1' + '}'.repeat(50_000));
    writeJson(join(d, 'sessions', 'ok.json'), { pid: 3, sessionId: 'ok', cwd: '/x', startedAt: 1 });
    const regs = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries;
    expect(regs.map((r: any) => r.data?.sessionId ?? null)).toEqual([null, null, 'ok']);
  });

  it('skips a deeply nested transcript line but keeps the rest of the transcript', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'n1', cwd: '/x', startedAt: 1 });
    const ok = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    writeFileSync(join(d, 'projects', '-x', 'n1.jsonl'), ok + '\n' + '{"type":"user","x":' + '['.repeat(100_000) + ']'.repeat(100_000) + '}\n' + ok + '\n');
    const reg = probe({ mode: 'snapshot', dirs: [d], tailBytes: 1_000_000 }).dirs[0].registries[0];
    expect(reg.transcript).toHaveLength(2);
  });

  it('keeps a transcript line nested just under the parser limit, cut to a sane depth', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'n2', cwd: '/x', startedAt: 1 });
    const ok = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }] } });
    for (const n of [900, 980, 995]) {
      writeFileSync(join(d, 'projects', '-x', 'n2.jsonl'), '{"type":"user","x":' + '['.repeat(n) + ']'.repeat(n) + '}\n' + ok + '\n');
      const reg = probe({ mode: 'snapshot', dirs: [d], tailBytes: 1_000_000 }).dirs[0].registries[0];
      expect(reg.transcript.at(-1), String(n)).toBe(ok);
    }
  });

  it('caps an enormous registry file instead of shipping it', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', 'big.json'), { pid: 4, sessionId: 'big', cwd: '/x', startedAt: 1, name: 'n'.repeat(20_000_000) });
    writeJson(join(d, 'sessions', 'wide.json'), { pid: 5, sessionId: 'wide', cwd: '/x', startedAt: 1, name: 'w'.repeat(30_000) });
    const out = execFileSync(PYTHON, ['-I', PROBE, JSON.stringify({ mode: 'snapshot', dirs: [d] })], { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 30 });
    expect(out.length).toBeLessThan(100_000);
    const regs = Object.fromEntries(JSON.parse(out).dirs[0].registries.map((r: any) => [r.file, r]));
    expect(regs['big.json'].data).toBeNull();
    expect(regs['wide.json'].data.sessionId).toBe('wide');
    expect(regs['wide.json'].data.name.length).toBeLessThanOrEqual(4096);
  });

  it('copes with every registry field having the wrong type', () => {
    const d = makeDir();
    const odd: unknown[] = [null, true, false, 0, -1, 1.5, 2 ** 70, 1e308, '', 'x', [], [1], {}, { a: 1 }];
    odd.forEach((v, i) => {
      for (const k of ['pid', 'sessionId', 'cwd', 'startedAt', 'procStart', 'name', 'status', 'statusUpdatedAt', 'updatedAt', 'tmux']) {
        writeJson(join(d, 'sessions', `${k}-${i}.json`), { pid: 6, sessionId: `s${i}`, cwd: '/x', startedAt: 1, [k]: v });
      }
    });
    writeFileSync(join(d, 'sessions', 'arr.json'), '[1,2]');
    writeFileSync(join(d, 'sessions', 'num.json'), '42');
    writeFileSync(join(d, 'sessions', 'bin.json'), Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7b]));
    writeFileSync(join(d, 'sessions', 'empty.json'), '');
    const out = probe({ mode: 'snapshot', dirs: [d] });
    expect(out.dirs[0].registries.length).toBe(odd.length * 10 + 4);
  });
});

describe('probe chaos: scale', () => {
  function crowd(n: number) {
    const d = makeDir();
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 't'.repeat(1000) }] } }) + '\n';
    for (let i = 0; i < n; i++) {
      const sid = `dead-${String(i).padStart(4, '0')}`;
      mkdirSync(join(d, 'projects', `-p${i % 37}`), { recursive: true });
      writeJson(join(d, 'sessions', `${100000 + i}.json`), { pid: 4_000_000 + i, sessionId: sid, cwd: `/p${i % 37}`, startedAt: 1 });
      writeFileSync(join(d, 'projects', `-p${i % 37}`, `${sid}.jsonl`), line.repeat(60));
    }
    return d;
  }

  it('keeps one snapshot under its byte budget, live sessions first, and fills the rest in on later polls', () => {
    const d = crowd(100);
    const pid = live();
    writeJson(join(d, 'sessions', `zzz-${pid}.json`), { pid, sessionId: 'live-1', cwd: '/x', startedAt: 1 });
    writeFileSync(join(d, 'projects', '-x', 'live-1.jsonl'), JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }) + '\n');
    const known: Record<string, string> = {};
    const have = new Set<string>();
    for (let poll = 0; poll < 20 && have.size < 101; poll++) {
      const out = execFileSync(PYTHON, ['-I', PROBE, JSON.stringify({ mode: 'snapshot', dirs: [d], known: { [d]: known }, budgetBytes: 1_000_000 })],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 1 << 30 });
      expect(out.length, `poll ${poll}`).toBeLessThan(1_200_000);
      const regs = JSON.parse(out).dirs[0].registries;
      expect(regs).toHaveLength(101);
      if (poll === 0) {
        expect(regs.find((r: any) => r.data.sessionId === 'live-1').transcript).toHaveLength(1);
        expect(regs.some((r: any) => r.deferred === true && r.tsig === undefined)).toBe(true);
      }
      for (const r of regs) if (r.tsig) { known[r.data.sessionId] = r.tsig; have.add(r.data.sessionId); }
    }
    expect(have.size).toBe(101);
  });
});

describe('probe chaos: recycled pids', () => {
  it('does not take a pid reused by a newer process as live when the registry has no procStart', () => {
    const d = makeDir();
    const pid = live();
    const day = 86_400_000;
    // Old Claude Code wrote no procStart; after a reboot its pid can belong to any daemon.
    writeJson(join(d, 'sessions', 'old.json'), { pid, sessionId: 'ghost', cwd: '/x', startedAt: Date.now() - 200 * day });
    writeJson(join(d, 'sessions', 'olds.json'), { pid, sessionId: 'ghost-s', cwd: '/x', startedAt: Math.floor((Date.now() - 200 * day) / 1000) });
    writeJson(join(d, 'sessions', 'new.json'), { pid, sessionId: 'mine', cwd: '/x', startedAt: Date.now() });
    writeJson(join(d, 'sessions', 'nostart.json'), { pid, sessionId: 'nostart', cwd: '/x' });
    const regs = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries;
    expect(Object.fromEntries(regs.map((r: any) => [r.data.sessionId, r.live]))).toEqual({ mine: true, nostart: true, ghost: false, 'ghost-s': false });
  });
});

describe('probe chaos: permissions', () => {
  it('sends no signature for a transcript it could not read, so the daemon does not cache an empty tail as current', () => {
    const d = makeDir();
    const pid = live();
    writeJson(join(d, 'sessions', `${pid}.json`), { pid, sessionId: 'p1', cwd: '/x', startedAt: Date.now() });
    const t = join(d, 'projects', '-x', 'p1.jsonl');
    writeFileSync(t, JSON.stringify({ type: 'assistant', message: { content: [] } }) + '\n');
    chmodSync(t, 0o000);
    try {
      const reg = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries[0];
      expect(reg.live).toBe(true);
      expect(reg.tsig).toBeUndefined();
    } finally { chmodSync(t, 0o644); }
    const reg = probe({ mode: 'snapshot', dirs: [d] }).dirs[0].registries[0];
    expect(reg.transcript).toHaveLength(1);
  });
});

describe('probe chaos: non-UTF-8', () => {
  it('reads a registry whose cwd holds bytes that are not UTF-8, and a file name that is not UTF-8', () => {
    const d = makeDir();
    const pid = live();
    writeFileSync(join(d, 'sessions', 'raw.json'), Buffer.concat([Buffer.from(`{"pid": ${pid}, "sessionId": "u2", "cwd": "/x`), Buffer.from([0xff]), Buffer.from(`", "startedAt": ${Date.now()}}`)]));
    execFileSync(PYTHON, ['-c', `import os,sys; open(os.fsencode(sys.argv[1]) + b"/sessions/\\xff\\xfe.json", "w").write('{"pid": 1, "sessionId": "u3", "cwd": "/y", "startedAt": 1}')`, d]);
    const out = probe({ mode: 'snapshot', dirs: [d] }, 5000);
    const byId = Object.fromEntries(out.dirs[0].registries.filter((r: any) => r.data?.sessionId).map((r: any) => [r.data.sessionId, r]));
    expect(byId.u2.live).toBe(true);
    expect(byId.u2.data.cwd).toBe('/x�');
    expect(byId.u3.file).toBe('\udcff\udcfe.json');
  });
});

describe('probe chaos: a sessions/ directory nobody cleans', () => {
  it('leaves out dead registry files older than the caller keeps stopped sessions', () => {
    const d = makeDir();
    for (let i = 0; i < 1500; i++) {
      const f = join(d, 'sessions', `${300000 + i}.json`);
      writeJson(f, { pid: 4_100_000 + i, sessionId: `old-${i}`, cwd: '/x', startedAt: 1 });
      utimesSync(f, 1, 1);
    }
    writeFileSync(join(d, 'sessions', 'junk.json'), 'nope');
    utimesSync(join(d, 'sessions', 'junk.json'), 1, 1);
    writeJson(join(d, 'sessions', 'recent.json'), { pid: 4_200_000, sessionId: 'recent', cwd: '/x', startedAt: 1 });
    const pid = live();
    writeJson(join(d, 'sessions', 'live.json'), { pid, sessionId: 'live', cwd: '/x', startedAt: Date.now() });
    utimesSync(join(d, 'sessions', 'live.json'), 1, 1); // a live session's file may be old: it is kept
    const out = execFileSync(PYTHON, ['-I', PROBE, JSON.stringify({ mode: 'snapshot', dirs: [d], deadAfterMs: 3 * 3600_000 })], { encoding: 'utf8', timeout: 5000 });
    expect(JSON.parse(out).dirs[0].registries.map((r: any) => r.data.sessionId).sort()).toEqual(['live', 'recent']);
    expect(out.length).toBeLessThan(2000);
  });
});

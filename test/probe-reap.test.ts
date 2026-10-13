import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, statSync, symlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeDir, procStart, runProbeSync, sleeper, writeJson } from './helpers/probe.js';

/**
 * Spec §5.1 (UI round 4, clearing stopped sessions) and §3.1: the probe's `reap` mode removes a session's registry
 * file only when, at that moment on the host, the file is a regular file directly inside <configDir>/sessions/,
 * its process is dead (or its pid was recycled: the start time differs from procStart), and its sessionId matches.
 */
const kids: ReturnType<typeof sleeper>[] = [];
afterEach(() => { kids.splice(0).forEach((k) => k.kill()); });
const livePid = () => { const k = sleeper(); kids.push(k); return k.pid!; };
/** A pid that is not running: a child that has already exited and been reaped. */
const DEAD_PID = 2 ** 22 - 7;

const reap = (dir: string, sessionId: string, files: string[]) => runProbeSync({ mode: 'reap', configDir: dir, sessionId, files });

describe('probe reap', () => {
  it('deletes a dead session\'s registry file', () => {
    const d = makeDir();
    const f = join(d, 'sessions', '123.json');
    writeJson(f, { pid: DEAD_PID, sessionId: 'dead', cwd: '/x', startedAt: Date.now() - 60_000, procStart: 999 });
    const r = reap(d, 'dead', ['123.json']);
    expect(r.ok).toBe(true);
    expect(r.results).toEqual([{ file: '123.json', removed: true, reason: 'removed' }]);
    expect(existsSync(f)).toBe(false);
  });

  it('deletes the file of a recycled pid (running, but its start time differs from procStart)', () => {
    const d = makeDir();
    const pid = livePid();
    const f = join(d, 'sessions', `${pid}.json`);
    writeJson(f, { pid, sessionId: 'old', cwd: '/x', startedAt: 1, procStart: 1 });
    expect(reap(d, 'old', [`${pid}.json`]).results[0]).toMatchObject({ removed: true });
    expect(existsSync(f)).toBe(false);
  });

  it('refuses a live pid whose start time matches procStart', () => {
    const d = makeDir();
    const pid = livePid();
    const f = join(d, 'sessions', `${pid}.json`);
    writeJson(f, { pid, sessionId: 'alive', cwd: '/x', startedAt: Date.now(), procStart: procStart(pid) });
    expect(reap(d, 'alive', [`${pid}.json`]).results[0]).toMatchObject({ removed: false, reason: 'live' });
    expect(existsSync(f)).toBe(true);
  });

  it('refuses a live pid with no procStart (the same rule as the snapshot)', () => {
    const d = makeDir();
    const pid = livePid();
    const f = join(d, 'sessions', `${pid}.json`);
    writeJson(f, { pid, sessionId: 'alive2', cwd: '/x', startedAt: Date.now() });
    expect(reap(d, 'alive2', [`${pid}.json`]).results[0]).toMatchObject({ removed: false, reason: 'live' });
    expect(existsSync(f)).toBe(true);
  });

  it('refuses a symlink, even to a dead session\'s file inside sessions/', () => {
    const d = makeDir();
    const real = join(d, 'sessions', 'real.json');
    writeJson(real, { pid: DEAD_PID, sessionId: 's', cwd: '/x', startedAt: 1, procStart: 1 });
    symlinkSync(real, join(d, 'sessions', 'link.json'));
    const outside = mkdtempSync(join(tmpdir(), 'cc-reap-out-'));
    writeJson(join(outside, 'o.json'), { pid: DEAD_PID, sessionId: 's', cwd: '/x', startedAt: 1, procStart: 1 });
    symlinkSync(join(outside, 'o.json'), join(d, 'sessions', 'out.json'));
    const r = reap(d, 's', ['link.json', 'out.json']);
    expect(r.results.map((x: any) => [x.file, x.removed, x.reason])).toEqual([['link.json', false, 'not a regular file'], ['out.json', false, 'not a regular file']]);
    expect(existsSync(real)).toBe(true);
    expect(existsSync(join(outside, 'o.json'))).toBe(true);
    expect(existsSync(join(d, 'sessions', 'link.json'))).toBe(true);
  });

  it('refuses a path outside sessions/ (traversal, absolute, nested, or a symlinked sessions dir)', () => {
    const d = makeDir();
    const victim = join(d, 'victim.json');
    writeJson(victim, { pid: DEAD_PID, sessionId: 's', cwd: '/x', startedAt: 1, procStart: 1 });
    mkdirSync(join(d, 'sessions', 'sub'));
    writeJson(join(d, 'sessions', 'sub', 'n.json'), { pid: DEAD_PID, sessionId: 's', cwd: '/x', startedAt: 1, procStart: 1 });
    const r = reap(d, 's', ['../victim.json', victim, 'sub/n.json', '..', '.', '']);
    expect(r.results.every((x: any) => x.removed === false && x.reason === 'not in sessions/')).toBe(true);
    expect(existsSync(victim)).toBe(true);
    expect(existsSync(join(d, 'sessions', 'sub', 'n.json'))).toBe(true);

    // <configDir>/sessions itself a symlink to somewhere else: its files are not that account's.
    const other = mkdtempSync(join(tmpdir(), 'cc-reap-other-'));
    writeJson(join(other, '5.json'), { pid: DEAD_PID, sessionId: 's', cwd: '/x', startedAt: 1, procStart: 1 });
    const d2 = mkdtempSync(join(tmpdir(), 'cc-reap-d2-'));
    symlinkSync(other, join(d2, 'sessions'));
    expect(reap(d2, 's', ['5.json']).results[0]).toMatchObject({ removed: false, reason: 'not in sessions/' });
    expect(existsSync(join(other, '5.json'))).toBe(true);
  });

  it('refuses a sessionId mismatch, a file with no pid, and an unparseable file', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', 'a.json'), { pid: DEAD_PID, sessionId: 'other', cwd: '/x', startedAt: 1, procStart: 1 });
    writeJson(join(d, 'sessions', 'b.json'), { sessionId: 'want', cwd: '/x' });
    writeJson(join(d, 'sessions', 'c.json'), { pid: DEAD_PID, cwd: '/x' });
    const r = reap(d, 'want', ['a.json', 'b.json', 'c.json', 'missing.json']);
    expect(r.results.map((x: any) => [x.file, x.removed, x.reason])).toEqual([
      ['a.json', false, 'sessionId differs'], ['b.json', false, 'no pid'], ['c.json', false, 'sessionId differs'], ['missing.json', false, 'not found']]);
    for (const f of ['a.json', 'b.json', 'c.json']) expect(existsSync(join(d, 'sessions', f))).toBe(true);
  });

  it('leaves the sessions directory\'s mtime as it was: a reap is not a claude run (the usage providers\' idle check)', () => {
    const d = makeDir();
    writeJson(join(d, 'sessions', '7.json'), { pid: DEAD_PID, sessionId: 'gone', cwd: '/x', startedAt: 1, procStart: 1 });
    const old = new Date(Date.now() - 3600_000);
    utimesSync(join(d, 'sessions'), old, old);
    expect(reap(d, 'gone', ['7.json']).results[0]).toMatchObject({ removed: true });
    expect(statSync(join(d, 'sessions')).mtimeMs).toBeCloseTo(old.getTime(), -1);
  });

  it('rejects a malformed request', () => {
    expect(() => runProbeSync({ mode: 'reap', configDir: '/x', sessionId: '', files: ['a.json'] })).toThrow();
    expect(() => runProbeSync({ mode: 'reap', configDir: '/x', sessionId: 's', files: 'a.json' })).toThrow();
    expect(() => runProbeSync({ mode: 'reap', configDir: 5, sessionId: 's', files: [] })).toThrow();
  });
});

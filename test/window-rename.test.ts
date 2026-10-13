import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec } from '../src/actions/exec.js';
import { createActionService } from '../src/actions/service.js';
import { NicknameStore } from '../src/nicknames.js';
import { killOwn, testSessionName } from './helpers/tmux.js';

/**
 * Task 42a, against the suite's private tmux server (test/setup/safety.ts): the rename sheet's "Also rename the tmux
 * window" tick renames the session's window, literally, and never touches what is in the pane.
 */
const cfg = parseConfig(`
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}]`);
const own: string[] = [];
// One idle session for the whole file: killing the last session would end the private server between tests.
const keeper = testSessionName('wren-keep-');
beforeAll(() => { execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']); });
afterAll(() => killOwn(keeper));
afterEach(() => { own.splice(0).forEach(killOwn); });

const tmux = (...a: string[]) => execFileSync('tmux', a, { encoding: 'utf8' }).trim();

/** A session of our own whose pane runs a shell showing a marker line, and the Session record Claude would write. */
function paneSession() {
  const name = testSessionName('wren-');
  own.push(name);
  tmux('new-session', '-d', '-x', '80', '-y', '10', '-s', name, '-n', 'before', 'env', 'PS1=$ ', 'bash', '--norc', '--noprofile', '-i');
  const [win, pane, pid] = tmux('display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}').split(' ');
  const session = { key: 'local:me:s1', host: 'local', account: 'me', sessionId: 's1', pid: Number(pid), name: 'derived', cwd: '/', state: 'working',
    stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, tmux: `${name}:${win}.${pane}` } as any;
  return { name, win, pane, session };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const windowName = (win: string) => tmux('display-message', '-p', '-t', win, '#{window_name}');

describe('Also rename the tmux window, in a real tmux', () => {
  it('renames the session\'s window to the name, literally, and types nothing into the pane', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-wren-'));
    const f = paneSession();
    await wait(300);
    const before = tmux('capture-pane', '-p', '-t', f.pane);
    const names = new NicknameStore(join(dir, 'state.json'));
    const svc = createActionService({ cfg, sessions: () => [f.session], probe: async () => ({}), exec: makeExec(), names });
    const evil = `-n $(touch ~/PWNED) 'q' "\`id\`" ;x &`;   // within the 40 characters
    for (const name of ['api work', 'café 🦊 ops', evil]) {
      expect(await svc.rename('local:me:s1', name, { tmux: true })).toMatchObject({ ok: true });
      expect(windowName(f.win)).toBe(name);
    }
    await wait(300);
    expect(existsSync(join(process.env.HOME!, 'PWNED'))).toBe(false);
    expect(tmux('capture-pane', '-p', '-t', f.pane)).toBe(before);
    expect(names.get('local:me:s1')).toBe(evil);
    // the other windows on the server keep their names
    expect(tmux('list-windows', '-t', `=${keeper}`, '-F', '#{window_name}')).not.toContain('api work');
  });

  it('renames nothing when the pane no longer belongs to the session (moved, or another process)', async () => {
    const f = paneSession();
    const svc = createActionService({ cfg, sessions: () => [{ ...f.session, tmux: f.session.tmux.replace(/@\d+/, '@999') }], probe: async () => ({}), exec: makeExec(), names: new NicknameStore(null) });
    const r = await svc.rename('local:me:s1', 'moved', { tmux: true });
    expect(r).toMatchObject({ ok: true, tmuxError: expect.stringMatching(/no longer belongs/) });
    expect(windowName(f.win)).toBe('before');
    const svc2 = createActionService({ cfg, sessions: () => [{ ...f.session, pid: 999_999 }], probe: async () => ({}), exec: makeExec(), names: new NicknameStore(null) });
    expect(await svc2.rename('local:me:s1', 'other', { tmux: true })).toMatchObject({ ok: true, tmuxError: expect.stringMatching(/no longer belongs/) });
    expect(windowName(f.win)).toBe('before');
  });
});

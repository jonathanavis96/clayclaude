import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../src/config.js';
import { makeExec } from '../src/actions/exec.js';
import { SendGuard, answer, readPrompt, type AnswerDeps } from '../src/actions/answer.js';
import { killOwn, testSessionName } from './helpers/tmux.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

/*
 * Claude Code 2.1.296 blinks the pending tool's bullet ("●" at column 0, then a space) while a permission prompt waits
 * (fixtures/panes/real-2.1.296/perm-bash.txt and perm-bash-manual.txt). Before the hashes ignored it, Yes and No failed
 * with prompt_changed about half the time. blink-screen.sh draws the real prompt in a tmux pane of our own (the suite's
 * private tmux server, test/setup/safety.ts), blinks that bullet every 50 ms, and logs every byte that reaches it.
 */

const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /x}]`);
const PANES = join(import.meta.dirname, 'fixtures', 'panes');
const STUB = join(import.meta.dirname, 'fixtures', 'blink-screen.sh');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const keeper = testSessionName('blink-keep-');
beforeAll(() => { execFileSync('tmux', ['new-session', '-d', '-s', keeper, 'sleep 3600']); });
afterAll(() => killOwn(keeper));

async function blinking(host: 'local' | 'box', run: (d: AnswerDeps, log: () => string[]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-blink-'));
  const log = join(dir, 'log');
  const name = testSessionName('blink-');
  // Row 13 of perm-bash-manual.txt is the pending tool's "  Creating marker file at the specified path".
  const cmd = [STUB, log, join(PANES, 'real-2.1.296/perm-bash-manual.txt'), '13', '0.05'].map((a) => `'${a}'`).join(' ');
  execFileSync('tmux', ['new-session', '-d', '-x', '120', '-y', '40', '-s', name, cmd]);
  try {
    const [win, pane, pid] = execFileSync('tmux', ['display-message', '-p', '-t', `=${name}:`, '#{window_id} #{pane_id} #{pane_pid}'], { encoding: 'utf8' }).trim().split(' ');
    await wait(500);
    const session = { key: 'local:me:s1', host, account: 'me', sessionId: 's1', pid: Number(pid), tmux: `${name}:${win}.${pane}`, hostOnline: true, state: 'needs-you' };
    const exec = host === 'box' ? makeExec({ sshBin: makeFakeSsh().bin }) : makeExec();
    // A fresh guard per tap: SendGuard refuses the same prompt twice within 3 s, and the stub's prompt never goes away.
    const d = (): AnswerDeps => ({ cfg, sessions: () => [session as any], exec, quickReplies: () => [], guard: new SendGuard() });
    await run(d(), () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []));
  } finally { killOwn(name); }
}

describe('a permission prompt whose tool bullet blinks', () => {
  it.each(['local', 'box'] as const)('12 of 12 Yes taps are sent, each as the digit 1 (%s)', async (host) => {
    await blinking(host, async (_d, log) => {
      const shown = new Set<string>();
      let ok = 0;
      for (let i = 0; i < 12; i++) {
        const d = { ..._d, guard: new SendGuard() };
        const r: any = await readPrompt(d, 'local:me:s1');
        expect(r.prompt.kind).toBe('permission');
        shown.add(r.prompt.detail.split('\n').find((l: string) => l.includes('Creating marker')));
        await wait(37 * (i % 3));                // land the tap in a different blink phase each time
        const a = await answer(d, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: 'yes' });
        expect(a, `tap ${i + 1}`).toEqual({ ok: true, sent: 'Yes' });
        ok++;
      }
      expect(ok).toBe(12);
      // The sheet saw both blink states, and the hash was the same for both.
      expect(shown.size).toBe(2);
      await wait(500);
      expect(log()).toEqual(Array(12).fill('1'));
    });
  }, 60000);

  it('No is sent too, as Escape', async () => {
    await blinking('local', async (d, log) => {
      for (let i = 0; i < 6; i++) {
        const r: any = await readPrompt({ ...d, guard: new SendGuard() }, 'local:me:s1');
        expect(await answer({ ...d, guard: new SendGuard() }, { sessionId: 'local:me:s1', promptHash: r.prompt.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
      }
      await wait(500);
      expect(log()).toEqual(Array(6).fill('ESC'));
    });
  });
});

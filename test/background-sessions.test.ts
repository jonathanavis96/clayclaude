import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProbeSync, makeDir, procStart, writeJson, PROBE, PYTHON } from './helpers/probe.js';
import { deriveSession, type DeriveInput } from '../src/core/status.js';
import { visibleSessions, newlyNeedsYou, withoutBackground } from '../web/src/filter.js';
import { DEFAULT_PREFS, parsePrefs } from '../web/src/prefs.js';
import { applyChange } from '../web/src/settings-model.js';
import { settingsHtml } from '../web/src/settings-view.js';
import type { ClayPrefs } from '../web/src/clay/index.js';

/**
 * Task 45: headless Claude processes (print mode `claude -p`, Agent SDK and stream-json helpers started by
 * automation) are not sessions anyone works in. Claude Code's registry file says so in `entrypoint`
 * (`sdk-cli`, `sdk-ts`, `sdk-py`); a registry without it falls back to the process's argv in /proc.
 */

const kids: ChildProcess[] = [];
afterEach(() => { kids.splice(0).forEach((k) => k.kill()); });

/** A fake /proc holding one `<pid>/cmdline` per entry, NUL-separated like the kernel writes it. */
function fakeProc(entries: Record<number, string[]>): string {
  const root = mkdtempSync(join(tmpdir(), 'cc-fakeproc-'));
  for (const [pid, argv] of Object.entries(entries)) {
    mkdirSync(join(root, pid));
    writeFileSync(join(root, pid, 'cmdline'), argv.map((a) => a + '\0').join(''));
  }
  return root;
}

/** Calls the probe's `headless_argv` for each pid, with its /proc pointed at `root`. */
function headless(root: string, pids: number[]): (boolean | null)[] {
  const py = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("probe", sys.argv[1])
probe = importlib.util.module_from_spec(spec); spec.loader.exec_module(probe)
probe.PROC = sys.argv[2]
print(json.dumps([probe.headless_argv(int(p)) for p in sys.argv[3:]]))
`;
  return JSON.parse(execFileSync(PYTHON, ['-c', py, PROBE, root, ...pids.map(String)], { encoding: 'utf8' }));
}

describe('probe: headless argv (fake /proc)', () => {
  const root = fakeProc({
    1: ['claude', '-p', '--model', 'haiku', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'],
    2: ['claude', '--dangerously-skip-permissions'],
    3: ['node', '/opt/claude/cli.js', '--print', 'hello'],
    4: ['claude', '--output-format=stream-json', '--input-format=stream-json'],
    5: ['claude', '--resume', 'abc', '--', '-p'],
    6: ['claude', 'explain -p and --print to me'],
    7: ['claude', '--output-format', 'text'],
    8: [],
  });
  it('a print-mode or stream-json process is headless', () => {
    expect(headless(root, [1, 3, 4])).toEqual([true, true, true]);
  });
  it('an interactive process is not, whatever its prompt says', () => {
    expect(headless(root, [2, 5, 6, 7])).toEqual([false, false, false, false]);
  });
  it('no argv (no /proc entry, macOS, or an empty cmdline) cannot tell', () => {
    expect(headless(root, [8, 9])).toEqual([null, null]);
  });
});

describe('probe snapshot: headless flag', () => {
  /** A live process whose argv reads like `claude <args>`. */
  function live(args: string[]) {
    const k = spawn(PYTHON, ['-c', 'import time; time.sleep(30)', ...args], { stdio: 'ignore' });
    kids.push(k);
    return k.pid!;
  }
  it('marks a live session without an entrypoint headless from its argv; never reads argv when the registry says', () => {
    const d = makeDir();
    const p1 = live(['-p', '--output-format', 'stream-json']);
    const p2 = live(['--dangerously-skip-permissions']);
    const p3 = live(['-p']);
    writeJson(join(d, 'sessions', `${p1}.json`), { pid: p1, sessionId: 'h', cwd: '/x', startedAt: 1, procStart: procStart(p1) });
    writeJson(join(d, 'sessions', `${p2}.json`), { pid: p2, sessionId: 'i', cwd: '/x', startedAt: 1, procStart: procStart(p2) });
    writeJson(join(d, 'sessions', `${p3}.json`), { pid: p3, sessionId: 'c', cwd: '/x', startedAt: 1, procStart: procStart(p3), entrypoint: 'cli' });
    const r = runProbeSync({ mode: 'snapshot', dirs: [d] });
    const byId = Object.fromEntries(r.dirs[0].registries.map((x: any) => [x.data.sessionId, [x.live, x.headless]]));
    expect(byId).toEqual({ h: [true, true], i: [true, undefined], c: [true, undefined] });
  });
});

const NOW = Date.parse('2026-10-13T12:00:00Z');
function input(data: Record<string, unknown>, headlessFlag?: boolean): DeriveInput {
  return {
    host: 'local', account: 'me', events: [], usageExhausted: false, cacheTtlMinutes: 60,
    contextWindows: { default: 200000 }, hostOnline: true, lastSeen: NOW,
    reg: { file: '1.json', mtimeMs: NOW - 5000, live: true, transcript: [], ...(headlessFlag === undefined ? {} : { headless: headlessFlag }),
      data: { pid: 1, sessionId: 's', cwd: '/x', startedAt: NOW - 3600_000, status: 'idle', kind: 'interactive', ...data } },
  };
}
const bg = (data: Record<string, unknown>, h?: boolean) => deriveSession(input(data, h), NOW)!.background;

describe('deriveSession: background', () => {
  it('an SDK or print-mode entrypoint is a background session', () => {
    expect([bg({ entrypoint: 'sdk-cli' }), bg({ entrypoint: 'sdk-ts' }), bg({ entrypoint: 'sdk-py' })]).toEqual([true, true, true]);
  });
  it('interactive entrypoints never are, even if argv looked headless', () => {
    expect([bg({ entrypoint: 'cli' }), bg({ entrypoint: 'claude-desktop' }), bg({ entrypoint: 'claude-vscode' }), bg({ entrypoint: 'cli' }, true)])
      .toEqual([undefined, undefined, undefined, undefined]);
  });
  it('without an entrypoint, the probe\'s argv check decides', () => {
    expect([bg({}), bg({}, false), bg({}, true)]).toEqual([undefined, undefined, true]);
  });
});

describe('board filter: background sessions', () => {
  const s = (key: string, background?: true, state = 'asleep') => ({ key, state, stateSince: NOW, hostOnline: true, ...(background && { background }) }) as any;
  const list = [s('work'), s('helper', true), s('desk')];
  it('hides background sessions by default and shows them with the setting', () => {
    expect(visibleSessions(list, 3_600_000, NOW).map((x) => x.key)).toEqual(['work', 'desk']);
    expect(visibleSessions(list, 3_600_000, NOW, true).map((x) => x.key)).toEqual(['work', 'helper', 'desk']);
  });
  it('never hides an interactive session', () => {
    expect(withoutBackground([s('a'), s('b', undefined, 'needs-you')], false).map((x) => x.key)).toEqual(['a', 'b']);
  });
  it('a hidden background session does not chime', () => {
    expect(newlyNeedsYou(new Set(), withoutBackground([s('h', true, 'needs-you')], false))).toEqual([]);
  });
});

describe('setting: Show background sessions', () => {
  const C: ClayPrefs = { mode: 'auto', shadows: true, fpsCap: 60, bodyColour: '#e07a4f' };
  it('is off by default, persisted, and tolerant of junk', () => {
    expect(DEFAULT_PREFS.showBackground).toBe(false);
    expect(parsePrefs('{"showBackground":true}').showBackground).toBe(true);
    expect(parsePrefs('{"showBackground":"yes"}').showBackground).toBe(false);
  });
  it('the settings panel has the checkbox and it changes the pref', () => {
    expect(applyChange(DEFAULT_PREFS, C, 'showBackground', true).prefs.showBackground).toBe(true);
    const html = settingsHtml({ prefs: DEFAULT_PREFS, clay: C, config: null, clayStatus: { mode: 'bake', reason: 'x', baked: 0, total: 0 },
      effective: { quickReplies: ['yes'], confirmBeforeSend: false, stoppedRetentionMs: 3_600_000 } });
    expect(html).toContain('data-pref="showBackground"');
    expect(html).toContain('Show background sessions');
  });
});

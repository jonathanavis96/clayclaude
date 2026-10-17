import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TabletSleep, mergeScreenPrefs } from '../src/tablet-sleep.js';
import { extractTranscript } from '../src/core/transcript.js';
import type { Session } from '../src/types.js';

const MIN = 60_000;
const DEFAULTS = { dimAfterMinutes: 30, dimPercent: 10, sleepAfterMinutes: 70 };

function rig(o: { statePath?: string; serial?: string | undefined } = {}) {
  let serial = 'serial' in o ? o.serial : 'TAB1';
  let now = 1_800_000_000_000;
  const calls: string[] = [];
  const sessions: Partial<Session>[] = [{ lastPromptAt: now - 5 * MIN }];
  let failing: boolean | 'puts' = false;
  const run = async (args: string[]) => {
    const sh = args.slice(3).join(' ');
    calls.push(sh);
    if (failing === true || (failing === 'puts' && sh.startsWith('settings put'))) throw new Error('device offline');
    if (sh === 'settings get system screen_brightness') return '180\n';
    if (sh === 'settings get system screen_brightness_mode') return '1\n';
    return '';
  };
  const s = new TabletSleep({ adbBin: 'adb', serial: () => serial, sessions: () => sessions as Session[],
    defaults: DEFAULTS, statePath: o.statePath, run, now: () => now, log: () => {} });
  return { s, calls, sessions, connect: (v: string) => { serial = v; }, fail: (v: boolean | 'puts') => { failing = v; }, at: (m: number) => { now = 1_800_000_000_000 + m * MIN; }, now: () => now };
}

describe('TabletSleep', () => {
  it('counts the daemon start as activity, then dims at 30 min and sleeps at 70', async () => {
    const r = rig();
    expect(await r.s.tick()).toBeUndefined();
    r.at(29); expect(await r.s.tick()).toBeUndefined();
    r.at(30); expect(await r.s.tick()).toBe('dim');
    expect(r.calls).toEqual(['settings get system screen_brightness', 'settings get system screen_brightness_mode',
      'settings put system screen_brightness_mode 0', 'settings put system screen_brightness 26']);
    r.calls.length = 0;
    r.at(69); expect(await r.s.tick()).toBeUndefined();
    r.at(70); expect(await r.s.tick()).toBe('asleep');
    expect(r.calls).toEqual(['input keyevent KEYCODE_SLEEP']);
    r.at(500); expect(await r.s.tick()).toBeUndefined();
  });

  it('wakes on a new prompt and puts the brightness and its mode back', async () => {
    const r = rig();
    await r.s.tick(); r.at(30); await r.s.tick(); r.at(80); await r.s.tick();
    r.calls.length = 0;
    r.at(81); r.sessions.push({ lastPromptAt: r.now() });
    expect(await r.s.tick()).toBe('awake');
    expect(r.calls).toEqual(['input keyevent KEYCODE_WAKEUP', 'wm dismiss-keyguard',
      'settings put system screen_brightness 180', 'settings put system screen_brightness_mode 1']);
    r.at(81 + 29); expect(await r.s.tick()).toBeUndefined();
  });

  it('ignores prompts in background sessions', async () => {
    const r = rig();
    await r.s.tick();
    r.at(40); r.sessions.push({ lastPromptAt: r.now(), background: true });
    expect(await r.s.tick()).toBe('dim');
  });

  it('0 minutes turns a step off', async () => {
    const r = rig();
    await r.s.setPrefs({ dimAfterMinutes: 0 });
    r.at(69); expect(await r.s.tick()).toBeUndefined();
    r.at(70); expect(await r.s.tick()).toBe('asleep');
    expect(r.calls).toEqual(['input keyevent KEYCODE_SLEEP']);
  });

  it('sends nothing before a tablet has connected, then sends the step that is due', async () => {
    const r = rig({ serial: undefined });
    await r.s.tick(); r.at(80);
    expect(await r.s.tick()).toBeUndefined();
    expect(r.calls).toEqual([]);
    r.connect('TAB1');
    expect(await r.s.tick()).toBe('asleep');
    expect(r.calls).toEqual(['input keyevent KEYCODE_SLEEP']);
  });

  it('a new dim percentage applies at once while dimmed', async () => {
    const r = rig();
    await r.s.tick(); r.at(30); await r.s.tick();
    r.calls.length = 0;
    expect(await r.s.setPrefs({ dimPercent: 50 })).toEqual({ ...DEFAULTS, dimPercent: 50 });
    expect(r.calls).toEqual(['settings put system screen_brightness 128']);
  });

  it('keeps board changes in state.json and refuses bad values', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-screen-'));
    try {
      const statePath = join(dir, 'state.json');
      const r = rig({ statePath });
      expect(await r.s.setPrefs({ sleepAfterMinutes: 1.5 })).toBeUndefined();
      expect(await r.s.setPrefs({ dimPercent: 0 })).toBeUndefined();
      expect(await r.s.setPrefs({ sleepAfterMinutes: 90 })).toEqual({ ...DEFAULTS, sleepAfterMinutes: 90 });
      expect(JSON.parse(readFileSync(statePath, 'utf8')).screen).toEqual({ ...DEFAULTS, sleepAfterMinutes: 90 });
      expect(rig({ statePath }).s.prefs()).toEqual({ ...DEFAULTS, sleepAfterMinutes: 90 });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('after a restart it puts back a screen an earlier run left dimmed or asleep', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-screen-'));
    try {
      const statePath = join(dir, 'state.json');
      const a = rig({ statePath });
      await a.s.tick(); a.at(30); await a.s.tick(); a.at(70); await a.s.tick();
      expect(JSON.parse(readFileSync(statePath, 'utf8')).screenState).toEqual({ step: 'asleep', brightness: '180', mode: '1' });
      const b = rig({ statePath });   // the first run died without stopping
      expect(await b.s.tick()).toBe('awake');
      expect(b.calls).toEqual(['input keyevent KEYCODE_WAKEUP', 'wm dismiss-keyguard',
        'settings put system screen_brightness 180', 'settings put system screen_brightness_mode 1']);
      expect(JSON.parse(readFileSync(statePath, 'utf8')).screenState).toBeNull();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a clean stop puts the screen back', async () => {
    const r = rig();
    await r.s.tick(); r.at(30); await r.s.tick();
    r.calls.length = 0;
    await r.s.stop();
    expect(r.calls).toEqual(['settings put system screen_brightness 180', 'settings put system screen_brightness_mode 1']);
  });

  it('a failed step is tried again, so a reconnected tablet still gets it', async () => {
    const r = rig();
    await r.s.tick(); r.at(30);
    r.fail(true);
    expect(await r.s.tick()).toBeUndefined();
    r.fail(false); r.calls.length = 0;
    expect(await r.s.tick()).toBe('dim');
    expect(r.calls).toContain('settings put system screen_brightness 26');
  });

  it('a dim that fails after reading the brightness sends the dim again and keeps the first reading', async () => {
    const r = rig();
    await r.s.tick(); r.at(30);
    r.fail('puts');
    expect(await r.s.tick()).toBeUndefined();
    r.fail(false); r.calls.length = 0;
    expect(await r.s.tick()).toBe('dim');
    expect(r.calls).toEqual(['settings put system screen_brightness_mode 0', 'settings put system screen_brightness 26']);
    r.calls.length = 0;
    r.sessions.push({ lastPromptAt: r.now() });
    expect(await r.s.tick()).toBe('awake');
    expect(r.calls).toEqual(['settings put system screen_brightness 180', 'settings put system screen_brightness_mode 1']);
  });

  it('mergeScreenPrefs takes only whole, in-range values', () => {
    expect(mergeScreenPrefs(DEFAULTS, { dimPercent: 50 })).toEqual({ ...DEFAULTS, dimPercent: 50 });
    expect(mergeScreenPrefs(DEFAULTS, { dimAfterMinutes: -1 })).toBeUndefined();
    expect(mergeScreenPrefs(DEFAULTS, { dimPercent: '10' })).toBeUndefined();
    expect(mergeScreenPrefs(DEFAULTS, null)).toBeUndefined();
  });
});

describe('extractTranscript lastPromptAt', () => {
  const line = (o: object) => JSON.stringify(o);
  it('is the newest typed prompt, not a tool result or meta entry', () => {
    const t = extractTranscript([
      line({ type: 'user', timestamp: '2026-10-17T10:00:00Z', message: { content: 'hello' } }),
      line({ type: 'user', timestamp: '2026-10-17T10:05:00Z', message: { content: [{ type: 'tool_result', tool_use_id: 'x' }] } }),
      line({ type: 'user', timestamp: '2026-10-17T10:06:00Z', isMeta: true, message: { content: 'meta' } }),
    ]);
    expect(t.lastPromptAt).toBe(Date.parse('2026-10-17T10:00:00Z'));
    expect(t.lastUserAt).toBe(Date.parse('2026-10-17T10:06:00Z'));
  });
});

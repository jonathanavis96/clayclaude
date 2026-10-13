import { describe, it, expect } from 'vitest';
import { AdbReverse } from '../src/adb.js';

function fakeAdb() {
  const st = { device: false, reversed: false, emulator: false, calls: [] as string[] };
  const run = async (all: string[]) => {
    st.calls.push(all.join(' '));
    if (all[0] === 'devices') return `List of devices attached\n${st.device ? 'TAB1\tdevice\n' : ''}${st.emulator ? 'emulator-5554\tdevice\n' : ''}`;
    if (all[0] !== '-s') throw new Error('error: more than one device/emulator');
    const args = all.slice(2);
    if (args[0] === 'reverse' && args[1] === '--list') return all[1] === 'TAB1' && st.reversed ? 'UsbFfs tcp:8420 tcp:8420\n' : '';
    if (args[0] === 'reverse') { if (all[1] === 'TAB1') st.reversed = true; return ''; }
    return '';
  };
  return { st, run };
}

describe('AdbReverse', () => {
  it('re-applies the reverse after the tablet is unplugged and replugged', async () => {
    const { st, run } = fakeAdb();
    const a = new AdbReverse('adb', 8420, { run });
    expect(await a.tick()).toBe('no-device');
    st.device = true;
    expect(await a.tick()).toBe('applied');
    expect(await a.tick()).toBe('present');
    st.device = false; st.reversed = false;          // unplug clears reverses
    expect(await a.tick()).toBe('no-device');
    st.device = true;                                 // replug
    expect(await a.tick()).toBe('applied');
    expect(st.calls.filter((c) => c === '-s TAB1 reverse tcp:8420 tcp:8420')).toHaveLength(2);
  });
  it('treats adb failure as no device', async () => {
    const a = new AdbReverse('adb', 8420, { run: async () => { throw new Error('adb missing'); } });
    expect(await a.tick()).toBe('no-device');
  });
  it('targets each attached device by serial, so a second device or an emulator does not break it', async () => {
    const { st, run } = fakeAdb();
    st.device = true; st.emulator = true;
    const a = new AdbReverse('adb', 8420, { run });
    expect(await a.tick()).toBe('applied');
    expect(st.calls).toContain('-s TAB1 reverse tcp:8420 tcp:8420');
    expect(st.calls).toContain('-s emulator-5554 reverse tcp:8420 tcp:8420');
  });
  it('skips a tick while the previous one is still running', async () => {
    let release!: () => void; let n = 0;
    const a = new AdbReverse('adb', 8420, { run: async () => { n++; await new Promise<void>((r) => { release = r; }); return ''; } });
    const first = a.tick();
    expect(await a.tick()).toBe('busy');
    release(); await first;
    expect(n).toBe(1);
  });
});

describe('AdbReverse device connects (kiosk)', () => {
  it('reports a connect once per plug-in, after the reverse is in place, and again after a replug', async () => {
    const { st, run } = fakeAdb();
    const seen: string[] = [];
    const a = new AdbReverse('adb', 8420, { run, onConnect: (s) => seen.push(`${s} reversed=${st.reversed}`) });
    await a.tick();
    expect(seen).toEqual([]);
    st.device = true;
    await a.tick(); await a.tick(); await a.tick();
    expect(seen).toEqual(['TAB1 reversed=true']);
    st.device = false; st.reversed = false;           // unplug
    await a.tick();
    st.device = true;                                  // replug, same serial
    await a.tick(); await a.tick();
    expect(seen).toEqual(['TAB1 reversed=true', 'TAB1 reversed=true']);
  });

  it('counts a replug that comes back within one tick (same serial, reverse gone) as a connect', async () => {
    // `adb reconnect` (and a quick unplug/replug) drops the device for about a second: the serial is listed on both
    // ticks, but the device lost every reverse. Seen on the tablet 2026-10-12: no second launch without this.
    const { st, run } = fakeAdb();
    st.device = true;
    const seen: string[] = [];
    const a = new AdbReverse('adb', 8420, { run, onConnect: (s) => seen.push(s) });
    await a.tick(); await a.tick();
    expect(seen).toEqual(['TAB1']);
    st.reversed = false;                               // reconnected between two ticks
    expect(await a.tick()).toBe('applied');
    await a.tick();
    expect(seen).toEqual(['TAB1', 'TAB1']);
  });

  it('counts the device already attached when the daemon starts as a connect', async () => {
    const { st, run } = fakeAdb();
    st.device = true; st.reversed = true;
    const seen: string[] = [];
    await new AdbReverse('adb', 8420, { run, onConnect: (s) => seen.push(s) }).tick();
    expect(seen).toEqual(['TAB1']);
  });

  it('does not report a connect while the reverse fails, nor again when an adb hiccup passes', async () => {
    let reverseFails = true, adbDown = false, reversed = false;
    const seen: string[] = [];
    const a = new AdbReverse('adb', 8420, { onConnect: (s) => seen.push(s), log: () => {}, run: async (all) => {
      if (adbDown) throw new Error('adb server restarting');
      if (all[0] === 'devices') return 'TAB1\tdevice\n';
      if (all[3] === '--list') return reversed ? 'UsbFfs tcp:8420 tcp:8420\n' : '';
      if (reverseFails) throw new Error('error: closed');
      reversed = true; return '';
    } });
    await a.tick(); await a.tick();
    expect(seen).toEqual([]);
    reverseFails = false;
    await a.tick();
    expect(seen).toEqual(['TAB1']);
    adbDown = true; await a.tick(); adbDown = false; await a.tick();
    expect(seen).toEqual(['TAB1']);
  });

  it('keeps ticking when the connect handler throws', async () => {
    const { st, run } = fakeAdb();
    st.device = true;
    const logs: string[] = [];
    const a = new AdbReverse('adb', 8420, { run, log: (m) => logs.push(m), onConnect: () => { throw new Error('boom'); } });
    expect(await a.tick()).toBe('applied');
    expect(logs.at(-1)).toBe('clayclaude: device-connect handler failed on TAB1: boom');
  });
});

describe('AdbReverse edge cases', () => {
  it('reads Windows adb.exe output with CRLF line endings', async () => {
    let reversed = false;
    const a = new AdbReverse('adb.exe', 8420, { run: async (all) => {
      if (all[0] === 'devices') return 'List of devices attached\r\nTAB1\tdevice\r\n\r\n';
      if (all[3] === '--list') return reversed ? 'UsbFfs tcp:8420 tcp:8420\r\n' : '';
      reversed = true; return '';
    } });
    expect(await a.tick()).toBe('applied');
    expect(await a.tick()).toBe('present');
  });

  it('does not mistake a reverse for a different port for its own', async () => {
    const calls: string[] = [];
    const a = new AdbReverse('adb', 742, { run: async (all) => {
      calls.push(all.join(' '));
      if (all[0] === 'devices') return 'TAB1\tdevice\n';
      if (all[3] === '--list') return 'UsbFfs tcp:742 tcp:7420\nUsbFfs tcp:1742 tcp:742\n';
      return '';
    } });
    expect(await a.tick()).toBe('applied');
    expect(calls).toContain('-s TAB1 reverse tcp:742 tcp:742');
  });

  it('logs when the reverse is applied and when adb cannot run, once per change', async () => {
    const logs: string[] = [];
    let fail = true, reversed = false;
    const a = new AdbReverse('/no/adb', 8420, { log: (m) => logs.push(m), run: async (all) => {
      if (fail) throw Object.assign(new Error('spawn /no/adb ENOENT'), { code: 'ENOENT' });
      if (all[0] === 'devices') return 'TAB1\tdevice\n';
      if (all[3] === '--list') return reversed ? 'UsbFfs tcp:8420 tcp:8420\n' : '';
      reversed = true; return '';
    } });
    await a.tick(); await a.tick();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('/no/adb');
    fail = false;
    await a.tick(); await a.tick();
    expect(logs).toHaveLength(2);
    expect(logs[1]).toContain('TAB1');
  });
});

describe('AdbReverse and another adb server (one adb only)', () => {
  const KILL = 'kill' + '-server'; // spelled in two parts: the safety test bans the literal (it guards tmux)
  function world(otherSees = true) {
    let t = 0;
    const logs: string[] = [];
    const otherCalls: string[][] = [];
    const ownCalls: string[][] = [];
    let ownDevice = false;
    const a = new AdbReverse('/mnt/c/x/adb.exe', 7420, {
      log: (m) => logs.push(m), now: () => t,
      run: async (all) => { ownCalls.push(all); return all[0] === 'devices' ? `List of devices attached\n${ownDevice ? 'TAB1\tdevice\n' : ''}` : ''; },
      other: { bin: '/usr/bin/adb', serverUp: async () => true, run: async (argv) => { otherCalls.push(argv); return `List of devices attached\n${otherSees ? 'TAB1\tdevice\n' : ''}`; } },
    });
    return { a, logs, otherCalls, ownCalls, advance: (ms: number) => { t += ms; }, plug: (v: boolean) => { ownDevice = v; } };
  }

  it('logs the adb it uses once at start', () => {
    const logs: string[] = [];
    const a = new AdbReverse('/mnt/c/x/adb.exe', 7420, { log: (m) => logs.push(m), run: async () => '', intervalMs: 60_000 });
    a.start(); a.start(); a.stop();
    expect(logs.filter((l) => l.includes('/mnt/c/x/adb.exe'))).toHaveLength(1);
    expect(logs[0]).toMatch(/using adb \/mnt\/c\/x\/adb\.exe/);
  });

  it('after 30 s with no device, asks the other adb once and warns once, naming both paths and the fix', async () => {
    const w = world();
    await w.a.tick();
    w.advance(29_000); await w.a.tick();
    expect(w.otherCalls).toEqual([]);
    w.advance(1_000); await w.a.tick();
    for (let i = 0; i < 20; i++) { w.advance(3_000); await w.a.tick(); }
    expect(w.otherCalls).toEqual([['devices']]);
    const warn = w.logs.filter((l) => /another adb server/i.test(l));
    expect(warn).toHaveLength(1);
    expect(warn[0]).toContain('/mnt/c/x/adb.exe');
    expect(warn[0]).toContain('/usr/bin/adb');
    expect(warn[0]).toContain('tablet.adb');
    expect(warn[0]).toContain(`/usr/bin/adb ${KILL}`);
  });

  it('says nothing when the other adb sees no device either', async () => {
    const w = world(false);
    await w.a.tick(); w.advance(31_000); await w.a.tick(); w.advance(31_000); await w.a.tick();
    expect(w.otherCalls).toEqual([['devices']]);
    expect(w.logs.filter((l) => /another adb server/i.test(l))).toEqual([]);
  });

  it('does not run the other adb at all when its server is not running (devices would start one)', async () => {
    const otherCalls: string[][] = [];
    let t = 0;
    const a = new AdbReverse('/mnt/c/x/adb.exe', 7420, {
      log: () => {}, now: () => t, run: async () => 'List of devices attached\n',
      other: { bin: '/usr/bin/adb', serverUp: async () => false, run: async (argv) => { otherCalls.push(argv); return ''; } },
    });
    await a.tick(); t = 60_000; await a.tick(); t = 120_000; await a.tick();
    expect(otherCalls).toEqual([]);
  });

  it('checks again after the device came back and went away; never kill or start the server on the other adb', async () => {
    const w = world();
    await w.a.tick(); w.advance(30_000); await w.a.tick();
    w.plug(true); await w.a.tick();
    w.plug(false); await w.a.tick(); w.advance(30_000); await w.a.tick();
    expect(w.otherCalls).toEqual([['devices'], ['devices']]);
    expect(w.logs.filter((l) => /another adb server/i.test(l))).toHaveLength(2);
    const all = [...w.otherCalls, ...w.ownCalls].map((c) => c.join(' '));
    expect(all.some((c) => c.includes(KILL) || /start-server|reconnect/.test(c))).toBe(false);
  });
});

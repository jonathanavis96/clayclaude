import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ahkString, hotkeyTemplate, installHotkey, renderHotkeyScript } from '../src/hotkey/install.js';
import { localIO } from '../src/hooks/install.js';

const v = { adb: 'C:\\Android\\platform-tools\\adb.exe', scrcpy: 'C:\\scrcpy\\scrcpy.exe', serial: 'TAB123', url: 'http://localhost:8420/', chromePackage: 'com.android.chrome', hotkey: '#+t' };
const AHK = '/mnt/c/Program Files/AutoHotkey/v2/AutoHotkey64.exe';

describe('hotkey script', () => {
  it('fills every placeholder', () => {
    const s = renderHotkeyScript(hotkeyTemplate(), v);
    expect(s).not.toMatch(/\{\{/);
    expect(s).toContain('adbPath := "C:\\Android\\platform-tools\\adb.exe"');
    expect(s).toContain('Hotkey "#+t", Toggle');
    expect(s).toContain('--no-video --no-audio --keyboard=uhid --mouse=uhid');
    expect(s).toContain('chromePackage := "com.android.chrome"');
    expect(s).toContain('serial := "TAB123"');
  });
  it('brings Chrome and its open board tab to the front without loading a URL, which would reload the board', () => {
    const s = renderHotkeyScript(hotkeyTemplate(), v);
    const am = s.split('\n').filter((l) => l.includes('am start'));
    expect(am).toHaveLength(1);
    // The launcher intent: Chrome comes back with the tab it was showing. A VIEW intent with -d re-navigates that tab.
    expect(am[0]).toContain('-a android.intent.action.MAIN -c android.intent.category.LAUNCHER -p " chromePackage');
    expect(am[0]).not.toMatch(/ -d |VIEW|boardUrl/);
    expect(s).not.toContain('http://localhost:8420/');
  });
  it('titles the scrcpy window "clayclaude", not after the device', () => {
    const s = renderHotkeyScript(hotkeyTemplate(), v);
    expect(s).toContain('windowTitle := "clayclaude"');
    const run = s.split('\n').find((l) => /^\s*Run '"' scrcpyPath '"'/.test(l))!;
    expect(run).toMatch(/ --window-title=" windowTitle,/);
  });
  it('activates the scrcpy window and clicks inside it, so the mouse is captured without a manual click', () => {
    const s = renderHotkeyScript(hotkeyTemplate(), v);
    const lines = s.split('\n');
    const at = (re: RegExp) => lines.findIndex((l) => re.test(l));
    const run = at(/^\s*Run '"' scrcpyPath '"'/);
    const call = at(/^\s*Capture\(\)\s*$/);
    expect(call).toBeGreaterThan(run);
    const fn = at(/^Capture\(\) \{/);
    expect(fn).toBeGreaterThan(-1);
    const body = lines.slice(fn, lines.findIndex((l, i) => i > fn && l === '}') + 1).join('\n');
    // Found by its title AND its process, never another window that happens to be titled "clayclaude" (a browser tab).
    expect(body).toContain('win := windowTitle " ahk_pid " scrcpyPid');
    const order = ['WinWait(win', 'WinActivate win', 'WinWaitActive(win', 'Click '].map((k) => body.indexOf(k));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain('CoordMode "Mouse", "Client"');
  });
  it('escapes quotes and backticks, and refuses injection through the hotkey or serial', () => {
    expect(ahkString('a"b`c')).toBe('a`"b``c');
    const s = renderHotkeyScript(hotkeyTemplate(), { ...v, adb: 'C:\\a"; MsgBox("x");"' });
    expect(s).toContain('adbPath := "C:\\a`"`; MsgBox(`"x`")`;`""');
    expect(ahkString('C:\\my tools ;x\\adb.exe')).toBe('C:\\my tools `;x\\adb.exe');
    expect(() => renderHotkeyScript(hotkeyTemplate(), { ...v, hotkey: '#t", Toggle\nRun "calc' })).toThrow(/valid AutoHotkey hotkey/);
    expect(() => renderHotkeyScript(hotkeyTemplate(), { ...v, serial: 'x" y' })).toThrow(/serial/);
    expect(() => ahkString('a\nb')).toThrow();
  });
  it('points scrcpy at the configured adb (ADB), so its bundled adb never restarts the adb server', () => {
    const s = renderHotkeyScript(hotkeyTemplate(), v);
    const lines = s.split('\n');
    const env = lines.findIndex((l) => /^\s*EnvSet "ADB", adbPath\s*$/.test(l));
    const run = lines.findIndex((l) => /^\s*Run '"' scrcpyPath '"'/.test(l));
    expect(env).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(env);
    // Inside Grab(), where the scrcpy Run is, so the value is current whenever scrcpy starts.
    const grab = lines.findIndex((l) => l.startsWith('Grab()'));
    expect(env).toBeGreaterThan(grab);
  });
  it('does not re-expand placeholders found inside values', () => {
    expect(renderHotkeyScript(hotkeyTemplate(), { ...v, scrcpy: 'C:\\x\\{{SERIAL}}' })).toContain('scrcpyPath := "C:\\x\\{{SERIAL}}"');
  });
  it('writes the script, and a copy for the Startup folder', async () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-hk-'));
    await installHotkey(localIO(), join(d, 'a', 'hk.ahk'), 'X', join(d, 'startup.ahk'));
    expect(readFileSync(join(d, 'a', 'hk.ahk'), 'utf8')).toBe('X');
    expect(readFileSync(join(d, 'startup.ahk'), 'utf8')).toBe('X');
  });
  it.skipIf(!existsSync(AHK))('passes AutoHotkey v2 syntax validation (skipped where AutoHotkey is not installed)', () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-hk-'));
    const f = join(d, 'hk.ahk');
    writeFileSync(f, renderHotkeyScript(hotkeyTemplate(), v));
    const win = execFileSync('wslpath', ['-w', f], { encoding: 'utf8' }).trim();
    expect(() => execFileSync(AHK, ['/ErrorStdOut', '/Validate', win], { encoding: 'utf8', timeout: 15000 })).not.toThrow();
  });
});

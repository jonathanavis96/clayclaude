import { describe, it, expect } from 'vitest';
import { DEMO_PORT, DEMO_USAGE, parseDemoArgs } from '../src/commands/demo.js';

describe('parseDemoArgs', () => {
  it('has sane defaults and parses flags', () => {
    expect(parseDemoArgs([])).toEqual({ port: 8421, scenario: 'board', speed: 1, adb: false, kiosk: false });
    expect(parseDemoArgs(['--port', '8000', '--scenario', 'gallery', '--speed', '30', '--adb'])).toEqual({ port: 8000, scenario: 'gallery', speed: 30, adb: true, kiosk: false });
    expect(parseDemoArgs(['--kiosk'])).toMatchObject({ adb: true, kiosk: true });
    expect(parseDemoArgs(['--sessions', '30'])).toMatchObject({ sessions: 30 });
  });
  it('defaults to 8421, never the daemon\'s 8420, so a demo started next to a running daemon does not collide', () => {
    expect(DEMO_PORT).toBe(8421);
    expect(DEMO_USAGE).toContain('default 8421');
  });
  it('rejects bad values', () => {
    expect(() => parseDemoArgs(['--port', 'x'])).toThrow();
    expect(() => parseDemoArgs(['--speed', '0'])).toThrow();
    expect(() => parseDemoArgs(['--scenario', 'zoo'])).toThrow();
    expect(() => parseDemoArgs(['--sessions', '0'])).toThrow(/--sessions/);
    expect(() => parseDemoArgs(['--sessions', '61'])).toThrow(/--sessions/);
    expect(() => parseDemoArgs(['--sessions', '2.5'])).toThrow(/--sessions/);
  });
  it('refuses unknown options and missing values, so a typo never falls back to the default port', () => {
    expect(() => parseDemoArgs(['--prot', '7453'])).toThrow(/unknown option "--prot"/);
    expect(() => parseDemoArgs(['7453'])).toThrow(/unknown option "7453"/);
    expect(() => parseDemoArgs(['--port'])).toThrow(/--port needs a value/);
    expect(() => parseDemoArgs(['--port', '--adb'])).toThrow(/--port needs a value/);
  });
});

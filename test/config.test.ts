import { describe, it, expect } from 'vitest';
import { parseConfig, parseDuration } from '../src/config.js';

const minimal = `
hosts:
  - id: local
accounts:
  - id: me
    label: Me
    colour: "#e8b54a"
    host: local
    configDir: ~/.claude
`;

describe('config', () => {
  it('applies defaults and expands ~ in configDir', () => {
    const c = parseConfig(minimal, '/home/u');
    expect(c.port).toBe(8420);
    expect(c.cacheTtlMinutes).toBe(60);
    expect(c.stoppedRetentionMs).toBe(3 * 3600_000);
    expect(c.accounts[0].configDir).toBe('/home/u/.claude');
    expect(c.accounts[0].usage).toEqual({ provider: 'oauth', refresh: true });
    expect(c.contextWindows.default).toBe(200000);
  });
  it('keeps remote configDir ~ unexpanded (expanded on the host)', () => {
    const c = parseConfig(`
hosts: [{id: local}, {id: box, ssh: box}]
accounts: [{id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w}]
`, '/home/u');
    expect(c.accounts[0].configDir).toBe('~/.claude-w');
  });
  it('rejects an account on an unknown host', () => {
    expect(() => parseConfig(`
hosts: [{id: local}]
accounts: [{id: w, label: W, colour: "#fff", host: nope, configDir: ~/.c}]
`)).toThrow(/unknown host "nope"/);
  });
  it('has no tablet.screenTimeoutMs: nothing ever read it (setup sets 30 min itself), and an old config holding it still loads', () => {
    expect(Object.keys(parseConfig(minimal).tablet)).not.toContain('screenTimeoutMs');
    expect(parseConfig(minimal + 'tablet: {adb: adb, screenTimeoutMs: 60000}\n').tablet.adb).toBe('adb');
  });
  it('parses durations', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('45m')).toBe(2_700_000);
    expect(parseDuration('3h')).toBe(10_800_000);
    expect(() => parseDuration('3 days')).toThrow();
  });
});

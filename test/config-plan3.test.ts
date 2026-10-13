import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';

const base = `
hosts: [{id: local}]
accounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: ~/.claude}]
`;

describe('config (plan 3 keys)', () => {
  it('fills defaults for open, launch, lan, ui, terminal', () => {
    const c = parseConfig(base, '/home/u');
    expect(c.accounts[0].open).toEqual({ type: 'tmux' });
    expect(c.launch.models).toEqual([]);   // Task 46: optional extras; the real list comes from each account
    expect(c.launch.allowBypassPermissions).toBe(false);
    expect(c.launch.defaultMode).toBe('auto');   // Task 47: + New preselects Auto
    expect(c.lan).toEqual({ enabled: false, hosts: [] });
    expect(c.ui.quickReplies).toEqual(['yes', 'no', 'continue']);
    expect(c.terminal).toEqual({ type: 'wt', bin: 'wt.exe' });
    expect(c.appLink).toBe('claude://code/{id}');
    expect(c.hosts[0].claudeBin).toBe('claude');
    expect(c.tablet.chromePackage).toBe('com.android.chrome');
  });
  it('Task 46: launch.models extras are still checked (aliases and [1m] ids pass), and bypass is a boolean', () => {
    expect(parseConfig(base + 'launch: {models: [opus, fable, "claude-opus-5-5[1m]"], allowBypassPermissions: true}\n').launch)
      .toMatchObject({ models: ['opus', 'fable', 'claude-opus-5-5[1m]'], allowBypassPermissions: true });
    expect(() => parseConfig(base + 'launch: {models: ["x; id"]}\n')).toThrow();
    expect(() => parseConfig(base + 'launch: {allowBypassPermissions: "yes"}\n')).toThrow();
  });
  it('Task 47: launch.defaultMode is a known mode; bypassPermissions only with allowBypassPermissions', () => {
    for (const m of ['manual', 'acceptEdits', 'auto', 'plan', 'dontAsk']) expect(parseConfig(base + `launch: {defaultMode: ${m}}\n`).launch.defaultMode).toBe(m);
    expect(() => parseConfig(base + 'launch: {defaultMode: yolo}\n')).toThrow();
    expect(() => parseConfig(base + 'launch: {defaultMode: bypassPermissions}\n')).toThrow(/defaultMode: bypassPermissions needs launch\.allowBypassPermissions: true/);
    expect(() => parseConfig(base + 'launch: {defaultMode: bypassPermissions, allowBypassPermissions: false}\n')).toThrow(/allowBypassPermissions/);
    expect(parseConfig(base + 'launch: {defaultMode: bypassPermissions, allowBypassPermissions: true}\n').launch.defaultMode).toBe('bypassPermissions');
  });
  it('parses chrome and app open actions', () => {
    const c = parseConfig(`
hosts: [{id: local}]
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /x, open: {type: chrome, profileDirectory: "Profile 2", incognito: true}}
  - {id: b, label: B, colour: "#fff", host: local, configDir: /y, open: {type: app}}
`);
    expect(c.accounts[0].open).toEqual({ type: 'chrome', browser: 'chrome', profileDirectory: 'Profile 2', incognito: true });
    expect(c.accounts[1].open).toEqual({ type: 'app' });
  });
  it('rejects a profile directory with shell characters and unknown open types', () => {
    expect(() => parseConfig(base.replace('~/.claude}]', '~/.claude, open: {type: chrome, profileDirectory: "a; rm"}}]'))).toThrow();
    expect(() => parseConfig(base.replace('~/.claude}]', '~/.claude, open: {type: shell}}]'))).toThrow();
  });
  it('requires a token when LAN is enabled', () => {
    expect(() => parseConfig(base + 'lan: {enabled: true}\n')).toThrow(/lan.token/);
    expect(() => parseConfig(base + `lan: {enabled: true, token: "${'a'.repeat(24)}"}\n`)).toThrow(/lan.hosts/);
    expect(() => parseConfig(base + `lan: {enabled: true, token: "${'a'.repeat(24)}", hosts: ["*"]}\n`)).toThrow();
    expect(parseConfig(base + `lan: {enabled: true, token: "${'a'.repeat(24)}", hosts: ["192.168.1.20", "pc.local"]}\n`).lan.enabled).toBe(true);
  });
  it('rejects an app link without {id} and a bad hotkey', () => {
    expect(() => parseConfig(base + 'appLink: "claude://code/x"\n')).toThrow();
    expect(() => parseConfig(base + 'hotkey: "#+t; Run"\n')).toThrow();
  });
  it('rejects an ssh alias that looks like an option and a tmux session name tmux would rewrite', () => {
    const host = (h: string) => `hosts: [{id: local}, ${h}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]\n`;
    expect(() => parseConfig(host('{id: b, ssh: "-oProxyCommand=touch /tmp/x"}'))).toThrow(/ssh/);
    expect(() => parseConfig(host('{id: b, ssh: "a b"}'))).toThrow(/ssh/);
    expect(parseConfig(host('{id: b, ssh: "me@build-box.lan"}')).hosts[1].ssh).toBe('me@build-box.lan');
    expect(() => parseConfig(host('{id: b, ssh: b, tmuxSession: "a:b"}'))).toThrow(/tmuxSession/);
    expect(() => parseConfig(host('{id: b, ssh: b, tmuxSession: "-x"}'))).toThrow(/tmuxSession/);
    expect(parseConfig(host('{id: b, ssh: b, tmuxSession: "my agents"}')).hosts[1].tmuxSession).toBe('my agents');
  });
});

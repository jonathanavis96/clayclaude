import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { appCmd, attachArgv, attachScript, chromeCmd, launchDetached, terminalCmd } from '../src/actions/open.js';
import { parseTmuxRef } from '../src/actions/validate.js';

const cfg = parseConfig(`
hosts: [{id: local}, {id: box, ssh: boxalias}]
browsers: { chrome: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe" }
accounts:
  - {id: a, label: A, colour: "#fff", host: local, configDir: /x, open: {type: chrome, profileDirectory: "Profile 2", incognito: true}}
  - {id: b, label: B, colour: "#fff", host: box, configDir: ~/.c, open: {type: app}}
`, '/home/u');
const ref = parseTmuxRef('main:@1.%1')!;
const wsl = { kind: 'wsl' as const, distro: 'Ubuntu' };

describe('open commands', () => {
  it('builds the chrome command line', () => {
    expect(chromeCmd(cfg, cfg.accounts[0], 'session_abc123')).toEqual({
      bin: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
      args: ['--profile-directory=Profile 2', '--incognito', 'https://claude.ai/code/session_abc123'] });
  });
  it('refuses a missing or malformed bridge id and an unconfigured browser', () => {
    expect(() => chromeCmd(cfg, cfg.accounts[0], undefined)).toThrow(/no remote-control/);
    expect(() => chromeCmd(cfg, cfg.accounts[0], 'session_x"; calc')).toThrow(/malformed/);
    expect(() => chromeCmd({ ...cfg, browsers: {} }, cfg.accounts[0], 'session_abc123')).toThrow(/browser/);
  });
  it('opens the desktop app with its claude:// link through the OS opener', () => {
    expect(appCmd(cfg, wsl, 'session_abc123')).toEqual({ bin: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', 'claude://code/session_abc123'] });
    expect(appCmd(cfg, { kind: 'darwin' }, 'cse_abc123').bin).toBe('open');
    expect(appCmd({ ...cfg, appLink: 'https://claude.ai/code/{id}' }, { kind: 'linux' }, 'session_abc123'))
      .toEqual({ bin: 'xdg-open', args: ['https://claude.ai/code/session_abc123'] });
  });
  it('attach script has no semicolons and quotes the session name', () => {
    const s = attachScript(parseTmuxRef("my agents:@2.%7")!);
    expect(s).toBe(`tmux select-window -t @2 2>/dev/null && tmux select-pane -t %7 2>/dev/null || true && exec tmux attach -t 'my agents'`);
    expect(s).not.toContain(';');
  });
  it('wraps attach for WSL, and for ssh hosts', () => {
    expect(attachArgv(cfg.hosts[0], ref, wsl).slice(0, 5)).toEqual(['wsl.exe', '-d', 'Ubuntu', '-e', 'bash']);
    const remote = attachArgv(cfg.hosts[1], ref, wsl);
    expect(remote.at(-1)).toMatch(/^exec 'ssh' '-t' 'boxalias' '/);
    expect(remote.at(-1)).not.toContain(';');
  });
  it('builds the Windows Terminal command', () => {
    const c = terminalCmd(cfg, cfg.hosts[0], ref, wsl, 'orchard; calc');
    expect(c.bin).toBe('wt.exe');
    expect(c.args.slice(0, 5)).toEqual(['-w', '0', 'new-tab', '--title', 'orchard  calc']);
    expect(c.args[5]).toBe('--');
    expect(() => terminalCmd(cfg, cfg.hosts[0], ref, { kind: 'linux' }, 't')).toThrow(/template/);
    expect(terminalCmd(cfg, cfg.hosts[0], ref, wsl, 'a"b\\c`$(d)').args[4]).toBe('a b c  (d)');
  });
  it('supports a terminal template', () => {
    const t = { ...cfg, terminal: { type: 'template' as const, bin: 'x', template: ['gnome-terminal', '--', '{argv}'] } };
    const c = terminalCmd(t, cfg.hosts[0], ref, { kind: 'linux' }, 'T');
    expect(c.bin).toBe('gnome-terminal');
    expect(c.args.slice(0, 3)).toEqual(['--', 'bash', '-lc']);
  });
  // The title is the session's name, which may be Claude's own AI title for the conversation. A template may put
  // {title} inside a shell string, and String.replace reads $' $` $& in the replacement as patterns.
  it('puts only plain characters of the title into a template, and no replacement patterns', () => {
    const t = { ...cfg, terminal: { type: 'template' as const, bin: 'x', template: ['sh', '-c', 'xterm -T "{title}" -e {script}'] } };
    const c = terminalCmd(t, cfg.hosts[0], ref, { kind: 'linux' }, `x"; touch pwned; "$(id)\\`);
    expect(c.args[1].startsWith('xterm -T "x   touch pwned    (id) " -e ')).toBe(true);
    const u = { ...cfg, terminal: { type: 'template' as const, bin: 'x', template: ['term', '--title=[{title}]', '{argv}'] } };
    expect(terminalCmd(u, cfg.hosts[0], ref, { kind: 'linux' }, "a$'b$&c").args[0]).toBe('--title=[a  b  c]');
  });
});

describe('launchDetached', () => {
  const node = process.execPath;
  it('reports success, a failing exit with its first stderr line, and a missing binary', async () => {
    expect(await launchDetached({ bin: node, args: ['-e', '0'] })).toEqual({ ok: true });
    expect(await launchDetached({ bin: node, args: ['-e', 'console.error("bad profile\\nmore");process.exit(2)'] })).toEqual({ ok: false, error: 'bad profile' });
    const r = await launchDetached({ bin: 'no-such-gui-xyz', args: [] });
    expect(r).toEqual({ ok: false, error: 'no-such-gui-xyz: not found' });
  });
  it('leaves a long-running program running', async () => {
    expect(await launchDetached({ bin: node, args: ['-e', 'setTimeout(()=>{},1500)'] })).toEqual({ ok: true });
  });
});

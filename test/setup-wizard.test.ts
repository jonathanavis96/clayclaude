import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { parseConfig } from '../src/config.js';
import { makeExec } from '../src/actions/exec.js';
import { configErrorText, runSetup } from '../src/setup/wizard.js';
import { planHooks } from '../src/hooks/install.js';
import { PROBE } from './helpers/probe.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';
import { scripted } from './helpers/scripted-prompter.js';

const run = promisify(execFile);
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-wiz-'));

/** Two fake machines, each just a temp $HOME. The "remote" one is reached through a fake ssh. */
function world() {
  const local = tmp(), remote = tmp();
  mkdirSync(join(local, '.claude', 'sessions'), { recursive: true });
  writeFileSync(join(local, '.claude', 'sessions', '1.json'), '{"pid":1}');
  writeFileSync(join(local, '.claude', 'settings.json'), '{"model":"opus"}');
  mkdirSync(join(local, '.ssh'));
  writeFileSync(join(local, '.ssh', 'config'), 'Host box\n  HostName 10.0.0.9\nHost *\n  ServerAliveInterval 30\n');
  mkdirSync(join(remote, '.claude-work'));
  writeFileSync(join(remote, '.claude-work', '.credentials.json'), '{"claudeAiOauth":{"accessToken":"SECRET-DO-NOT-LEAK"}}');
  writeFileSync(join(remote, '.claude-work', '.claude.json'), '{"oauthAccount":{"emailAddress":"w@example.test"}}');
  const fake = makeFakeSsh(remote);
  const probe = async (host: { ssh?: string }, req: object) => {
    const home = host.ssh ? remote : local;
    return JSON.parse((await run('python3', [PROBE, JSON.stringify(req)], { env: { ...process.env, HOME: home } })).stdout);
  };
  const adbCalls: string[][] = [];
  const deps = (p: ReturnType<typeof scripted>['p']) => ({
    prompt: p, home: local, configPath: join(local, '.config', 'clayclaude', 'config.yaml'), platform: { kind: 'linux' as const },
    exec: makeExec({ sshBin: fake.bin }), probe,
    readText: async (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : null), fileExists: existsSync,
    runLocal: async (_b: string, argv: string[]) => { adbCalls.push(argv); return { code: 0, stdout: argv[0] === 'devices' ? 'List of devices attached\nSER1\tdevice\n' : '', stderr: '' }; },
    interfaces: () => ['192.168.1.20'], now: () => Date.parse('2026-10-12T10:11:12Z'),
  });
  return { local, remote, deps, adbCalls };
}

describe('runSetup (all in temp directories)', () => {
  it('discovers both machines, writes a config the loader accepts, installs hooks with backups, sets up the tablet and LAN', async () => {
    const w = world();
    const s = scripted([
      [/Which ssh hosts/, ['box']],
      [/Another tool|another tool/, true],               // the work account is refreshed elsewhere
      [/Apply these changes/, true],
      [/Allow other devices/, true],
    ]);
    const r = await runSetup(w.deps(s.p));
    const cfg = parseConfig(readFileSync(r.written, 'utf8'), w.local);
    expect(cfg.hosts.map((h) => h.id)).toEqual(['local', 'box']);
    expect(cfg.accounts.map((a) => [a.id, a.host, a.configDir])).toEqual([['main', 'local', join(w.local, '.claude')], ['work', 'box', '~/.claude-work']]);
    expect(cfg.accounts[1].usage).toEqual({ provider: 'oauth', refresh: false });
    expect(cfg.lan).toMatchObject({ enabled: true, hosts: ['192.168.1.20'] });
    expect(cfg.lan.token).toHaveLength(32);
    expect(cfg.tablet.serial).toBe('SER1');
    // hooks went into both fake homes, with backups, and only there
    for (const dir of [join(w.local, '.claude'), join(w.remote, '.claude-work')]) {
      expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).hooks.Notification).toHaveLength(1);
      expect(existsSync(join(dir, 'clayclaude', 'hook.py'))).toBe(true);
    }
    // the local account had a settings.json, so it was backed up; the remote one had none, so there is nothing to back up
    expect(readdirSync(join(w.local, '.claude')).some((n) => n.startsWith('settings.json.bak-clayclaude-'))).toBe(true);
    expect(readdirSync(join(w.remote, '.claude-work')).some((n) => n.includes('.bak-'))).toBe(false);
    expect(JSON.parse(readFileSync(join(w.local, '.claude', 'settings.json'), 'utf8')).model).toBe('opus');
    // the tablet commands that ran
    expect(w.adbCalls.map((a) => a.join(' '))).toContain('-s SER1 reverse tcp:8420 tcp:8420');
    expect(w.adbCalls.map((a) => a.join(' '))).toContain('-s SER1 shell settings put system screen_off_timeout 1800000');
    expect(w.adbCalls.map((a) => a.join(' '))).toContain('-s SER1 shell settings put global stay_on_while_plugged_in 7');
    expect(w.adbCalls.map((a) => a.join(' '))).toContain('-s SER1 shell cmd package query-activities --brief -a android.content.pm.action.CONFIRM_PIN_SHORTCUT');
    // the LAN token is shown once; credentials are never printed
    expect(s.text()).toContain(cfg.lan.token!);
    expect(s.text()).not.toContain('SECRET-DO-NOT-LEAK');
    expect(readFileSync(r.written, 'utf8')).not.toContain('SECRET-DO-NOT-LEAK');
  });

  it('keeps the port already in the config and uses it everywhere it names one (reverse, kiosk query, LAN hint)', async () => {
    const w = world();
    mkdirSync(join(w.local, '.config', 'clayclaude'), { recursive: true });
    writeFileSync(join(w.local, '.config', 'clayclaude', 'config.yaml'), 'port: 8455   # outside a reserved range\n');
    const hk = join(w.local, 'hk.ahk');
    const s = scripted([[/Allow other devices/, true], [/hotkey that hands/, true], [/Where should the script/, hk]]);
    const d = w.deps(s.p);
    const calls: string[] = [];
    const r = await runSetup({ ...d, platform: { kind: 'win32' as const }, runLocal: async (b: string, argv: string[]) => {
      calls.push(argv.join(' '));
      if (argv.includes('android.content.pm.action.CONFIRM_PIN_SHORTCUT')) return { code: 0, stdout: 'com.launcher/.PinActivity\n', stderr: '' };
      return d.runLocal(b, argv);
    } });
    expect(calls).toContain('-s SER1 reverse tcp:8455 tcp:8455');
    expect(calls.some((c) => c.endsWith('-d http://localhost:8455/#kiosk'))).toBe(true);
    expect(s.text()).toContain('http://<address>:8455/');
    // The hotkey names no URL: it brings Chrome's open board tab forward, since loading the URL would reload the board.
    expect(readFileSync(hk, 'utf8')).not.toContain('http://');
    expect(calls.join('\n') + s.text() + readFileSync(hk, 'utf8')).not.toMatch(/\b(7420|8420)\b/);
    expect(parseConfig(readFileSync(r.written, 'utf8'), w.local).port).toBe(8455);
  });

  it('changes nothing when the user declines every confirmation', async () => {
    const w = world();
    const before = readFileSync(join(w.local, '.claude', 'settings.json'), 'utf8');
    const s = scripted([[/^Add /, false], [/Write the config/, false]]);
    const r = await runSetup(w.deps(s.p));
    expect(r.written).toBe('');
    expect(existsSync(join(w.local, '.config'))).toBe(false);
    expect(readFileSync(join(w.local, '.claude', 'settings.json'), 'utf8')).toBe(before);
    expect(existsSync(join(w.remote, '.claude-work', 'settings.json'))).toBe(false);
  });

  it('keeps the previous config as a backup when setup is re-run', async () => {
    const w = world();
    const first = await runSetup(w.deps(scripted().p));
    const second = await runSetup(w.deps(scripted().p));
    expect(second.backup).toBeDefined();
    expect(readFileSync(second.backup!, 'utf8')).toBe(readFileSync(first.written, 'utf8'));
  });

  it('skips a host it cannot reach and still finishes', async () => {
    const w = world();
    const d = w.deps(scripted([[/Which ssh hosts/, ['box']]]).p);
    const s = scripted([[/Which ssh hosts/, ['box']]]);
    const r = await runSetup({ ...d, prompt: s.p, probe: async (h: { ssh?: string }, req: object) => { if (h.ssh) throw new Error('ssh: connect timed out'); return d.probe(h, req); } });
    expect(s.text()).toContain('could not look (ssh: connect timed out)');
    expect(parseConfig(readFileSync(r.written, 'utf8'), w.local).accounts).toHaveLength(1);
  });

  it('does not let a typed ssh alias take the id of this PC', async () => {
    const w = world();
    const s = scripted([[/Other ssh host aliases/, 'local, box']]);
    const r = await runSetup(w.deps(s.p));
    expect(s.text()).toContain('"local" is the name of this PC');
    expect(parseConfig(readFileSync(r.written, 'utf8'), w.local).hosts.map((h) => h.id)).toEqual(['local', 'box']);
  });

  it('refreshes a missing hook.py when settings.json already has the hooks, leaving settings.json alone', async () => {
    const w = world();
    const dir = join(w.local, '.claude');
    const text = JSON.stringify(planHooks({ model: 'opus' }).next, null, 2) + '\n';
    writeFileSync(join(dir, 'settings.json'), text);   // e.g. a settings.json shared from a dotfiles repo
    const s = scripted();
    await runSetup(w.deps(s.p));
    expect(existsSync(join(dir, 'clayclaude', 'hook.py'))).toBe(true);
    expect(readFileSync(join(dir, 'settings.json'), 'utf8')).toBe(text);
    expect(readdirSync(dir).some((n) => n.includes('.bak-'))).toBe(false);
    expect(s.text()).toContain('Hooks are already installed');
  });

  it('says when settings.json is a symlink that other accounts may share, and keeps the link', async () => {
    const w = world();
    const dir = join(w.local, '.claude');
    const shared = join(w.local, 'dotfiles-settings.json');
    renameSync(join(dir, 'settings.json'), shared);
    symlinkSync(shared, join(dir, 'settings.json'));
    const s = scripted([[/Apply these changes/, true]]);
    await runSetup(w.deps(s.p));
    expect(s.text()).toContain(`symlink to ${shared}`);
    expect(lstatSync(join(dir, 'settings.json')).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(shared, 'utf8')).hooks.Stop).toHaveLength(1);
  });

  it('re-asks for a Chrome profile directory the config would reject', async () => {
    const w = world();
    const answers = ['Profile (2)', 'Profile 2'];
    const s = scripted([[/What should "Open" do/, 'chrome'], [/Chrome profile directory/, () => answers.shift()]]);
    const r = await runSetup(w.deps(s.p));
    expect(s.text()).toMatch(/profile directory.*letters, digits/i);
    const cfg = parseConfig(readFileSync(r.written, 'utf8'), w.local);
    expect(cfg.accounts[0].open).toMatchObject({ type: 'chrome', profileDirectory: 'Profile 2' });
  });

  it('re-asks for a usage URL the config would reject, and falls back to the default if it never gets one', async () => {
    const w = world();
    const s = scripted([[/usage figures/, 'http'], [/\/usage URL/, 'not a url']]);
    const r = await runSetup(w.deps(s.p));
    expect(s.asked.filter((q) => /\/usage URL/.test(q)).length).toBeGreaterThan(1);
    const cfg = parseConfig(readFileSync(r.written, 'utf8'), w.local);
    expect(cfg.accounts[0].usage).toEqual({ provider: 'http', url: 'http://localhost:8790/usage', key: 'main' });
  });

  it('does not offer a tablet whose serial the config would reject', async () => {
    const w = world();
    const long = 'X'.repeat(70);
    const s = scripted();
    const r = await runSetup({ ...w.deps(s.p), runLocal: async () => ({ code: 0, stdout: `List of devices attached\n${long}\tdevice\n`, stderr: '' }) });
    expect(s.text()).toContain('No authorised tablet found');
    expect(parseConfig(readFileSync(r.written, 'utf8'), w.local).tablet.serial).toBeUndefined();
  });

  describe('which adb (one adb server only)', () => {
    /** Each fake adb path prints its own `devices` output; every call is recorded with the binary it went to. */
    /** nativeListening: the fake /proc/net/tcp has a Linux socket listening on the (test) adb port. Never the real table or 5037. */
    function adbWorld(seen: Record<string, boolean>, nativeListening: boolean, adbPort = 45037) {
      const w = world();
      const calls: string[] = [];
      const runLocal = async (bin: string, argv: string[], o?: { timeoutMs?: number }) => {
        calls.push(`${bin} ${argv.join(' ')}${argv[0] === 'devices' ? ` timeout=${o?.timeoutMs}` : ''}`);
        return { code: 0, stdout: argv[0] === 'devices' ? `List of devices attached\n${seen[bin] ? 'SER1\tdevice\n' : ''}` : '', stderr: '' };
      };
      const procNetTcp = () => `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:${adbPort.toString(16).toUpperCase().padStart(4, '0')} 00000000:0000 ${nativeListening ? '0A' : '01'} 00000000:00000000 00:00000000 00000000  1000        0 1 1 0 100 0 0 10 0\n`;
      return { w, calls, deps: (p: ReturnType<typeof scripted>['p'], platform: 'wsl' | 'linux' = 'wsl') => ({ ...w.deps(p), platform: { kind: platform }, runLocal, adbCandidates: () => Object.keys(seen), adbPort, procNetTcp }) };
    }
    /** A throwaway loopback listener: something answers on the port that is not a Linux adb server. Never the real 5037. */
    async function listener(): Promise<{ port: number; close: () => void }> {
      const server = createServer((c) => c.destroy());
      await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
      return { port: (server.address() as { port: number }).port, close: () => server.close() };
    }
    const NATIVE = '/usr/bin/adb', WIN = '/mnt/c/Users/jo/AppData/Local/Android/Sdk/platform-tools/adb.exe';

    it('writes the full path of the adb that sees the tablet, asking each with a 5 s timeout', async () => {
      const a = adbWorld({ [NATIVE]: false, [WIN]: true }, true);
      const s = scripted();
      const r = await runSetup(a.deps(s.p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(WIN);
      expect(a.calls).toContain(`${NATIVE} devices timeout=5000`);
      expect(a.calls).toContain(`${WIN} devices timeout=5000`);
      expect(a.calls.some((c) => /kill[-]server|start-server/.test(c))).toBe(false);
      expect(a.calls.filter((c) => c.startsWith(NATIVE))).toEqual([`${NATIVE} devices timeout=5000`]);
    });

    it('when both see it: the configured one, else the Windows one under WSL', async () => {
      let a = adbWorld({ [NATIVE]: true, [WIN]: true }, true);
      let r = await runSetup(a.deps(scripted().p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(WIN);
      a = adbWorld({ [NATIVE]: true, [WIN]: true }, true);
      mkdirSync(join(a.w.local, '.config', 'clayclaude'), { recursive: true });
      writeFileSync(join(a.w.local, '.config', 'clayclaude', 'config.yaml'), `tablet:\n  adb: ${NATIVE}\n`);
      r = await runSetup(a.deps(scripted().p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(NATIVE);
    });

    it('under WSL never runs the Linux adb while its server is down (`devices` would start one), not even the one it keeps', async () => {
      let a = adbWorld({ [NATIVE]: true, [WIN]: true }, false);
      let s = scripted();
      let r = await runSetup(a.deps(s.p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(WIN);
      expect(a.calls.filter((c) => c.startsWith(NATIVE))).toEqual([]);
      expect(a.calls).toContain(`${WIN} devices timeout=5000`);
      expect(s.text()).toMatch(new RegExp(`${NATIVE}: Linux adb server not running`));
      // the configured Linux adb is kept as the default, but setup still does not run it
      a = adbWorld({ [NATIVE]: true, [WIN]: false }, false);
      mkdirSync(join(a.w.local, '.config', 'clayclaude'), { recursive: true });
      writeFileSync(join(a.w.local, '.config', 'clayclaude', 'config.yaml'), `tablet:\n  adb: ${NATIVE}\n`);
      s = scripted();
      r = await runSetup(a.deps(s.p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(NATIVE);
      expect(a.calls.filter((c) => c.startsWith(NATIVE))).toEqual([]);
      expect(s.text()).toMatch(/does not start one under WSL/);
    });

    it('under WSL never runs the Linux adb when the port answers but no Linux socket listens (mirrored networking: the Windows server)', async () => {
      const up = await listener();
      try {
        const a = adbWorld({ [NATIVE]: true, [WIN]: false }, false, up.port);
        mkdirSync(join(a.w.local, '.config', 'clayclaude'), { recursive: true });
        writeFileSync(join(a.w.local, '.config', 'clayclaude', 'config.yaml'), `tablet:\n  adb: ${NATIVE}\n`);
        const s = scripted();
        const r = await runSetup(a.deps(s.p));
        expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(NATIVE);
        expect(a.calls.filter((c) => c.startsWith(NATIVE))).toEqual([]);
        expect(s.text()).toMatch(new RegExp(`${NATIVE}: Linux adb server not running`));
        expect(s.text()).toMatch(/does not start one under WSL/);
      } finally { up.close(); }
    });

    it('outside WSL the Linux adb is asked as before (it is the only adb server there)', async () => {
      const a = adbWorld({ [NATIVE]: true }, false);
      const r = await runSetup(a.deps(scripted().p, 'linux'));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe(NATIVE);
      expect(a.calls).toContain(`${NATIVE} devices timeout=5000`);
    });

    it('when none sees it, keeps the default and says how to check', async () => {
      const a = adbWorld({ [NATIVE]: false, [WIN]: false }, false);
      const s = scripted();
      const r = await runSetup(a.deps(s.p));
      expect(parseConfig(readFileSync(r.written, 'utf8'), a.w.local).tablet.adb).toBe('adb');
      expect(s.text()).toContain(`${WIN} devices`);
      expect(s.text()).toMatch(/only one adb server/i);
    });
  });

  it('describes a config the loader rejects by field, not by the first line of the error', () => {
    let err: unknown;
    try { parseConfig('hosts: [{ id: local }]\naccounts: [{ id: a, label: A, colour: red, host: local, configDir: x }]\n', '/h'); } catch (e) { err = e; }
    expect(configErrorText(err)).toMatch(/^accounts\.0\.colour: /);
  });
});

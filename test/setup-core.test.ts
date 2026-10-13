import { afterAll, describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, statSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChromeProfiles, chromePaths } from '../src/setup/chrome.js';
import { sshAliases } from '../src/setup/sshconfig.js';
import { serializeConfig, writeConfigFile } from '../src/setup/configwrite.js';
import { NO_INSTALL_NOTE, PIN_SHORTCUT_QUERY, PWA_GUIDANCE, launcherCanPin, parseAdbDevices, runTabletPlan, tabletPlan, webApkQuery } from '../src/setup/tablet.js';
import { parseConfig } from '../src/config.js';
import { localIO, remoteIO, type ConfigIO } from '../src/hooks/install.js';
import { makeExec } from '../src/actions/exec.js';
import { makeFakeSsh } from './helpers/fake-ssh.js';

const dirs: string[] = [];
const tmp = (prefix = 'cc-cfg-') => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// Invented profile data in the shape of Chrome's Local State file.
const LOCAL_STATE = JSON.stringify({ profile: { info_cache: {
  'Profile 10': { name: 'Tenth' }, 'Profile 2': { name: 'Studio', user_name: 'studio@example.test' }, Default: { name: 'Person 1' },
  'Profile 1': { user_name: 'x@example.test' }, 'bad;dir': { name: 'Nope' },
} } });

describe('chrome profiles', () => {
  it('lists profile directories in natural order with names and emails', () => {
    expect(parseChromeProfiles(LOCAL_STATE)).toEqual([
      { dir: 'Default', name: 'Person 1' },
      { dir: 'Profile 1', name: 'Profile 1', email: 'x@example.test' },
      { dir: 'Profile 2', name: 'Studio', email: 'studio@example.test' },
      { dir: 'Profile 10', name: 'Tenth' },
    ]);
  });
  it('copes with garbage', () => {
    expect(parseChromeProfiles('not json')).toEqual([]);
    expect(parseChromeProfiles('{}')).toEqual([]);
  });
  it('knows where Chrome lives on each platform', () => {
    expect(chromePaths({ platform: 'wsl', home: '/home/u', winUser: 'sam' }).localState).toEqual(['/mnt/c/Users/sam/AppData/Local/Google/Chrome/User Data/Local State']);
    expect(chromePaths({ platform: 'win32', home: 'C:\\Users\\sam' }).localState[0]).toMatch(/User Data\\Local State$/);
    expect(chromePaths({ platform: 'darwin', home: '/Users/u' }).bin[0]).toContain('Google Chrome');
  });
});

describe('sshAliases', () => {
  it('returns concrete aliases only', () => {
    expect(sshAliases('Host build-box nas # comment\n  HostName x\nHost *\nHost *.corp !bad\nhost lab\n')).toEqual(['build-box', 'nas', 'lab']);
  });
  it('accepts the Keyword=value form ssh_config allows', () => {
    expect(sshAliases('Host=eq\nHost = spaced other\n\tHOST\ttabbed\nHostName=nothost\n')).toEqual(['eq', 'spaced', 'other', 'tabbed']);
  });
});

describe('config writing', () => {
  const draft = {
    port: 8420,
    hosts: [{ id: 'local' }, { id: 'box', ssh: 'box', tmuxSession: 'agents', repoRoots: ['~/code'] }],
    accounts: [{ id: 'work', label: 'Work', colour: '#4fd1c5', host: 'box', configDir: '~/.claude-work', usage: { provider: 'oauth', refresh: false }, open: { type: 'chrome', profileDirectory: 'Profile 2', incognito: true } }],
    browsers: { chrome: '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe' },
    lan: { enabled: true, token: 'x'.repeat(32), hosts: ['192.168.1.20'] },
  };
  it('round-trips through the loader', () => {
    const c = parseConfig(serializeConfig(draft), '/home/u');
    expect(c.accounts[0].open).toMatchObject({ type: 'chrome', profileDirectory: 'Profile 2', incognito: true });
    expect(c.accounts[0].usage).toEqual({ provider: 'oauth', refresh: false });
    expect(c.lan.hosts).toEqual(['192.168.1.20']);
  });
  it('writes with mode 0600 and backs up the previous file', async () => {
    const d = tmp();
    const path = join(d, 'sub', 'config.yaml');
    const io = localIO();
    expect((await writeConfigFile(io, path, 'a: 1\n')).backup).toBeUndefined();
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const r = await writeConfigFile(io, path, 'a: 2\n', Date.parse('2026-10-12T10:11:12Z'));
    expect(r.backup).toBe(`${path}.bak-20261012101112`);
    expect(readFileSync(r.backup!, 'utf8')).toBe('a: 1\n');
    expect(readFileSync(path, 'utf8')).toBe('a: 2\n');
  });
  it('tightens a pre-existing 0644 config, and its backup, to 0600', async () => {
    const d = tmp();
    const path = join(d, 'config.yaml');
    writeFileSync(path, 'lan: {token: old}\n');
    chmodSync(path, 0o644);
    const r = await writeConfigFile(localIO(), path, 'lan: {token: new}\n', Date.parse('2026-10-12T10:11:12Z'));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.backup!, 'utf8')).toBe('lan: {token: old}\n');
    expect(readFileSync(path, 'utf8')).toBe('lan: {token: new}\n');
  });
  it('tightens a pre-existing 0644 config to 0600 on a "remote" host too', async () => {
    const d = tmp();
    const path = join(d, 'my dir', 'config.yaml');
    const host = { id: 'box', ssh: 'box', tmuxSession: 's', repoRoots: [], claudeBin: 'claude' };
    const io = remoteIO(host, makeExec({ sshBin: makeFakeSsh(tmp('cc-fakessh-home-')).bin }));
    await writeConfigFile(io, path, 'a: 1\n');
    chmodSync(path, 0o644);
    const r = await writeConfigFile(io, path, 'a: 2\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(r.backup!).mode & 0o777).toBe(0o600);
    expect(readFileSync(r.backup!, 'utf8')).toBe('a: 1\n');
  });
  it('never overwrites an earlier backup made in the same second', async () => {
    const d = tmp();
    const path = join(d, 'config.yaml');
    const now = Date.parse('2026-10-12T10:11:12Z');
    writeFileSync(path, 'original\n');
    const r1 = await writeConfigFile(localIO(), path, 'second\n', now);
    const r2 = await writeConfigFile(localIO(), path, 'third\n', now);
    const r3 = await writeConfigFile(localIO(), path, 'fourth\n', now);
    expect(new Set([r1.backup, r2.backup, r3.backup]).size).toBe(3);
    expect(readFileSync(r1.backup!, 'utf8')).toBe('original\n');
    expect(readFileSync(r2.backup!, 'utf8')).toBe('second\n');
    expect(readFileSync(r3.backup!, 'utf8')).toBe('third\n');
  });
  it('creates the parent directory, not a directory named after the file', async () => {
    const made: string[] = [];
    const io: ConfigIO = { read: async () => null, write: async () => {}, copy: async () => {}, mkdirp: async (p) => { made.push(p); } };
    await writeConfigFile(io, 'config.yaml', 'a: 1\n');
    await writeConfigFile(io, '/config.yaml', 'a: 1\n');
    await writeConfigFile(io, '/home/u/.config/clayclaude/config.yaml', 'a: 1\n');
    expect(made).toEqual(['.', '/', '/home/u/.config/clayclaude']);
  });
});

describe('tablet plan', () => {
  const o = { adb: 'adb', serial: 'SER123', port: 8420, screenTimeoutMs: 1_800_000, chromePackage: 'com.android.chrome' };
  it('lists exactly the adb commands, scoped to the serial', () => {
    const p = tabletPlan(o);
    expect(p.map((s) => s.argv.slice(0, 5).join(' '))).toEqual([
      '-s SER123 reverse tcp:8420 tcp:8420', '-s SER123 shell settings put', '-s SER123 shell settings put', '-s SER123 shell settings put', '-s SER123 shell am start', '-s SER123 shell settings put']);
    expect(p[5].argv.slice(-3)).toEqual(['global', 'stay_on_while_plugged_in', '7']);
    expect(p[1].argv.slice(-2)).toEqual(['screen_off_timeout', '1800000']);
    expect(p[2].argv.slice(-2)).toEqual(['accelerometer_rotation', '0']);
    expect(p[3].argv.slice(-2)).toEqual(['user_rotation', '1']);
    expect(p[4].argv.slice(2)).toEqual(['shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', 'http://localhost:8420/', '-p', 'com.android.chrome']);
    expect(tabletPlan({ ...o, chromePackage: 'com.chrome.beta' })[4].argv.slice(-2)).toEqual(['-p', 'com.chrome.beta']);
    expect(tabletPlan({ ...o, serial: undefined })[0].argv).toEqual(['reverse', 'tcp:8420', 'tcp:8420']);
  });
  it('parses adb devices and runs the plan, reporting failures', async () => {
    expect(parseAdbDevices('List of devices attached\nSER123\tdevice\n* daemon started successfully\nOTHER\tunauthorized\n')).toEqual([{ serial: 'SER123', state: 'device' }, { serial: 'OTHER', state: 'unauthorized' }]);
    const r = await runTabletPlan('adb', tabletPlan(o).slice(0, 2), async (_b, argv) => (argv.includes('reverse') ? { code: 0, stderr: '' } : { code: 1, stderr: 'error: closed\nmore' }));
    expect(r).toEqual([{ title: 'Forward the board port over USB', ok: true }, { title: 'Screen timeout', ok: false, error: 'error: closed' }]);
    expect(PWA_GUIDANCE(8420)).toContain('Add to Home screen');
    expect(PWA_GUIDANCE(8420)).toContain('double-tap the clock');
    expect(PWA_GUIDANCE(8420)).not.toContain('⛶');
  });
  it('reads whether the launcher can take an installed app, and finds the installed board', () => {
    expect(launcherCanPin('No activities found\n')).toBe(false);
    expect(launcherCanPin('')).toBe(false);
    expect(launcherCanPin('priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\r\ncom.google.android.apps.nexuslauncher/com.android.launcher3.dragndrop.AddItemActivity\r\n')).toBe(true);
    expect(PIN_SHORTCUT_QUERY).toEqual(['shell', 'cmd', 'package', 'query-activities', '--brief', '-a', 'android.content.pm.action.CONFIRM_PIN_SHORTCUT']);
    expect(webApkQuery(8420).at(-1)).toBe('http://localhost:8420/#kiosk');
    expect(NO_INSTALL_NOTE).toContain('tablet.kiosk');
  });
});

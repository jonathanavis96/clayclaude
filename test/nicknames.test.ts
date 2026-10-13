import { describe, it, expect, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { request } from 'node:http';
import { chmodSync, lstatSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { adoptLaunchName, cleanNickname, NicknameStore, MAX_NICKNAME } from '../src/nicknames.js';
import { RENAME_WINDOW_SCRIPT } from '../src/actions/window-rename.js';
import { DismissedStore } from '../src/dismissed.js';
import { createActionService } from '../src/actions/service.js';
import { createActionRoutes } from '../src/actions/routes.js';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { generateToken } from '../src/security.js';
import { createDemo } from '../src/demo/index.js';

/**
 * Task 41: a board nickname per session, set from the tablet. It lives in the daemon's state.json beside the cleared
 * list (same key, same safe write), is served in /api/state as the session's name (the derived name kept beside it),
 * and never reaches the session itself: no keys, no tmux rename.
 */
const tmp = () => mkdtempSync(join(tmpdir(), 'cc-nick-'));
const NOW = Date.parse('2026-10-13T12:00:00Z');
const cfgText = `
hosts: [{id: local}, {id: box, ssh: box}]
accounts:
  - {id: me, label: Me, colour: "#fff", host: local, configDir: /c/me}
  - {id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w}
`;
const cfg = parseConfig(cfgText);
const S = (sid: string, over: object = {}) => ({ key: `box:w:${sid}`, host: 'box', account: 'w', sessionId: sid, pid: 1, name: `derived-${sid}`, cwd: '/x', state: 'working', stateSince: NOW, live: true,
  overContext: false, hostOnline: true, lastSeen: NOW, tmux: 'agents:@1.%1', ...over }) as any;

describe('cleanNickname', () => {
  it('trims, collapses whitespace and turns control characters into spaces', () => {
    expect(cleanNickname('  api  work ')).toEqual({ ok: true, name: 'api work' });
    expect(cleanNickname('a\nb\tc\u0007d\u2028e')).toEqual({ ok: true, name: 'a b c d e' });
    expect(cleanNickname('x\u0000\u001b[31my')).toEqual({ ok: true, name: 'x [31my' });
  });
  it('accepts 1 to 40 characters (counted as characters, not UTF-16 units) and refuses the rest', () => {
    expect(cleanNickname('a'.repeat(MAX_NICKNAME))).toMatchObject({ ok: true });
    expect(cleanNickname('a'.repeat(MAX_NICKNAME + 1))).toMatchObject({ ok: false });
    expect(cleanNickname('🦊'.repeat(MAX_NICKNAME))).toMatchObject({ ok: true });
    for (const bad of ['', '   ', '\n\t', '\u0000']) expect(cleanNickname(bad), JSON.stringify(bad)).toMatchObject({ ok: false });
  });
  it('refuses text-direction overrides and isolates (an RTL override could disguise the name)', () => {
    for (const ch of ['\u202A', '\u202B', '\u202C', '\u202D', '\u202E', '\u2066', '\u2067', '\u2068', '\u2069'])
      expect(cleanNickname(`ab${ch}cd`), ch.codePointAt(0)!.toString(16)).toMatchObject({ ok: false, message: expect.stringMatching(/direction/) });
  });
  it('keeps HTML-looking text as text (escaping is the board\'s job) and refuses non-strings', () => {
    expect(cleanNickname('<img src=x onerror=alert(1)>')).toEqual({ ok: true, name: '<img src=x onerror=alert(1)>' });
    expect(cleanNickname(42 as never)).toMatchObject({ ok: false });
  });
});

describe('NicknameStore', () => {
  it('sets, clears, persists in state.json (0600) and reloads', async () => {
    const path = join(tmp(), 'sub', 'state.json');
    const a = new NicknameStore(path);
    expect(a.get('box:w:a')).toBeUndefined();
    await a.set('box:w:a', 'api work');
    await a.set('box:w:b', 'docs');
    expect(a.get('box:w:a')).toBe('api work');
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, 'utf8')).nicknames).toEqual({ 'box:w:a': 'api work', 'box:w:b': 'docs' });
    await a.remove(['box:w:a', 'nope']);
    expect(a.get('box:w:a')).toBeUndefined();
    const b = new NicknameStore(path);
    expect(b.get('box:w:a')).toBeUndefined();
    expect(b.get('box:w:b')).toBe('docs');
  });
  it('shares state.json with the cleared list: neither store loses the other\'s keys', async () => {
    const path = join(tmp(), 'state.json');
    writeFileSync(path, JSON.stringify({ other: 1, dismissed: ['k1'] }), { mode: 0o644 });
    const names = new NicknameStore(path), dismissed = new DismissedStore(path);
    await names.set('k2', 'two');
    await dismissed.add(['k3']);
    await names.set('k4', 'four');
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ other: 1, dismissed: ['k1', 'k3'], nicknames: { k2: 'two', k4: 'four' } });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
  it('drops entries a hand-edited file got wrong, and survives a corrupt file', () => {
    const path = join(tmp(), 'state.json');
    writeFileSync(path, JSON.stringify({ nicknames: { ok: ' fine ', long: 'x'.repeat(99), rtl: 'a\u202Eb', num: 3, empty: '' } }));
    const s = new NicknameStore(path);
    expect(s.all()).toEqual({ ok: 'fine' });
    writeFileSync(path, '{not json');
    expect(new NicknameStore(path).all()).toEqual({});
    writeFileSync(path, JSON.stringify({ nicknames: ['a'] }));
    expect(new NicknameStore(path).all()).toEqual({});
  });
  it('never writes through a link planted at its temporary file', async () => {
    const d = tmp(), victim = join(d, 'victim');
    writeFileSync(victim, 'keep me\n');
    symlinkSync(victim, join(d, `state.json.${process.pid}.tmp`));
    const s = new NicknameStore(join(d, 'state.json'));
    await s.set('k', 'n');
    expect(readFileSync(victim, 'utf8')).toBe('keep me\n');
    expect(lstatSync(join(d, 'state.json')).isSymbolicLink()).toBe(false);
  });
  it('keeps only the newest names past its cap, and tells listeners when anything changes', async () => {
    const s = new NicknameStore(join(tmp(), 'state.json'), { max: 2 });
    let n = 0; s.on('update', () => n++);
    await s.set('a', 'A'); await s.set('b', 'B'); await s.set('c', 'C');
    expect(s.all()).toEqual({ b: 'B', c: 'C' });
    await s.remove(['zzz']);
    expect(n).toBe(3);
    await s.remove(['b']);
    expect(n).toBe(4);
  });
  it('without a path it keeps names in memory only (the demo)', async () => {
    const s = new NicknameStore(null);
    await s.set('k', 'n');
    expect(s.get('k')).toBe('n');
  });
  it('apply() shows the nickname as the name and keeps the derived one, without touching the input', () => {
    const s = new NicknameStore(null);
    void s.set('box:w:a', 'nick');
    const list = [S('a'), S('b')];
    const out = s.apply(list);
    expect(out.map((x) => [x.name, x.derivedName])).toEqual([['nick', 'derived-a'], ['derived-b', undefined]]);
    expect(list[0].name).toBe('derived-a');
  });
});

function service(list: any[]) {
  const dir = tmp();
  const store = new DismissedStore(join(dir, 'state.json'));
  const names = new NicknameStore(join(dir, 'state.json'));
  const probes: unknown[] = [];
  const exec: unknown[] = [];
  const svc = createActionService({ cfg, sessions: () => list.filter((s) => !store.has(s.key) || s.live),
    probe: async (_h, r: any) => { probes.push(r); return { ok: true, results: [] }; },
    exec: (async (...a: unknown[]) => { exec.push(a); return { code: 0, stdout: '', stderr: '' }; }) as never,
    gui: (async (...a: unknown[]) => { exec.push(a); return { ok: true }; }) as never,
    clear: { store, files: () => ({ configDir: '~/.claude-w', files: [] }), changed: () => {} }, names });
  return { svc, store, names, probes, exec };
}

describe('rename action (service)', () => {
  it('sets a cleaned nickname on a listed session, and never runs anything on a host', async () => {
    const { svc, names, probes, exec } = service([S('a')]);
    expect(await svc.rename('box:w:a', '  api   work ')).toMatchObject({ ok: true, name: 'api work' });
    expect(names.get('box:w:a')).toBe('api work');
    expect(probes).toEqual([]);
    expect(exec).toEqual([]);
  });
  it('refuses an unknown session, a bad name, and a direction override', async () => {
    const { svc, names } = service([S('a')]);
    expect(await svc.rename('box:w:nope', 'x')).toMatchObject({ ok: false, error: 'unknown_session' });
    expect(await svc.rename('box:w:a', '')).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await svc.rename('box:w:a', 'x'.repeat(41))).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await svc.rename('box:w:a', 'evil\u202Etxt.exe')).toMatchObject({ ok: false, error: 'bad_request' });
    expect(names.all()).toEqual({});
  });
  it('null clears it (Reset), and so does saving the derived name back', async () => {
    const { svc, names } = service([S('a')]);
    await svc.rename('box:w:a', 'nick');
    expect(await svc.rename('box:w:a', null)).toMatchObject({ ok: true });
    expect(names.get('box:w:a')).toBeUndefined();
    await svc.rename('box:w:a', 'nick');
    expect(await svc.rename('box:w:a', 'derived-a')).toMatchObject({ ok: true });
    expect(names.get('box:w:a')).toBeUndefined();
  });
  it('clearing a stopped session removes its nickname; clearing all stopped does too, live ones keep theirs', async () => {
    const list = [S('s1', { state: 'stopped', live: false }), S('s2', { state: 'stopped', live: false }), S('w')];
    const { svc, names } = service(list);
    for (const s of list) await svc.rename(s.key, `n-${s.sessionId}`);
    await svc.clear('box:w:s1');
    expect(names.all()).toEqual({ 'box:w:s2': 'n-s2', 'box:w:w': 'n-w' });
    await svc.clearStopped();
    expect(names.all()).toEqual({ 'box:w:w': 'n-w' });
  });
});

describe('demo rename', () => {
  it('sets and resets a nickname, shown in the demo\'s sessions, and drops it when the session is cleared', async () => {
    const demo = createDemo({ now: () => NOW });
    const s = demo.collector.sessions()[0];
    expect(await demo.api.rename(s.key, 'my nick')).toMatchObject({ ok: true });
    expect(demo.names.apply(demo.collector.sessions()).find((x) => x.key === s.key)).toMatchObject({ name: 'my nick', derivedName: s.name });
    expect(await demo.api.rename(s.key, null)).toMatchObject({ ok: true });
    expect(demo.names.get(s.key)).toBeUndefined();
    const stopped = demo.collector.sessions().find((x) => x.state === 'stopped' && !x.live)!;
    await demo.api.rename(stopped.key, 'gone soon');
    await demo.api.clear(stopped.key);
    expect(demo.names.get(stopped.key)).toBeUndefined();
    demo.stop();
  });
});

const TOKEN = generateToken();
const lanIp = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return {}; } }
class FakeCollector extends EventEmitter { constructor(private list: any[]) { super(); } sessions() { return this.list; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function boot(lan = false) {
  const web = mkdtempSync(join(tmpdir(), 'cc-web-'));
  writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
  const c = parseConfig(cfgText + (lan ? `lan: {enabled: true, token: "${TOKEN}", hosts: ["${lanIp}"]}\n` : ''));
  const list = [S('a'), S('b')];
  const names = new NicknameStore(join(tmp(), 'state.json'));
  const svc = createActionService({ cfg: c, sessions: () => list, probe: async () => ({}), names });
  const s = await startServer({ cfg: c, collector: new FakeCollector(list) as any, usage: new FakeUsage() as any, webRoot: web, port: 0, names,
    handlers: [createActionRoutes(svc, { mode: 'live' })] });
  close = s.close;
  return { port: s.port, names };
}
const raw = (port: number, o: { host?: string; origin?: string | null; method?: string; path?: string; address?: string; headers?: Record<string, string>; body?: string }) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const host = o.host ?? `127.0.0.1:${port}`;
    const origin = o.origin === null ? {} : { origin: o.origin ?? `http://${host}` };
    const r = request({ host: o.address ?? '127.0.0.1', port, path: o.path ?? '/api/action', method: o.method ?? 'POST',
      headers: { host, ...origin, ...o.headers } }, (res) => {
      let body = ''; res.on('data', (ch) => (body += ch)); res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    r.on('error', reject); r.end(o.body);
  });
const JSONH = { 'content-type': 'application/json', 'x-clayclaude': '1' };
const rename = (port: number, name: unknown, extra: Partial<Parameters<typeof raw>[1]> = {}) =>
  raw(port, { headers: JSONH, body: JSON.stringify({ action: 'rename', sessionId: 'box:w:a', name }), ...extra });
const state = async (port: number) => JSON.parse((await raw(port, { method: 'GET', path: '/api/state', origin: null })).body);

describe('rename endpoint', () => {
  it('a set name is served in /api/state as the name, with the derived name beside it; null resets', async () => {
    const { port } = await boot();
    expect((await rename(port, 'api work')).status).toBe(200);
    let st = await state(port);
    expect(st.sessions.map((s: any) => [s.key, s.name, s.derivedName])).toEqual([['box:w:a', 'api work', 'derived-a'], ['box:w:b', 'derived-b', undefined]]);
    expect((await rename(port, null)).status).toBe(200);
    st = await state(port);
    expect(st.sessions[0]).toMatchObject({ name: 'derived-a' });
    expect(st.sessions[0].derivedName).toBeUndefined();
  });
  it('validates: too long, empty, a direction override, a wrong type or a missing field are 400 and change nothing', async () => {
    const { port, names } = await boot();
    for (const bad of ['x'.repeat(41), '', '   ', 'a\u202Eb', 7, undefined]) expect((await rename(port, bad)).status, JSON.stringify(bad)).toBe(400);
    expect((await raw(port, { headers: JSONH, body: JSON.stringify({ action: 'rename', sessionId: 'box:w:nope', name: 'x' }) })).status).toBe(404);
    expect(names.all()).toEqual({});
  });
  it('follows the action-route rules: no Origin, a cross-site request, a foreign Origin, no X-Clayclaude or no JSON type are refused', async () => {
    const { port, names } = await boot();
    expect((await rename(port, 'n', { origin: null })).status).toBe(403);
    expect((await rename(port, 'n', { headers: { ...JSONH, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
    expect((await rename(port, 'n', { origin: 'https://evil.example' })).status).toBe(403);
    expect((await rename(port, 'n', { origin: 'http://localhost:1' })).status).toBe(403);
    expect((await rename(port, 'n', { headers: { 'content-type': 'application/json' } })).status).toBe(403);
    expect((await rename(port, 'n', { headers: { 'content-type': 'text/plain', 'x-clayclaude': '1' } })).status).toBe(403);
    expect(names.all()).toEqual({});
    expect((await rename(port, 'n')).status).toBe(200);
  });
  it.skipIf(!lanIp)('in LAN mode the token is required', async () => {
    const { port, names } = await boot(true);
    const lan = { address: lanIp, host: `${lanIp}:${port}` };
    expect((await rename(port, 'n', lan)).status).toBe(401);
    expect((await rename(port, 'n', { ...lan, headers: { ...JSONH, authorization: 'Bearer wrong' } })).status).toBe(401);
    expect(names.all()).toEqual({});
    expect((await rename(port, 'n', { ...lan, headers: { ...JSONH, authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect(names.get('box:w:a')).toBe('n');
  });
});

/* ---------- Task 42a ---------- */

describe('Task 42a: a name needs at least one visible character', () => {
  it('refuses names made only of invisible or format characters', () => {
    // zero-width space, ZWNJ, ZWJ, word joiner, BOM, soft hyphen, Hangul fillers, braille blank, a lone combining mark,
    // variation selectors, an invisible separator, the Mongolian vowel separator and a tag character
    for (const bad of ['​', '‌‍', '⁠﻿', '­', 'ㅤ', 'ᅟᅠ', 'ﾠ', '⠀', '́', '️', '⁣', '᠎', '\u{E0041}', ' ​ ​ '])
      expect(cleanNickname(bad), [...bad].map((c) => c.codePointAt(0)!.toString(16)).join(' ')).toMatchObject({ ok: false, message: expect.stringMatching(/visible/) });
  });
  it('keeps a visible name that carries them (an emoji sequence, an accent)', () => {
    expect(cleanNickname('👩‍💻 ops')).toMatchObject({ ok: true });
    expect(cleanNickname('éte')).toMatchObject({ ok: true });
    expect(cleanNickname('a​')).toMatchObject({ ok: true });
  });
  it('the rename action and the endpoint refuse them too', async () => {
    const { svc, names } = service([S('a')]);
    expect(await svc.rename('box:w:a', '​​')).toMatchObject({ ok: false, error: 'bad_request' });
    expect(names.all()).toEqual({});
    const { port } = await boot();
    expect((await rename(port, '⁠ㅤ')).status).toBe(400);
  });
});

describe('Task 42a: a failed write rolls the name back and tells nobody', () => {
  const locked = () => {
    const dir = tmp();
    const path = join(dir, 'state.json');
    return { path, lock: () => chmodSync(dir, 0o500), unlock: () => chmodSync(dir, 0o700) };
  };
  it('set: the old name (or none) is back in memory, nothing is broadcast, and the promise rejects', async () => {
    const { path, lock, unlock } = locked();
    const s = new NicknameStore(path);
    await s.set('k', 'first');
    let n = 0; s.on('update', () => n++);
    lock();
    try {
      await expect(s.set('k', 'second')).rejects.toThrow();
      await expect(s.set('new', 'x')).rejects.toThrow();
    } finally { unlock(); }
    expect(s.get('k')).toBe('first');
    expect(s.get('new')).toBeUndefined();
    expect(n).toBe(0);
    expect(new NicknameStore(path).all()).toEqual({ k: 'first' });
  });
  it('remove: the names come back, nothing is broadcast', async () => {
    const { path, lock, unlock } = locked();
    const s = new NicknameStore(path);
    await s.set('a', 'A'); await s.set('b', 'B');
    let n = 0; s.on('update', () => n++);
    lock();
    try { await expect(s.remove(['a', 'b'])).rejects.toThrow(); } finally { unlock(); }
    expect(s.all()).toEqual({ a: 'A', b: 'B' });
    expect(n).toBe(0);
  });
  it('a later write that succeeds is kept when an earlier one failed', async () => {
    const { path, lock, unlock } = locked();
    const s = new NicknameStore(path);
    lock();
    const first = s.set('k', 'one');
    const firstDone = first.catch(() => 'failed');
    expect(await firstDone).toBe('failed');
    unlock();
    await s.set('k', 'two');
    expect(s.get('k')).toBe('two');
  });
  it('a broadcast follows a successful write, after the file holds the name', async () => {
    const path = join(tmp(), 'state.json');
    const s = new NicknameStore(path);
    const seen: unknown[] = [];
    s.on('update', () => seen.push(JSON.parse(readFileSync(path, 'utf8')).nicknames));
    await s.set('k', 'n');
    expect(seen).toEqual([{ k: 'n' }]);
  });
  it('the rename action reports the failure and the board keeps the old name', async () => {
    const dir = tmp();
    const names = new NicknameStore(join(dir, 'state.json'));
    await names.set('box:w:a', 'old');
    let n = 0; names.on('update', () => n++);
    const svc = createActionService({ cfg, sessions: () => [S('a')], probe: async () => ({}), exec: (async () => { throw new Error('no exec'); }) as never, names });
    chmodSync(dir, 0o500);
    try { expect(await svc.rename('box:w:a', 'new')).toMatchObject({ ok: false, error: 'failed', message: expect.stringMatching(/could not save/) }); }
    finally { chmodSync(dir, 0o700); }
    expect(names.get('box:w:a')).toBe('old');
    expect(names.apply([S('a')])[0].name).toBe('old');
    expect(n).toBe(0);
  });
});

describe('Task 42a: Also rename the tmux window', () => {
  it('off (the default): runs nothing on the host', async () => {
    const { svc, exec } = service([S('a', { pid: 77 })]);
    expect(await svc.rename('box:w:a', 'api work')).toMatchObject({ ok: true });
    expect(await svc.rename('box:w:a', 'api work', { tmux: false })).toMatchObject({ ok: true });
    expect(exec).toEqual([]);
  });
  it('on: runs exactly one command on the session\'s host, rename-window on its window, after checking the pane is still the session\'s', async () => {
    const { svc, names, exec } = service([S('a', { pid: 77 })]);
    const r = await svc.rename('box:w:a', '  api   work ', { tmux: true });
    expect(r).toMatchObject({ ok: true, name: 'api work' });
    expect(names.get('box:w:a')).toBe('api work');
    expect(exec).toHaveLength(1);
    const [host, argv] = exec[0] as [any, string[]];
    expect(host.id).toBe('box');
    expect(argv).toEqual(['sh', '-c', RENAME_WINDOW_SCRIPT, '_', '%1', 'agents:@1.%1', '@1', '77', 'api work']);
    // the only tmux commands in it: a read of the pane, then rename-window with the name as one argument after --
    expect(RENAME_WINDOW_SCRIPT.match(/tmux [a-z-]+/g)).toEqual(['tmux display-message', 'tmux rename-window']);
    expect(RENAME_WINDOW_SCRIPT).toContain('tmux rename-window -t "$3" -- "$5"');
    expect(RENAME_WINDOW_SCRIPT).not.toMatch(/send-keys|paste|load-buffer|respawn|kill/);
  });
  it('on with Reset: the window takes the session\'s own name', async () => {
    const { svc, exec } = service([S('a', { pid: 77 })]);
    await svc.rename('box:w:a', 'nick');
    expect(await svc.rename('box:w:a', null, { tmux: true })).toMatchObject({ ok: true });
    expect((exec[0] as [any, string[]])[1].at(-1)).toBe('derived-a');
  });
  it('refuses, before changing anything, a name tmux would read as a format or a command separator', async () => {
    const { svc, names, exec } = service([S('a')]);
    for (const bad of ['a#(id)', '#{host}', 'x ##', 'end;', 'two;;', 'back\\slash']) {
      expect(await svc.rename('box:w:a', bad, { tmux: true }), bad).toMatchObject({ ok: false, error: 'bad_request', message: expect.stringMatching(/tmux/) });
    }
    expect(names.all()).toEqual({});
    expect(exec).toEqual([]);
    expect(await svc.rename('box:w:a', 'a#b\\c;', { tmux: false })).toMatchObject({ ok: true });
  });
  it('refuses a session that is not in tmux, is stopped, or whose host is offline, before changing anything', async () => {
    const { svc, names, exec } = service([S('a', { tmux: undefined }), S('b', { live: false, state: 'stopped' }), S('c', { hostOnline: false })]);
    expect(await svc.rename('box:w:a', 'n', { tmux: true })).toMatchObject({ ok: false, error: 'no_tmux' });
    expect(await svc.rename('box:w:b', 'n', { tmux: true })).toMatchObject({ ok: false, error: 'no_tmux' });
    expect(await svc.rename('box:w:c', 'n', { tmux: true })).toMatchObject({ ok: false, error: 'host_offline' });
    expect(names.all()).toEqual({});
    expect(exec).toEqual([]);
  });
  it('a tmux failure keeps the board name and says the window was not renamed', async () => {
    const dir = tmp();
    const names = new NicknameStore(join(dir, 'state.json'));
    const calls: unknown[] = [];
    const svc = createActionService({ cfg, sessions: () => [S('a')], probe: async () => ({}), names,
      exec: (async (...a: unknown[]) => { calls.push(a); return { code: 3, stdout: '', stderr: 'that pane no longer belongs to this session\n' }; }) as never });
    const r = await svc.rename('box:w:a', 'nick', { tmux: true });
    expect(r).toMatchObject({ ok: true, name: 'nick', tmuxError: 'that pane no longer belongs to this session' });
    expect((r as any).message).toMatch(/tmux window was not renamed/);
    expect(names.get('box:w:a')).toBe('nick');
    expect(calls).toHaveLength(1);
  });
  it('the endpoint takes a boolean tmux flag and refuses anything else', async () => {
    const { port, names } = await boot();
    expect((await raw(port, { headers: JSONH, body: JSON.stringify({ action: 'rename', sessionId: 'box:w:a', name: 'n', tmux: 'yes' }) })).status).toBe(400);
    expect(names.all()).toEqual({});
  });
  it('the demo accepts the flag and renames no window', async () => {
    const demo = createDemo({ now: () => NOW });
    const s = demo.collector.sessions().find((x) => x.tmux)!;
    expect(await demo.api.rename(s.key, 'demo nick', { tmux: true })).toMatchObject({ ok: true, message: expect.stringMatching(/demo/) });
    expect(demo.names.get(s.key)).toBe('demo nick');
    demo.stop();
  });
});

describe('Task 42a: a + New name becomes the session\'s board name', () => {
  const l = (over: object = {}) => ({ host: 'box', account: 'w', target: 'agents:@1.%1', pid: 1, cwd: '/x', name: 'api work', nickname: 'api work', ...over });
  it('when the registered session is named otherwise (a CLI without --name), the name is set as its nickname', async () => {
    const names = new NicknameStore(join(tmp(), 'state.json'));
    await adoptLaunchName(names, l(), S('a'));
    expect(names.get('box:w:a')).toBe('api work');
  });
  it('when Claude already took the name, or there was none, or the board already has one, nothing is set', async () => {
    const names = new NicknameStore(join(tmp(), 'state.json'));
    await adoptLaunchName(names, l(), S('a', { name: 'api work' }));
    await adoptLaunchName(names, l({ nickname: undefined }), S('b'));
    await names.set('box:w:c', 'mine');
    await adoptLaunchName(names, l(), S('c'));
    expect(names.all()).toEqual({ 'box:w:c': 'mine' });
  });
});

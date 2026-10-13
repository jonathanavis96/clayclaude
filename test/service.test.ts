import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { createActionService } from '../src/actions/service.js';
import { publicConfig } from '../src/actions/public-config.js';
import type { Cmd } from '../src/actions/open.js';

const cfg = parseConfig(`
lan: { enabled: true, token: "${'t'.repeat(30)}", hosts: ["192.168.1.2"] }
browsers: { chrome: /c/chrome.exe }
hosts: [{id: local}, {id: box, ssh: boxalias}]
accounts:
  - {id: w, label: W, colour: "#fff", host: box, configDir: ~/.claude-w, open: {type: chrome, profileDirectory: "Profile 2"}}
  - {id: a, label: A, colour: "#fff", host: local, configDir: /x, open: {type: app}}
  - {id: t, label: T, colour: "#fff", host: local, configDir: /y}
`);
const S = (over: object) => ({ key: 'k', host: 'box', account: 'w', sessionId: 'sid', pid: 1, name: 'orchard', hostOnline: true, tmux: 'main:@1.%1', bridgeSessionId: 'session_abc123', ...over }) as any;

function make(session: any, probe: any = async () => ({ ok: true, dirs: [] })) {
  const cmds: Cmd[] = [];
  const svc = createActionService({ cfg, sessions: () => [session], probe, gui: async (c) => (cmds.push(c), { ok: true }), env: { kind: 'wsl', distro: 'Ubuntu' }, exec: async () => ({ code: 0, stdout: '', stderr: '' }) });
  return { svc, cmds };
}

describe('action service', () => {
  it('opens a bridge session in the account\'s Chrome profile', async () => {
    const { svc, cmds } = make(S({}));
    expect(await svc.open('k')).toEqual({ ok: true, message: 'Opened in Chrome (Profile 2)' });
    expect(cmds[0]).toEqual({ bin: '/c/chrome.exe', args: ['--profile-directory=Profile 2', 'https://claude.ai/code/session_abc123'] });
  });
  it('opens in the app, and falls back to attach for a tmux-only account', async () => {
    const a = make(S({ account: 'a', host: 'local' }));
    await a.svc.open('k');
    expect(a.cmds[0].args.at(-1)).toBe('claude://code/session_abc123');
    const t = make(S({ account: 't', host: 'local', bridgeSessionId: undefined }));
    expect(await t.svc.open('k')).toMatchObject({ ok: true });
    expect(t.cmds[0].bin).toBe('wt.exe');
  });
  it('a session without a bridge id cannot be opened, only attached', async () => {
    const { svc, cmds } = make(S({ bridgeSessionId: undefined }));
    expect(await svc.open('k')).toMatchObject({ ok: false, error: 'no_bridge' });
    expect(await svc.attach('k')).toMatchObject({ ok: true });
    expect(cmds).toHaveLength(1);
    expect(cmds[0].args.at(-1)).toContain("exec 'ssh' '-t' 'boxalias'");
  });
  it('refuses attach for no tmux, offline host, unknown session; surfaces a start failure', async () => {
    expect(await make(S({ tmux: undefined })).svc.attach('k')).toMatchObject({ error: 'no_tmux' });
    expect(await make(S({ hostOnline: false })).svc.attach('k')).toMatchObject({ error: 'host_offline' });
    expect(await make(S({})).svc.open('nope')).toMatchObject({ error: 'unknown_session' });
    const svc = createActionService({ cfg, sessions: () => [S({})], probe: async () => ({}), gui: async () => ({ ok: false, error: 'chrome: not found' }) });
    expect(await svc.open('k')).toEqual({ ok: false, error: 'failed', message: 'chrome: not found' });
  });
  it('builds a summary from the probe\'s transcript for just that session', async () => {
    const reqs: any[] = [];
    const probe = async (_h: unknown, req: any) => {
      reqs.push(req);
      return { ok: true, dirs: [{ registries: [{ data: { startedAt: 42 }, transcript: [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } })] }] }] };
    };
    const { svc } = make(S({}), probe);
    const r: any = await svc.summary('k');
    expect(r.summary).toMatchObject({ lastAssistantText: 'hello', startedAt: 42 });
    expect(reqs[0]).toMatchObject({ mode: 'snapshot', only: 'sid', dirs: ['~/.claude-w'] });
    await svc.summary('k');
    expect(reqs).toHaveLength(1); // cached for 3 s
  });
  it('a resumed session\'s summary comes from the registry of the process the board shows, not the first file by name', async () => {
    // Claude Code writes a new <pid>.json each time a session is resumed; the dead ones stay, and sort first by name.
    const t = (text: string) => [JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })];
    const regs = [
      { file: '15018.json', mtimeMs: 1000, live: false, data: { pid: 15018, sessionId: 'sid', startedAt: 10 }, transcript: [] },
      { file: '2914547.json', mtimeMs: 3000, live: true, data: { pid: 2914547, sessionId: 'sid', startedAt: 30 }, transcript: t('live') },
      { file: '46416.json', mtimeMs: 2000, live: false, data: { pid: 46416, sessionId: 'sid', startedAt: 20 }, transcript: t('old') },
    ];
    const probe = async () => ({ ok: true, dirs: [{ registries: regs }] });
    const r: any = await make(S({ pid: 2914547 }), probe).svc.summary('k');
    expect(r.summary).toMatchObject({ lastAssistantText: 'live', startedAt: 30 });
    // No pid match (the board's row is older than the probe): the live one, then one with a transcript, then the newest.
    const noLive = regs.map((g) => ({ ...g, live: false }));
    const r2: any = await make(S({ pid: 7 }), async () => ({ ok: true, dirs: [{ registries: [noLive[0], { ...noLive[2], live: true }, noLive[1]] }] })).svc.summary('k');
    expect(r2.summary).toMatchObject({ lastAssistantText: 'old', startedAt: 20 });
    const r3: any = await make(S({ pid: 7 }), async () => ({ ok: true, dirs: [{ registries: noLive }] })).svc.summary('k');
    expect(r3.summary).toMatchObject({ lastAssistantText: 'live', startedAt: 30 });
    const r4: any = await make(S({ pid: 7 }), async () => ({ ok: true, dirs: [{ registries: noLive.map((g) => ({ ...g, transcript: [] })) }] })).svc.summary('k');
    expect(r4.summary).toMatchObject({ startedAt: 30 });
  });
  it('the public config never contains the LAN token or credential details', () => {
    const json = JSON.stringify(publicConfig(cfg));
    expect(json).not.toContain('ttttt');
    expect(json).not.toMatch(/token|credential/i);
    expect(JSON.parse(json).lan).toEqual({ enabled: true, hosts: ['192.168.1.2'] });
  });
});

import { describe, it, expect } from 'vitest';
import { ANSWERED_SHOW_MS, createDemo } from '../src/demo/index.js';
import { ALL_CLAY_IDS, refClay } from './helpers/clay-thresholds.js';

const T0 = Date.parse('2026-10-12T12:00:00Z');
const clock = (start = T0) => { let t = start; return { now: () => t, advance: (ms: number) => { t += ms; } }; };

describe('demo scenarios', () => {
  it('gallery has one frozen session per bracket for all 25 non-L1 clay states, in timeline order (L1 is the launcher card)', () => {
    const c = clock();
    const d = createDemo({ scenario: 'gallery', now: c.now });
    const list = d.collector.sessions().map((s) => { const r = refClay(s, c.now(), 60); return r.puffed ? 'X2' : r.id; });
    expect(list).toHaveLength(25);
    expect([...list].sort()).toEqual([...ALL_CLAY_IDS].sort());
    // each timeline on its own line, in order (spec §7.4.6)
    for (const g of ['W', 'N', 'S']) expect(list.filter((x) => x.startsWith(g))).toEqual(ALL_CLAY_IDS.filter((x) => x.startsWith(g)));
    // X2 is a modifier: the puffed session still shows its base animation underneath
    expect(d.collector.sessions().filter((s) => s.overContext)).toHaveLength(1);
  });
  it('gallery stays frozen however long it runs', () => {
    const c = clock();
    const d = createDemo({ scenario: 'gallery', now: c.now });
    const before = d.collector.sessions().map((s) => c.now() - s.stateSince);
    c.advance(3 * 3600_000);
    expect(d.collector.sessions().map((s) => c.now() - s.stateSince)).toEqual(before);
  });
  it('sessions: N repeats the board under numbered names, keys unique (grid view checks, spec §5.1)', () => {
    for (const n of [6, 12, 30]) {
      const list = createDemo({ sessions: n, now: clock().now }).collector.sessions();
      expect(list).toHaveLength(n);
      expect(new Set(list.map((s) => s.key)).size).toBe(n);
    }
    const list = createDemo({ sessions: 12, now: clock().now }).collector.sessions();
    expect(list.map((s) => s.name)).toContain('orchard-api-2');
    expect(createDemo({ scenario: 'gallery', sessions: 3, now: clock().now }).collector.sessions()).toHaveLength(3);
  });
  it('board shows all six states with two needs-you sessions, and no real names', () => {
    const d = createDemo({ now: clock().now });
    const list = d.collector.sessions();
    expect(new Set(list.map((s) => s.state))).toEqual(new Set(['working', 'needs-you', 'asleep', 'compacting', 'limit', 'stopped']));
    expect(list.filter((s) => s.state === 'needs-you')).toHaveLength(2);
    expect(list.every((s) => s.cwd.startsWith('/home/demo/'))).toBe(true);
    expect(d.usage.usage().some((u) => (u.fiveHour ?? 0) >= 80 && (u.fiveHour ?? 0) < 100)).toBe(true);
    expect(d.usage.usage()).toHaveLength(3);
  });
  it('speed makes sessions age through the animation brackets', () => {
    const c = clock();
    const d = createDemo({ speed: 60, now: c.now });          // one real second = one demo minute
    const orchard = () => d.collector.sessions().find((s) => s.name === 'orchard-api')!;
    const seen = new Set<string>();
    for (let i = 0; i < 70; i++) { seen.add(refClay(orchard(), c.now(), 60).id); c.advance(1000); }
    expect([...seen]).toEqual(expect.arrayContaining(['W3', 'W4', 'W5', 'W6']));
  });
});

describe('demo actions', () => {
  const prompt = async (d: ReturnType<typeof createDemo>, name: string) => {
    const s = d.collector.sessions().find((x) => x.name === name)!;
    return { s, r: (await d.api.readPrompt(s.key)) as any };
  };

  it('offers a permission prompt (Yes / No, shown verbatim) and a free-text question', async () => {
    const d = createDemo({ now: clock().now });
    const menu = await prompt(d, 'tidepool-ui');
    expect(menu.r.prompt.kind).toBe('permission');
    expect(menu.r.prompt.options.map((o: any) => [o.key, o.label])).toEqual([['yes', 'Yes'], ['no', 'No']]);
    expect(menu.r.prompt.detail).toContain(' Bash command');
    expect(menu.r.prompt.detail).toContain(' ❯ 1. Yes');
    const text = await prompt(d, 'lantern-docs');
    expect(text.r.prompt).toMatchObject({ kind: 'text', quickReplies: ['yes', 'no', 'continue'] });
  });
  it('answering moves the session to working; a stale hash sends nothing', async () => {
    const c = clock();
    const d = createDemo({ now: c.now });
    const { s, r } = await prompt(d, 'tidepool-ui');
    expect(await d.api.answer({ sessionId: s.key, promptHash: 'stale', choice: 'yes' })).toMatchObject({ ok: false, error: 'prompt_changed' });
    expect(d.collector.sessions().find((x) => x.key === s.key)!.state).toBe('needs-you');
    for (const bad of ['1', '2']) expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, choice: bad })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, text: 'yes' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, choice: 'no' })).toEqual({ ok: true, sent: 'No' });
    expect(d.collector.sessions().find((x) => x.key === s.key)!.state).toBe('working');
    expect(await d.api.readPrompt(s.key)).toMatchObject({ ok: false, error: 'no_prompt' });
  });
  it('an answered question comes back after a while, so the demo can be answered again', async () => {
    const c = clock();
    const d = createDemo({ now: c.now });
    const { s, r } = await prompt(d, 'tidepool-ui');
    expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, choice: 'yes' })).toEqual({ ok: true, sent: 'Yes' });
    c.advance(ANSWERED_SHOW_MS + 1000);
    expect(d.collector.sessions().find((x) => x.key === s.key)!.state).toBe('needs-you');
    expect(await d.api.readPrompt(s.key)).toMatchObject({ ok: true, prompt: { kind: 'permission' } });
  });
  // Task 43: a new message to an idle session is simulated: the idle gate's own refusals, and a sent message working for a while.
  it('message: an idle session takes it and works for a while; any other session refuses it; "fail" simulates a failure', async () => {
    const c = clock();
    const d = createDemo({ now: c.now });
    const all = d.collector.sessions();
    const idle = all.find((x) => x.state === 'asleep' && x.tmux)!;
    expect(idle).toMatchObject({ idle: true });
    for (const s of all.filter((x) => x.state !== 'asleep')) {
      expect(s.idle, s.name).toBeUndefined();
      expect(await d.api.message({ sessionId: s.key, text: 'next' }), s.name).toMatchObject({ ok: false });
    }
    expect(await d.api.message({ sessionId: idle.key, text: 'fail' })).toMatchObject({ ok: false, error: 'failed' });
    expect(await d.api.message({ sessionId: idle.key, text: '   ' })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await d.api.message({ sessionId: idle.key, text: 'x'.repeat(4001) })).toMatchObject({ ok: false, error: 'too_long' });
    expect(await d.api.message({ sessionId: idle.key, text: 'add a changelog entry' })).toEqual({ ok: true, sent: 'message (21 characters)' });
    expect(d.collector.sessions().find((x) => x.key === idle.key)).toMatchObject({ state: 'working' });
    expect(await d.api.message({ sessionId: idle.key, text: 'again' })).toMatchObject({ ok: false });
    expect(await d.api.message({ sessionId: 'nope', text: 'hi' })).toMatchObject({ ok: false, error: 'unknown_session' });
  });
  it('typing "fail" into the text question simulates a failure', async () => {
    const d = createDemo({ now: clock().now });
    const { s, r } = await prompt(d, 'lantern-docs');
    expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, text: 'fail' })).toMatchObject({ ok: false, error: 'failed' });
    expect(await d.api.answer({ sessionId: s.key, promptHash: r.prompt.hash, text: 'leave it' })).toMatchObject({ ok: true });
  });
  it('simulates open, attach (success and visible failures) without running anything', async () => {
    const d = createDemo({ now: clock().now });
    const by = (n: string) => d.collector.sessions().find((x) => x.name === n)!.key;
    expect(await d.api.open(by('orchard-api'))).toMatchObject({ ok: true, message: expect.stringContaining('Simulated') });
    expect(await d.api.open(by('mossgarden-infra'))).toMatchObject({ ok: false, error: 'failed' });
    expect(await d.api.open(by('riverbank-etl'))).toMatchObject({ ok: false });
    expect(await d.api.attach(by('riverbank-etl'))).toMatchObject({ ok: false, error: 'no_tmux' });
    expect(await d.api.attach(by('pebble-cli'))).toMatchObject({ ok: true });
  });
  it('launch succeeds for two accounts, fails for the third, adds a new working session', async () => {
    const d = createDemo({ now: clock().now, launchDelayMs: 0 });
    const before = d.collector.sessions().length;
    expect(await d.api.launch({ account: 'studio', repo: '/home/demo/code/harbor-notes', options: { model: 'opus', remoteControl: true } })).toMatchObject({ ok: true });
    const after = d.collector.sessions();
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)).toMatchObject({ name: 'harbor-notes', state: 'working' });
    expect(await d.api.launch({ account: 'side', repo: '/home/demo/code/harbor-notes', options: {} })).toMatchObject({ ok: false, error: 'failed' });
    expect(await d.api.launch({ account: 'studio', repo: '/etc', options: {} })).toMatchObject({ ok: false, error: 'forbidden' });
  });
  it('Task 46: offers a fixture model list (More ▾ holds the older ones) and the modes, bypass behind its confirm', async () => {
    const d = createDemo({ now: clock().now, launchDelayMs: 0 });
    const studio = (await d.api.launchOptions()).accounts.find((a) => a.id === 'studio')!;
    expect(studio.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1']);
    expect(studio.moreModels).toEqual(expect.arrayContaining(['claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-5', 'claude-haiku-4-5-20251001']));
    expect(studio.modelNames?.['claude-opus-4-7']).toBe('Opus 4.7');
    expect(studio.modes).toContain('bypassPermissions');
    const repo = '/home/demo/code/harbor-notes';
    expect(await d.api.launch({ account: 'studio', repo, options: { model: 'claude-opus-9' } })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await d.api.launch({ account: 'studio', repo, options: { permissionMode: 'bypassPermissions' } })).toMatchObject({ ok: false, error: 'bad_request' });
    expect(await d.api.launch({ account: 'studio', repo, options: { model: 'claude-opus-4-7', permissionMode: 'bypassPermissions', confirmBypass: true } })).toMatchObject({ ok: true });
    expect(d.collector.sessions().at(-1)).toMatchObject({ model: 'claude-opus-4-7' });
  });
  it('Task 47: preselects Auto (the default defaultMode) where the host lists it, Manual for Lab', async () => {
    const d = createDemo({ now: clock().now, launchDelayMs: 0 });
    const accts = (await d.api.launchOptions()).accounts;
    expect(accts.find((a) => a.id === 'studio')!.defaultMode).toBe('auto');
    expect(accts.find((a) => a.id === 'lab')!.defaultMode).toBe('');
  });
  it('a launch in the never-trusted demo folder shows STARTING, then the trust question; Yes starts it, No removes it (Task 40)', async () => {
    const c = clock();
    const d = createDemo({ now: c.now, launchDelayMs: 0 });
    const row = () => d.collector.sessions().find((s) => s.name === 'kestrel-bot');
    expect(await d.api.launch({ account: 'studio', repo: '/home/demo/code/kestrel-bot', options: {} })).toMatchObject({ ok: true });
    expect(row()).toMatchObject({ state: 'working', starting: true });
    c.advance(5000);
    expect(row()).toMatchObject({ state: 'needs-you', starting: true, question: 'Is this a project you created or one you trust?' });
    const r: any = await d.api.readPrompt(row()!.key);
    expect(r.prompt).toMatchObject({ kind: 'menu', trust: true });
    expect(r.prompt.options.map((o: any) => o.label)).toEqual(['No, exit', 'Yes, I trust this folder']);
    expect(await d.api.answer({ sessionId: row()!.key, promptHash: r.prompt.hash, choice: '2' })).toMatchObject({ ok: true });
    expect(row()).toMatchObject({ state: 'working' });
    expect(row()!.starting).toBeUndefined();
    await d.api.launch({ account: 'studio', repo: '/home/demo/code/kestrel-bot', options: {} });
    c.advance(5000);
    const second = d.collector.sessions().filter((s) => s.name === 'kestrel-bot').find((s) => s.starting)!;
    const r2: any = await d.api.readPrompt(second.key);
    expect(await d.api.answer({ sessionId: second.key, promptHash: r2.prompt.hash, choice: '1' })).toMatchObject({ ok: true });
    expect(d.collector.sessions().filter((s) => s.name === 'kestrel-bot')).toHaveLength(1);
  });
  it('launch options differ per account so hidden options can be seen', async () => {
    const o = await createDemo({ now: clock().now }).api.launchOptions();
    expect(o.accounts.find((a) => a.id === 'lab')).toMatchObject({ remoteControl: false, efforts: ['low', 'medium', 'high'] });
    expect(o.accounts.find((a) => a.id === 'studio')!.efforts).toContain('max');
  });
  it('summary has a live-looking tool feed', async () => {
    const d = createDemo({ now: clock().now });
    const r: any = await d.api.summary(d.collector.sessions()[0].key);
    expect(r.summary.tools).toHaveLength(12);
    expect(r.summary.lastPrompt).toBeTruthy();
  });
  it('the demo public config says it is a demo and carries no secrets', () => {
    const j = JSON.stringify(createDemo({ now: clock().now }).publicConfig());
    expect(j).toContain('"demo":true');
    expect(j).not.toMatch(/token/i);
  });
});

describe('demo rename (Task 42)', () => {
  it('renames on the board only and says the ticks did nothing: no tmux window, nothing in Claude Code', async () => {
    const d = createDemo({ now: clock().now });
    const s = d.collector.sessions()[0];
    expect(await d.api.rename(s.key, 'demo one', { claude: true })).toMatchObject({ ok: true, name: 'demo one', message: expect.stringContaining('the demo renames nothing in Claude Code') });
    expect(await d.api.rename(s.key, 'demo two', { tmux: true, claude: true })).toMatchObject({ ok: true, message: expect.stringContaining('no tmux window and nothing in Claude Code') });
    expect(await d.api.rename(s.key, 'demo three', { tmux: true })).toMatchObject({ ok: true, message: expect.stringContaining('(the demo renames no tmux window)') });
    expect((await d.api.rename(s.key, 'demo four')) as any).toMatchObject({ ok: true, message: 'Renamed to demo four' });
  });
});

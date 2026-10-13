import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { parseConfig } from '../../src/config.js';
import { createActionService } from '../../src/actions/service.js';
import { killOwn } from '../helpers/tmux.js';

/**
 * Real launches of the programs the Open and Attach actions start. Skipped unless CLAYCLAUDE_REAL_GUI=1.
 * Three launches at most (one each). Each opens a window that someone must close by hand afterwards.
 *   CLAYCLAUDE_REAL_BRIDGE_ID   a real /rc id (session_…), for the desktop app and Chrome
 *   CLAYCLAUDE_REAL_CHROME      path to chrome.exe;  CLAYCLAUDE_REAL_PROFILE  a profile directory name
 *   CLAYCLAUDE_REAL_TMUX=1      also open a terminal attached to a tmux session this file creates. That session lives
 *                               on the default tmux server (the terminal attaches through the default socket), so it is
 *                               a separate opt-in: leave it off where the default tmux server is not yours to touch.
 */
const on = process.env.CLAYCLAUDE_REAL_GUI === '1';
const tmuxOn = on && process.env.CLAYCLAUDE_REAL_TMUX === '1';
const bridge = process.env.CLAYCLAUDE_REAL_BRIDGE_ID ?? '';
const chrome = process.env.CLAYCLAUDE_REAL_CHROME ?? '';
const profile = process.env.CLAYCLAUDE_REAL_PROFILE ?? 'Default';
const TEST_SESSION = 'clayclaude-test-attach';   // the only tmux session this file creates, touches or kills

const cfg = parseConfig(`
hosts: [{id: local}]
browsers: { chrome: "${chrome}" }
accounts:
  - { id: app, label: App, colour: "#fff", host: local, configDir: /x, usage: {provider: none}, open: {type: app} }
  - { id: chr, label: Chr, colour: "#fff", host: local, configDir: /y, usage: {provider: none}, open: {type: chrome, profileDirectory: "${profile}"} }
  - { id: tmx, label: Tmx, colour: "#fff", host: local, configDir: /z, usage: {provider: none}, open: {type: tmux} }
`);
const mk = (account: string, extra: object = {}) => ({ key: `local:${account}:s`, host: 'local', account, sessionId: 's', pid: 1, name: 'clayclaude-test', hostOnline: true, bridgeSessionId: bridge || undefined, ...extra }) as any;

describe.skipIf(!on)('real GUI launches (manual)', () => {
  afterAll(() => { if (tmuxOn) killOwn(TEST_SESSION); });   // only this name is ever touched

  it.skipIf(!bridge)('opens the desktop app on a session through claude://', async () => {
    const svc = createActionService({ cfg, sessions: () => [mk('app')], probe: async () => ({}) });
    expect(await svc.open('local:app:s')).toMatchObject({ ok: true });
  });
  it.skipIf(!bridge || !chrome)('opens Chrome in the chosen profile', async () => {
    const svc = createActionService({ cfg, sessions: () => [mk('chr')], probe: async () => ({}) });
    expect(await svc.open('local:chr:s')).toMatchObject({ ok: true });
  });
  it.skipIf(!tmuxOn)('opens a terminal attached to a tmux session this test created', async () => {
    execFileSync('tmux', ['new-session', '-d', '-s', TEST_SESSION, 'sleep 120']);
    const ref = execFileSync('tmux', ['display-message', '-p', '-t', `=${TEST_SESSION}:`, '#{session_name}:#{window_id}.#{pane_id}'], { encoding: 'utf8' }).trim();
    const svc = createActionService({ cfg, sessions: () => [mk('tmx', { tmux: ref })], probe: async () => ({}) });
    expect(await svc.attach('local:tmx:s')).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 4000));
  });
});

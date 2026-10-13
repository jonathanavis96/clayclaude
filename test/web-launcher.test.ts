import { describe, it, expect } from 'vitest';
import { canStart, filterRepos, initialLauncher, launchBody, normalise } from '../web/src/launcher-model.js';
import { accountsHtml, optionsHtml, reposHtml, type LView } from '../web/src/launcher-view.js';

const opts = { accounts: [
  { id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true, models: ['opus', 'sonnet'], efforts: ['low', 'high'], remoteControl: true },
  { id: 'b', label: 'Lab', colour: '#4fd1c5', host: 'rack', canLaunch: true, models: ['opus'], efforts: [], remoteControl: false },
  { id: 'c', label: 'Down', colour: '#fff', host: 'x', canLaunch: false, reason: 'ssh: unreachable <1>', models: [], efforts: [], remoteControl: false },
] };
const repos = [{ path: '/r/tidepool-ui', name: 'tidepool-ui', lastUsedMs: 3 }, { path: '/r/orchard-api', name: 'orchard-api', lastUsedMs: 2 }, { path: '/r/quill-site', name: 'quill-site', lastUsedMs: 1 }];
const view = (o: Partial<LView> = {}): LView => ({ opts, repos, st: { ...initialLauncher(), account: 'a' }, usage: [], busy: false, ...o });

describe('launcher model', () => {
  it('resets choices the newly chosen account does not offer', () => {
    const st = { ...initialLauncher(), account: 'b', model: 'sonnet', effort: 'high', remoteControl: true };
    expect(normalise(st, opts)).toMatchObject({ model: '', effort: '', remoteControl: false });
    expect(normalise({ ...st, account: 'a', model: 'sonnet', effort: 'low', remoteControl: true }, opts)).toMatchObject({ model: 'sonnet', effort: 'low', remoteControl: true });
  });
  it('needs a launchable account and a repo, and is not busy', () => {
    const st = { ...initialLauncher(), account: 'a', repo: '/r/x' };
    expect(canStart(st, opts, false)).toBe(true);
    expect(canStart(st, opts, true)).toBe(false);
    expect(canStart({ ...st, repo: undefined }, opts, false)).toBe(false);
    expect(canStart({ ...st, account: 'c' }, opts, false)).toBe(false);
  });
  it('searches repos fuzzily, keeping recency order when empty', () => {
    expect(filterRepos(repos, '').map((r) => r.name)).toEqual(['tidepool-ui', 'orchard-api', 'quill-site']);
    expect(filterRepos(repos, 'oapi')[0].name).toBe('orchard-api');
  });
  it('builds the launch request without empty options', () => {
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x' })).toEqual({ action: 'launch', account: 'a', repo: '/r/x', options: { remoteControl: false, openOnPc: false } });
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x', model: 'opus', effort: 'high', remoteControl: true, openOnPc: true }).options)
      .toEqual({ model: 'opus', effort: 'high', remoteControl: true, openOnPc: true });
  });
  it('Task 42a: carries the Name, trimmed, and leaves it out when blank', () => {
    expect(initialLauncher().name).toBe('');
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x', name: '  api work ' }).options).toEqual({ name: 'api work', remoteControl: false, openOnPc: false });
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x', name: '   ' }).options).toEqual({ remoteControl: false, openOnPc: false });
  });
});

describe('launcher view', () => {
  it('disables and explains an account that cannot launch (escaped)', () => {
    const h = accountsHtml(view());
    expect(h.match(/data-act="account"/g)).toHaveLength(3);
    expect(h).toContain('disabled');
    expect(h).toContain('ssh: unreachable &lt;1&gt;');
  });
  it('hides options the account\'s CLI lacks', () => {
    const a = optionsHtml(view());
    expect(a).toContain('data-opt="model"');
    expect(a).toContain('data-opt="remoteControl"');
    const b = optionsHtml(view({ st: { ...initialLauncher(), account: 'b' } }));
    expect(b).toContain('data-opt="model"');
    expect(b).not.toContain('data-opt="effort"');
    expect(b).not.toContain('remoteControl');
    expect(b).toContain('data-opt="openOnPc"');
  });
  it('enables Start only when a repo is chosen', () => {
    expect(optionsHtml(view())).toMatch(/class="primary start" data-act="start" disabled/);
    expect(optionsHtml(view({ st: { ...initialLauncher(), account: 'a', repo: '/r/x' } }))).not.toMatch(/data-act="start" disabled/);
  });
  it('lists matching repos, and explains empty cases', () => {
    expect(reposHtml(view({ st: { ...initialLauncher(), account: 'a', query: 'tide' } }))).toContain('tidepool-ui');
    expect(reposHtml(view({ st: { ...initialLauncher(), account: 'a', query: 'zzz' } }))).toContain('No match');
    expect(reposHtml(view({ st: initialLauncher() }))).toContain('Pick an account first');
    expect(reposHtml(view({ repos: [] }))).toContain('No repositories found');
  });
});

// Task 46: the real model list (newest of each family, then More ▾) and the permission Mode, with bypass behind a confirm.
describe('launcher: models and Mode (Task 46)', () => {
  const full = { accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true,
    models: ['claude-opus-5-5', 'claude-sonnet-5-5'], moreModels: ['claude-opus-4-8', 'claude-sonnet-5'],
    modelNames: { 'claude-opus-5-5': 'Opus 5.5', 'claude-sonnet-5-5': 'Sonnet 5.5', 'claude-opus-4-8': 'Opus 4.8', 'claude-sonnet-5': 'Sonnet 5' },
    efforts: [], remoteControl: false, modes: ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'] }] };
  const v = (st: object = {}) => view({ opts: full, st: { ...initialLauncher(), account: 'a', repo: '/r/x', ...st } });
  const opts = (h: string, name: string) => [...h.matchAll(new RegExp(`<select data-opt="${name}"[^>]*>([\\s\\S]*?)</select>`, 'g'))][0][1];

  it('shows the newest of each family by display name, then More ▾; More opened lists the rest', () => {
    const h = opts(optionsHtml(v()), 'model');
    expect([...h.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => m[2])).toEqual(['default', 'Opus 5.5', 'Sonnet 5.5', 'More ▾']);
    expect(h).not.toContain('Opus 4.8');
    const open = opts(optionsHtml(v({ moreModels: true })), 'model');
    expect(open).toMatch(/<optgroup label="More">[\s\S]*Opus 4\.8[\s\S]*Sonnet 5</);
    expect(open).not.toContain('More ▾');
    // A model chosen from More stays visible (and selected) when redrawn.
    expect(opts(optionsHtml(v({ model: 'claude-sonnet-5' })), 'model')).toMatch(/value="claude-sonnet-5" selected/);
  });

  it('keeps a model from More, resets one the account lacks', () => {
    expect(normalise({ ...initialLauncher(), account: 'a', model: 'claude-opus-4-8' }, full).model).toBe('claude-opus-4-8');
    expect(normalise({ ...initialLauncher(), account: 'a', model: 'claude-opus-1' }, full).model).toBe('');
  });

  it('shows the Mode select with Manual as the default and readable labels', () => {
    const h = opts(optionsHtml(v()), 'permissionMode');
    expect([...h.matchAll(/<option value="([^"]*)"[^>]*>([^<]*)</g)].map((m) => `${m[1]}=${m[2]}`)).toEqual([
      '=Manual (default)', 'acceptEdits=Accept edits', 'auto=Auto', 'plan=Plan', 'dontAsk=Don&#39;t ask', 'bypassPermissions=⚠ Bypass permissions']);
    expect(optionsHtml(view({ st: { ...initialLauncher(), account: 'b' } }))).not.toContain('data-opt="permissionMode"');
  });

  it('bypass: warning colour, a one-line warning, and Start stays off until the confirm is ticked', () => {
    const h = optionsHtml(v({ permissionMode: 'bypassPermissions' }));
    expect(h).toMatch(/<select data-opt="permissionMode" class="warn"/);
    expect(h).toMatch(/<p class="warn bypass-warn">[^<]+<\/p>/);
    expect(h).toContain('data-opt="bypassConfirmed"');
    expect(h).toMatch(/data-act="start" disabled/);
    expect(canStart({ ...initialLauncher(), account: 'a', repo: '/r/x', permissionMode: 'bypassPermissions' }, full, false)).toBe(false);
    expect(canStart({ ...initialLauncher(), account: 'a', repo: '/r/x', permissionMode: 'bypassPermissions', bypassConfirmed: true }, full, false)).toBe(true);
    expect(optionsHtml(v({ permissionMode: 'bypassPermissions', bypassConfirmed: true }))).not.toMatch(/data-act="start" disabled/);
    expect(optionsHtml(v({ permissionMode: 'plan' }))).not.toContain('bypassConfirmed');
  });

  it('a mode change drops the confirm; the body carries the mode and, for bypass, the confirm', () => {
    expect(normalise({ ...initialLauncher(), account: 'a', permissionMode: 'plan', bypassConfirmed: true }, full).bypassConfirmed).toBe(false);
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x', permissionMode: 'plan' }).options).toEqual({ permissionMode: 'plan', remoteControl: false, openOnPc: false });
    expect(launchBody({ ...initialLauncher(), account: 'a', repo: '/r/x', permissionMode: 'bypassPermissions', bypassConfirmed: true }).options)
      .toEqual({ permissionMode: 'bypassPermissions', confirmBypass: true, remoteControl: false, openOnPc: false });
    expect(normalise({ ...initialLauncher(), account: 'b', permissionMode: 'plan' }, opts_b()).permissionMode).toBe('');
  });
  const opts_b = () => ({ accounts: [{ ...full.accounts[0], id: 'b', modes: [] }] });
});

// Task 47: the configured default mode (launch.defaultMode, Auto unless set) is preselected and labelled "(default)".
describe('launcher: the default Mode (Task 47)', () => {
  const acct = { id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true, models: [], efforts: [], remoteControl: false,
    modes: ['acceptEdits', 'auto', 'plan', 'dontAsk', 'bypassPermissions'], defaultMode: 'auto' };
  const withDefault = (defaultMode: string, modes = acct.modes) => ({ accounts: [{ ...acct, modes, defaultMode }] });
  const labels = (o: ReturnType<typeof withDefault>, st: object = {}) => {
    const h = [...optionsHtml(view({ opts: o, st: { ...initialLauncher(), account: 'a', repo: '/r/x', ...st } })).matchAll(/<select data-opt="permissionMode"[^>]*>([\s\S]*?)<\/select>/g)][0][1];
    return [...h.matchAll(/<option value="([^"]*)"([^>]*)>([^<]*)</g)].map((m) => `${m[1]}=${m[3]}${m[2].includes('selected') ? ' *' : ''}`);
  };

  it('preselects the account\'s default mode until the user picks one, and labels it (default)', () => {
    const st = normalise({ ...initialLauncher(), account: 'a' }, withDefault('auto'));
    expect(st.permissionMode).toBe('auto');
    expect(labels(withDefault('auto'), st)).toEqual(['=Manual', 'acceptEdits=Accept edits', 'auto=Auto (default) *', 'plan=Plan', 'dontAsk=Don&#39;t ask', 'bypassPermissions=⚠ Bypass permissions']);
    // A hand-picked mode (Manual included) is kept; the label stays on the default.
    expect(normalise({ ...st, permissionMode: '', modeChosen: true }, withDefault('auto')).permissionMode).toBe('');
    expect(normalise({ ...st, permissionMode: 'plan', modeChosen: true }, withDefault('auto')).permissionMode).toBe('plan');
    expect(labels(withDefault('auto'), { permissionMode: 'plan', modeChosen: true })).toContain('auto=Auto (default)');
  });

  it('a host whose claude lacks the default falls back to Manual, labelled (default)', () => {
    const o = withDefault('', ['acceptEdits', 'plan']);
    const st = normalise({ ...initialLauncher(), account: 'a' }, o);
    expect(st.permissionMode).toBe('');
    expect(labels(o, st)).toEqual(['=Manual (default) *', 'acceptEdits=Accept edits', 'plan=Plan']);
    // A hand-picked mode this account does not offer falls back to its default.
    expect(normalise({ ...initialLauncher(), account: 'a', permissionMode: 'auto', modeChosen: true }, o).permissionMode).toBe('');
  });

  it('a Start that keeps the default sends it explicitly; Manual still sends nothing', () => {
    const st = normalise({ ...initialLauncher(), account: 'a', repo: '/r/x' }, withDefault('auto'));
    expect(launchBody(st).options).toEqual({ permissionMode: 'auto', remoteControl: false, openOnPc: false });
    expect(launchBody(normalise({ ...st, permissionMode: '', modeChosen: true }, withDefault('auto'))).options).toEqual({ remoteControl: false, openOnPc: false });
  });

  it('bypass as the owner\'s default needs no tick (the warning stays); bypass by hand still does', () => {
    const own = withDefault('bypassPermissions');
    const st = normalise({ ...initialLauncher(), account: 'a', repo: '/r/x' }, own);
    expect(st.permissionMode).toBe('bypassPermissions');
    expect(canStart(st, own, false)).toBe(true);
    const h = optionsHtml(view({ opts: own, st }));
    expect(h).toMatch(/<p class="warn bypass-warn">/);
    expect(h).not.toContain('data-opt="bypassConfirmed"');
    expect(h).not.toMatch(/data-act="start" disabled/);
    expect(labels(own, st)).toContain('bypassPermissions=⚠ Bypass permissions (default) *');
    expect(launchBody(st).options).toEqual({ permissionMode: 'bypassPermissions', remoteControl: false, openOnPc: false });
    const hand = normalise({ ...initialLauncher(), account: 'a', repo: '/r/x', permissionMode: 'bypassPermissions', modeChosen: true }, withDefault('auto'));
    expect(canStart(hand, withDefault('auto'), false)).toBe(false);
    expect(optionsHtml(view({ opts: withDefault('auto'), st: hand }))).toContain('data-opt="bypassConfirmed"');
  });
});

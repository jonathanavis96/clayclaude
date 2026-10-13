// @vitest-environment happy-dom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { openLauncher } from '../web/src/launcher.js';

const options = { accounts: [
  { id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true, models: ['opus'], efforts: [], remoteControl: false },
  { id: 'b', label: 'Lab', colour: '#4fd1c5', host: 'rack', canLaunch: true, models: ['opus'], efforts: [], remoteControl: false },
] };

const deferred = <T>() => { let resolve!: (v: T) => void; const p = new Promise<T>((r) => { resolve = r; }); return { p, resolve }; };
const flush = () => new Promise((r) => setTimeout(r, 0));
const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response;

afterEach(() => { vi.unstubAllGlobals(); });

describe('openLauncher', () => {
  it('mounts a clay character per account once the options arrive, and stops them on close', async () => {
    const d = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => d.p));
    const stop = vi.fn();
    const clay = { mountState: vi.fn(() => stop) };
    openLauncher({ getState: () => null, clay: clay as any });
    d.resolve(json(options)); await flush();
    expect(clay.mountState).toHaveBeenCalledTimes(2);
    document.querySelector<HTMLElement>('.launcher [data-act="close"]')!.click();
    expect(stop).toHaveBeenCalledTimes(2);
  });

  it('mounts no clay characters when closed before the options arrive', async () => {
    const d = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn(() => d.p));
    const clay = { mountState: vi.fn(() => () => {}) };
    openLauncher({ getState: () => null, clay: clay as any });
    document.querySelector<HTMLElement>('.launcher [data-act="close"]')!.click();
    d.resolve(json(options)); await flush();
    expect(clay.mountState).not.toHaveBeenCalled();
  });
  // Found on the tablet (Task 23): a failed start under one account left its error under the next account's options.
  it('clears a failed start\'s error when another account or repository is picked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url === '/api/launch/options') return json(options);
      if (url.startsWith('/api/repos')) return json({ ok: true, repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }, { path: '/q', name: 'q', lastUsedMs: 0 }] });
      return json({ ok: false, error: 'failed', message: 'tmux: no server running (simulated)' });
    }));
    openLauncher({ getState: () => null, clay: { mountState: () => () => {} } as any });
    await flush();
    const click = async (sel: string) => { document.querySelector<HTMLElement>(sel)!.click(); await flush(); await flush(); };
    const warn = () => document.querySelector('#l-opts .warn')?.textContent ?? '';
    await click('.acct[data-id="a"]'); await click('.repo[data-path="/r"]'); await click('.start');
    expect(warn()).toContain('no server running');
    await click('.repo[data-path="/q"]');
    expect(warn()).toBe('');
    await click('.start'); expect(warn()).toContain('no server running');
    await click('.acct[data-id="b"]');
    expect(warn()).toBe('');
    document.querySelector<HTMLElement>('.launcher [data-act="close"]')!.click();
  });
  // The compact keyboard layout (overlay.css) hides the account column only once an account is picked.
  it('marks the steps has-account only after an account is picked', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => url === '/api/launch/options' ? json(options) : json({ ok: true, repos: [] })));
    openLauncher({ getState: () => null, clay: { mountState: () => () => {} } as any });
    await flush();
    const steps = () => document.querySelector('.launcher .steps')!;
    expect(steps().classList.contains('has-account')).toBe(false);
    document.querySelector<HTMLElement>('.acct[data-id="a"]')!.click(); await flush();
    expect(steps().classList.contains('has-account')).toBe(true);
    document.querySelector<HTMLElement>('.launcher [data-act="close"]')!.click();
  });
  // Task 42a: an optional Name, sent with Start. Typing never redraws the options, so the keyboard stays up and the
  // tap on Start that ends the typing is not lost to a redraw.
  it('sends the Name typed in Options with Start, and typing does not redraw the field', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/launch/options') return json(options);
      if (url.startsWith('/api/repos')) return json({ ok: true, repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }] });
      bodies.push(JSON.parse(String(init!.body)));
      return json({ ok: true, message: 'Started' });
    }));
    openLauncher({ getState: () => null, clay: { mountState: () => () => {} } as any });
    await flush();
    const click = async (sel: string) => { document.querySelector<HTMLElement>(sel)!.click(); await flush(); await flush(); };
    await click('.acct[data-id="a"]'); await click('.repo[data-path="/r"]');
    const f = document.querySelector<HTMLTextAreaElement>('#l-name')!;
    expect(f.maxLength).toBe(40);
    expect(f.closest('label')!.textContent).toMatch(/Name/);
    f.value = 'api work';
    f.dispatchEvent(new Event('input', { bubbles: true }));
    f.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector('#l-name')).toBe(f);
    // Enter in the one-line field does not add a line
    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    f.dispatchEvent(enter);
    expect(enter.defaultPrevented).toBe(true);
    await click('.start');
    expect(bodies).toEqual([{ action: 'launch', account: 'a', repo: '/r', options: { name: 'api work', remoteControl: false, openOnPc: false } }]);
  });
});

describe('openLauncher: More ▾ and the bypass confirm (Task 46)', () => {
  const full = { accounts: [{ id: 'a', label: 'Studio', colour: '#e8b54a', host: 'desk', canLaunch: true,
    models: ['claude-opus-5-5'], moreModels: ['claude-opus-4-8'], modelNames: { 'claude-opus-5-5': 'Opus 5.5', 'claude-opus-4-8': 'Opus 4.8' },
    efforts: [], remoteControl: false, modes: ['plan', 'bypassPermissions'] }] };
  it('choosing More ▾ opens the rest of the list and keeps the model as it was; bypass needs the tick before Start', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/launch/options') return json(full);
      if (url.startsWith('/api/repos')) return json({ ok: true, repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }] });
      posts.push(JSON.parse(String(init?.body))); return json({ ok: true, message: 'started' });
    }));
    openLauncher({ getState: () => null, clay: { mountState: () => () => {} } as any });
    await flush();
    const click = async (sel: string) => { document.querySelector<HTMLElement>(sel)!.click(); await flush(); await flush(); };
    const choose = (name: string, value: string) => {
      const s = document.querySelector<HTMLSelectElement>(`select[data-opt="${name}"]`)!;
      s.value = value; s.dispatchEvent(new Event('change', { bubbles: true }));
    };
    await click('.acct[data-id="a"]'); await click('.repo[data-path="/r"]');
    choose('model', '__more');
    const sel = document.querySelector<HTMLSelectElement>('select[data-opt="model"]')!;
    expect(sel.querySelector('optgroup[label="More"] option[value="claude-opus-4-8"]')).not.toBeNull();
    expect(sel.value).toBe('');
    choose('model', 'claude-opus-4-8');
    choose('permissionMode', 'bypassPermissions');
    expect(document.querySelector<HTMLButtonElement>('.start')!.disabled).toBe(true);
    const tick = document.querySelector<HTMLInputElement>('input[data-opt="bypassConfirmed"]')!;
    tick.checked = true; tick.dispatchEvent(new Event('change', { bubbles: true }));
    expect(document.querySelector<HTMLButtonElement>('.start')!.disabled).toBe(false);
    // Focusing the Name puts the column back at its top, where the compact (keyboard) layout keeps Start.
    const col = document.querySelector<HTMLElement>('#l-opts')!;
    col.scrollTop = 40;
    document.querySelector<HTMLTextAreaElement>('#l-name')!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(col.scrollTop).toBe(0);
    await click('.start');
    expect(posts[0].options).toMatchObject({ model: 'claude-opus-4-8', permissionMode: 'bypassPermissions', confirmBypass: true });
  });
});

describe('openLauncher: the default Mode (Task 47)', () => {
  const acct = (id: string, modes: string[], defaultMode: string) => ({ id, label: id, colour: '#e8b54a', host: 'desk', canLaunch: true, models: [], efforts: [], remoteControl: false, modes, defaultMode });
  it('preselects each account\'s default, Manual where its claude lacks it, and a Start keeps it', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/api/launch/options') return json({ accounts: [acct('a', ['acceptEdits', 'auto', 'plan'], 'auto'), acct('b', ['plan'], '')] });
      if (url.startsWith('/api/repos')) return json({ ok: true, repos: [{ path: '/r', name: 'r', lastUsedMs: 0 }] });
      posts.push(JSON.parse(String(init?.body))); return json({ ok: false, message: 'no' });
    }));
    openLauncher({ getState: () => null, clay: { mountState: () => () => {} } as any });
    await flush();
    const click = async (sel: string) => { document.querySelector<HTMLElement>(sel)!.click(); await flush(); await flush(); };
    const mode = () => document.querySelector<HTMLSelectElement>('select[data-opt="permissionMode"]')!;
    // The option marked selected (happy-dom's select.value does not follow a selected attribute parsed from innerHTML).
    const shown = () => mode().querySelector<HTMLOptionElement>('option[selected]') ?? mode().options[0];
    await click('.acct[data-id="b"]');
    expect(shown().value).toBe('');
    expect(shown().textContent).toBe('Manual (default)');
    await click('.acct[data-id="a"]');
    expect(shown().value).toBe('auto');
    expect(shown().textContent).toBe('Auto (default)');
    await click('.repo[data-path="/r"]');
    await click('.start');
    expect(posts.at(-1).options).toMatchObject({ permissionMode: 'auto' });
    // Picking Manual by hand sticks, and sends no mode.
    mode().value = ''; mode().dispatchEvent(new Event('change', { bubbles: true }));
    expect(shown().value).toBe('');
    expect(shown().textContent).toBe('Manual');
    await click('.start');
    expect(posts.at(-1).options.permissionMode).toBeUndefined();
  });
});

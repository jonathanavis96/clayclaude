// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderBoard, type BoardState } from '../web/src/board.js';
import { DEFAULT_CLAY_PREFS } from '../web/src/clay/prefs.js';
import { DEFAULT_PREFS } from '../web/src/prefs.js';

/**
 * Device rule 4 / Task 36: a needs-you tile shows ONE question affordance. The question bubble itself is a real
 * button that opens the answer sheet; there is no separate Answer / "?" control beside it.
 */
const openAnswerSheet = vi.fn();
const openFocus = vi.fn(() => () => {});
vi.mock('../web/src/answer.js', () => ({ openAnswerSheet: (...a: unknown[]) => (openAnswerSheet as any)(...a) }));
vi.mock('../web/src/focus.js', () => ({ openFocus: (...a: unknown[]) => (openFocus as any)(...a) }));
vi.mock('../web/src/net.js', () => ({ getJson: async () => null, postAction: async () => ({ ok: true, message: '' }) }));

const session = (i: number, over: object = {}) => ({
  key: `h:a:s${i}`, host: 'h', account: 'a', sessionId: `s${i}`, pid: i, name: `sess${i}`, cwd: '/',
  state: 'working', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40, ...over,
}) as any;
const board = (...sessions: object[]): BoardState => ({
  sessions: sessions.map((o, i) => session(i, o)), usage: [], accounts: [], cacheTtlMinutes: 60, serverTime: 0, clockSkew: 0,
});
const ASK = { state: 'needs-you', question: 'Which DB?', tmux: 'h:@1.%1' };

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; openAnswerSheet.mockClear(); openFocus.mockClear(); });
const tile = (layout: string) => root.querySelector<HTMLElement>(layout === 'grid' ? '.gcard' : '.row')!;

describe.each(['strips', 'grid'] as const)('%s: the question bubble is the one question control', (layout) => {
  it('a needs-you tile has exactly one answer control, the bubble, and no separate Answer or "?" button', () => {
    renderBoard(root, board(ASK), { meters: 'rings', layout });
    const t = tile(layout);
    const controls = t.querySelectorAll('[data-act="answer"]');
    expect(controls).toHaveLength(1);
    const bubble = controls[0] as HTMLElement;
    expect(bubble.tagName).toBe('BUTTON');
    expect(bubble.classList.contains('action')).toBe(true);
    expect(bubble.textContent).toBe('Which DB?');
    expect(bubble.dataset.key).toBe('h:a:s0');
    expect(bubble.getAttribute('aria-label')).toContain('Which DB?');
    expect(t.querySelector('.answer-btn')).toBeNull();
    expect(t.querySelectorAll('button')).toHaveLength(1);
    expect([...t.querySelectorAll('*')].some((e) => e.textContent!.trim() === '?' || e.textContent!.trim() === 'Answer')).toBe(false);
  });

  it('the bubble text and its aria-label are escaped', () => {
    renderBoard(root, board({ ...ASK, question: '"a" & <b>x</b><img src=x onerror=alert(1)>' }), { meters: 'rings', layout });
    const t = tile(layout);
    expect(t.querySelector('b, img')).toBeNull();
    const bubble = t.querySelector<HTMLElement>('[data-act="answer"]')!;
    expect(bubble.textContent).toBe('"a" & <b>x</b><img src=x onerror=alert(1)>');
    expect(bubble.getAttribute('aria-label')).toContain('"a" & <b>x</b><img src=x onerror=alert(1)>');
  });

  it('only a session that can be answered gets a bubble button: no tmux keeps Open, offline gets none', () => {
    renderBoard(root, board({ ...ASK, tmux: undefined, bridgeSessionId: 'session_x' }, { ...ASK, hostOnline: false }, { state: 'working', currentAction: 'Bash: x' }), { meters: 'rings', layout });
    const [open, off, work] = [...root.querySelectorAll<HTMLElement>(layout === 'grid' ? '.gcard' : '.row')];
    expect(open.querySelector('[data-act="answer"]')).toBeNull();
    expect(open.querySelector('[data-act="open"]')).not.toBeNull();
    expect(open.querySelector('.action')!.tagName).toBe('DIV');
    expect(off.querySelector('button')).toBeNull();
    expect(work.querySelector('button')).toBeNull();
  });

  it('tapping the bubble opens the answer sheet for that session, not the focus view', async () => {
    const { initApp } = await import('../web/src/app.js');
    const state = board({ state: 'working' }, ASK, { ...ASK, question: 'Other?', tmux: 'h:@2.%2' });
    const clay = { sync() {}, mountLarge: () => () => {}, mountState: () => () => {}, setPrefs() {}, status: () => ({ mode: 'bake', reason: '', baked: 0, total: 0 }), dispose() {} } as any;
    initApp({ root, getState: () => state, getPrefs: () => DEFAULT_PREFS, setPrefs() {}, getClayPrefs: () => DEFAULT_CLAY_PREFS, setClayPrefs() {}, clay });
    renderBoard(root, state, { meters: 'rings', layout });
    root.querySelector<HTMLElement>('[data-key="h:a:s1"] .action')!.click();   // the bubble (the question text) itself
    expect(openAnswerSheet).toHaveBeenCalledTimes(1);
    expect((openAnswerSheet.mock.calls[0] as any)[0].session.key).toBe('h:a:s1');
    expect(openFocus).not.toHaveBeenCalled();
  });
});

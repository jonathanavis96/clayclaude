// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { originText, renderBoard, type BoardState } from '../web/src/board.js';
import { actionHtml, rowActionsHtml } from '../web/src/row-actions.js';
import { focusModel } from '../web/src/focus-model.js';
import { renderSheet } from '../web/src/answer-view.js';
import { afterReread, waitOutcome, RESPONSE_TIMEOUT_MS, CLOUD_RESPONSE_TIMEOUT_MS } from '../web/src/answer-model.js';

const base = { key: 'local:main:s1', host: 'local', account: 'main', sessionId: 's1', pid: 1, name: 'orchard', cwd: '/', tmux: 'work:@1.%1',
  state: 'needs-you', question: 'Pick one', stateSince: 0, live: true, overContext: false, hostOnline: true, lastSeen: 0, contextPct: 40 } as any;
const cloud = (o: object = {}) => ({ ...base, key: 'cloud:session_01X', sessionId: 'session_01X', pid: 0, cwd: '', tmux: undefined, name: 'Fix login',
  cloud: true, origin: 'this PC', originTask: 'fix-login', repo: 'example/widgets', ...o }) as any;
const state = (sessions: object[]): BoardState => ({ sessions: sessions as any, usage: [], accounts: [{ id: 'main', label: 'Main', colour: '#fff', host: 'local' }],
  cacheTtlMinutes: 5, serverTime: 0, clockSkew: 0 });
const measure = () => ({ avail: 1000, row: 50, gap: 4 });

/** The rows of a local needs-you and a local asleep session as renderBoard drew them before cloud sessions (ages left out). */
const LOCAL_ROWS: string[] = ["<div class=\"row st-needs-you\" data-key=\"local:main:s1\">\n    <div class=\"char\" data-state=\"needs-you\" data-key=\"local:main:s1\"><div class=\"ph\"><i></i><i></i></div></div>\n    <div class=\"who\"><div class=\"name\">orchard</div><div class=\"meta\">Main · local · work</div></div>\n    <button class=\"action qbubble\" data-act=\"answer\" data-key=\"local:main:s1\" aria-label=\"Answer: Pick one\"><span>Pick one</span></button>\n    <div class=\"ctx\">40%<span class=\"ctxbar\"><span style=\"width:40%\"></span></span></div>\n    \n    <div class=\"word\">NEEDS YOU</div>\n  </div>", "<div class=\"row st-asleep\" data-key=\"local:main:s2\">\n    <div class=\"char\" data-state=\"asleep\" data-key=\"local:main:s2\"><div class=\"ph\"><i></i><i></i></div></div>\n    <div class=\"who\"><div class=\"name\">orchard</div><div class=\"meta\">Main · local · work</div></div>\n    <div class=\"action\">Waiting for the next prompt</div>\n    <div class=\"ctx\">40%<span class=\"ctxbar\"><span style=\"width:40%\"></span></span></div>\n    \n    <div class=\"word\">ASLEEP</div><div class=\"acts\"><button class=\"answer-btn\" data-act=\"message\" data-key=\"local:main:s2\">Message</button></div>\n  </div>"];

let root: HTMLElement;
beforeEach(() => { document.body.innerHTML = '<div id="app"></div>'; root = document.getElementById('app')!; });

describe('cloud sessions on the board', () => {
  it('cloud needs-you row has an answer bubble and no Open or Attach', () => {
    expect(actionHtml(cloud(), 'Pick one')).toContain('data-act="answer"');
    expect(rowActionsHtml(cloud())).toBe('');
    expect(actionHtml(cloud({ hostOnline: false }), 'Pick one')).not.toContain('data-act="answer"');
  });

  it('asleep cloud row offers Message', () => {
    expect(rowActionsHtml(cloud({ state: 'asleep' }))).toContain('data-act="message"');
    expect(rowActionsHtml(cloud({ state: 'working' }))).toBe('');
  });

  it('row meta shows cloud, origin and repo', () => {
    renderBoard(root, state([cloud()]), { meters: 'rings', layout: 'strips' }, { measure });
    const row = root.querySelector<HTMLElement>('.row[data-key="cloud:session_01X"]')!;
    expect(row.classList.contains('cloud')).toBe(true);
    expect(row.querySelector('.meta')!.textContent).toBe('Main · cloud · from this PC (fix-login) · example/widgets');
    expect(originText(cloud({ origin: 'gs', originTask: undefined }))).toBe('from gs');
    expect(originText(cloud({ origin: 'claude.ai', originTask: undefined }))).toBe('from claude.ai');
    expect(originText(cloud({ origin: undefined }))).toBe('');
  });

  it('grid card shows the origin line only for cloud cards', () => {
    renderBoard(root, state([cloud(), cloud({ key: 'cloud:session_01Y', origin: undefined }), base]), { meters: 'rings', layout: 'grid' }, { measure });
    const card = (k: string) => root.querySelector<HTMLElement>(`.gcard[data-key="${k}"]`)!;
    expect(card('cloud:session_01X').classList.contains('cloud')).toBe(true);
    expect(card('cloud:session_01X').querySelector('.meta')!.textContent).toBe('from this PC (fix-login)');
    expect(card('cloud:session_01Y').querySelector('.meta')).toBeNull();
    expect(card('local:main:s1').querySelector('.meta')).toBeNull();
    expect(card('local:main:s1').classList.contains('cloud')).toBe(false);
  });

  it('focus view offers Answer and Open, not Attach, for cloud', () => {
    const v = focusModel(cloud(), null, 0, 'Main');
    expect(v).toMatchObject({ canAnswer: true, canOpen: true, canAttach: false, meta: 'Main · cloud · from this PC (fix-login) · example/widgets' });
    expect(focusModel(cloud({ hostOnline: false }), null, 0, 'Main')).toMatchObject({ canAnswer: false, canOpen: true });
    expect(focusModel(cloud({ state: 'asleep' }), null, 0, 'Main')).toMatchObject({ canMessage: true });
  });

  it('sheet for a cloud session has no Attach tmux and labels Open for claude.ai', () => {
    const h = renderSheet({ phase: 'error', message: 'x' }, cloud(), [], '');
    expect(h).not.toContain('attach-pc');
    expect(h).toContain('Open on claude.ai');
    const perm = { kind: 'permission', hash: 'h', title: '', detail: 'Bash: date', quickReplies: [],
      options: [{ key: 'yes', label: 'Yes', selected: false }, { key: 'no', label: 'No', selected: false }] } as any;
    const p = renderSheet({ phase: 'ready', prompt: perm, context: {} }, cloud(), [], '');
    expect(p).not.toContain('attach-pc');
    expect(p).toContain('Other choices are on claude.ai.');
    expect(renderSheet({ phase: 'noresponse' } as any, cloud(), [], '')).not.toContain('attach-pc');
    // A local session's sheet is unchanged.
    expect(renderSheet({ phase: 'error', message: 'x' }, base, [], '')).toContain('data-act="attach-pc"');
  });

  it('a local session renders exactly as before', () => {
    renderBoard(root, state([base, { ...base, key: 'local:main:s2', sessionId: 's2', state: 'asleep', question: undefined }]), { meters: 'rings', layout: 'strips' }, { measure });
    const rows = [...root.querySelectorAll('.row')].map((r) => r.outerHTML.replace(/<div class="age">[^<]*<\/div>/, ''));
    expect(rows).toEqual(LOCAL_ROWS);
  });
  it('the sheet waits longer for a cloud session to respond than for a tmux pane', () => {
    const w = { phase: 'waiting' as const, since: 0, hash: 'h', question: 'Pick one', stateSince: 0 };
    const t = RESPONSE_TIMEOUT_MS + 5000;
    expect(t).toBeLessThan(CLOUD_RESPONSE_TIMEOUT_MS);
    expect(waitOutcome(w, base, t)).toBe('reread');
    expect(waitOutcome(w, cloud(), t)).toBe(w);
    const same = { ok: true as const, prompt: { kind: 'menu', hash: 'h', title: '', detail: '', options: [], quickReplies: [] } as any };
    expect(afterReread(same, w, base, t)).toEqual({ phase: 'noresponse' });
    expect(afterReread(same, w, cloud(), t)).toMatchObject({ phase: 'waiting' });
    expect(afterReread(same, w, cloud(), CLOUD_RESPONSE_TIMEOUT_MS)).toEqual({ phase: 'noresponse' });
  });
});

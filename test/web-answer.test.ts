import { describe, it, expect } from 'vitest';
import { afterSend, fromRead, pendingFor, waitOutcome, RESPONSE_TIMEOUT_MS } from '../web/src/answer-model.js';
import { renderSheet } from '../web/src/answer-view.js';

const menu = { kind: 'menu', hash: 'h1', title: 'Do you want to proceed?', detail: 'Bash command\nnpm test', quickReplies: [],
  options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No <b>', selected: false, description: 'stop' }] } as any;
const text = { kind: 'text', hash: 'h2', title: '', detail: '', options: [], quickReplies: ['yes', 'no'] } as any;
const session = { key: 'k', name: 'orchard <api>', account: 'studio', host: 'desk' } as any;

describe('answer sheet model', () => {
  it('turns a read into a ready sheet or an error', () => {
    expect(fromRead({ ok: true, prompt: menu, question: 'q', lastAssistantText: 'l' })).toMatchObject({ phase: 'ready', context: { question: 'q', lastAssistantText: 'l' } });
    expect(fromRead({ ok: false, error: 'no_prompt', message: 'nothing is waiting' })).toEqual({ phase: 'error', message: 'nothing is waiting' });
  });
  it('labels what is about to be sent', () => {
    expect(pendingFor(menu, { choice: '2' }).label).toBe('No <b>');
    expect(pendingFor(text, { text: 'go on' })).toEqual({ text: 'go on', label: 'go on' });
  });
  it('a changed prompt returns to ready with the new prompt and a notice, nothing sent', () => {
    const ready = { phase: 'ready' as const, prompt: menu, context: { question: 'q' } };
    const s = afterSend({ ok: false, error: 'prompt_changed', message: 'changed', prompt: text }, ready, 5);
    expect(s).toMatchObject({ phase: 'ready', prompt: text, context: { question: 'q' }, notice: expect.stringContaining('nothing was sent') });
    expect(afterSend({ ok: true, sent: 'option 1' }, ready, 5)).toEqual({ phase: 'waiting', since: 5 });
    expect(afterSend({ ok: false, error: 'pane_gone', message: 'gone' }, ready, 5)).toEqual({ phase: 'error', message: 'gone' });
    const none = { kind: 'none', hash: 'n', title: '', detail: '', options: [], quickReplies: [] } as any;
    expect(afterSend({ ok: false, error: 'no_prompt', message: 'nothing is waiting', prompt: none }, ready, 5)).toEqual({ phase: 'error', message: 'nothing is waiting' });
    expect(afterSend({ ok: false, error: 'duplicate', message: 'just sent', prompt: menu }, ready, 5)).toMatchObject({ phase: 'ready', notice: 'just sent' });
  });
  it('closes when the session leaves needs-you, and times out after 10 s', () => {
    const w = { phase: 'waiting' as const, since: 1000 };
    expect(waitOutcome(w, { state: 'working' } as any, 2000)).toBe('done');
    expect(waitOutcome(w, undefined, 2000)).toBe('done');
    expect(waitOutcome(w, { state: 'needs-you' } as any, 2000)).toEqual(w);
    expect(waitOutcome(w, { state: 'needs-you' } as any, 1000 + RESPONSE_TIMEOUT_MS)).toEqual({ phase: 'noresponse' });
  });
});

describe('answer sheet html', () => {
  it('renders one large button per option, escaping labels', () => {
    const h = renderSheet({ phase: 'ready', prompt: menu, context: { lastAssistantText: 'I need to run the tests.' } }, session, [], '');
    expect(h.match(/data-act="choose"/g)).toHaveLength(2);
    expect(h).toContain('No &lt;b&gt;');
    expect(h).toContain('orchard &lt;api&gt;');
    expect(h).toContain('I need to run the tests.');
    expect(h).toContain('<small>stop</small>');
  });
  it('renders the reply box with quick replies for free text, and the fallback buttons', () => {
    const h = renderSheet({ phase: 'ready', prompt: text, context: { question: 'Update the changelog?' } }, session, ['yes', 'no', 'continue'], 'draft');
    expect(h.match(/data-act="quick"/g)).toHaveLength(3);
    expect(h).toContain('>draft</textarea>');
    expect(h).toContain('Update the changelog?');
    const n = renderSheet({ phase: 'noresponse' }, session, [], '');
    expect(n).toContain('No response from the session');
    expect(n).toContain('Attach tmux');
    expect(renderSheet({ phase: 'confirm', prompt: menu, context: {}, pending: { choice: '1', label: 'Yes' } }, session, [], '')).toContain('data-act="confirm-yes"');
  });
});

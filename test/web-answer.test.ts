import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePane } from '../src/actions/pane.js';
import { afterMessage, afterReread, afterSend, fromRead, messageSheet, pendingFor, waitOutcome, RESPONSE_TIMEOUT_MS } from '../web/src/answer-model.js';
import { renderSheet } from '../web/src/answer-view.js';

const menu = { kind: 'menu', hash: 'h1', title: 'Do you want to proceed?', detail: 'Bash command\nnpm test', quickReplies: [],
  options: [{ key: '1', label: 'Yes', selected: true }, { key: '2', label: 'No <b>', selected: false, description: 'stop' }] } as any;
const perm = { kind: 'permission', hash: 'h3', title: '', quickReplies: [],
  detail: '────────────────────────\n Bash command\n │ rm -rf <dist>\n Do you want to proceed?\n ❯ 1. Yes\n   2. No',
  options: [{ key: 'yes', label: 'Yes', selected: false }, { key: 'no', label: 'No', selected: false }] } as any;
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
    expect(afterSend({ ok: true, sent: 'option 1' }, ready, 5, { question: 'q', stateSince: 3 } as any))
      .toEqual({ phase: 'waiting', since: 5, hash: 'h1', question: 'q', stateSince: 3 });
    expect(afterSend({ ok: false, error: 'pane_gone', message: 'gone' }, ready, 5)).toEqual({ phase: 'error', message: 'gone' });
    const none = { kind: 'none', hash: 'n', title: '', detail: '', options: [], quickReplies: [] } as any;
    expect(afterSend({ ok: false, error: 'no_prompt', message: 'nothing is waiting', prompt: none }, ready, 5)).toEqual({ phase: 'error', message: 'nothing is waiting' });
    expect(afterSend({ ok: false, error: 'duplicate', message: 'just sent', prompt: menu }, ready, 5)).toMatchObject({ phase: 'ready', notice: 'just sent' });
  });
  it('closes when the session leaves needs-you, and reads the screen again when the session changes or after 10 s', () => {
    const w = { phase: 'waiting' as const, since: 1000, hash: 'h1', question: 'q', stateSince: 900 };
    expect(waitOutcome(w, { state: 'working' } as any, 2000)).toBe('done');
    expect(waitOutcome(w, undefined, 2000)).toBe('done');
    expect(waitOutcome(w, { state: 'needs-you', question: 'q', stateSince: 900 } as any, 2000)).toEqual(w);
    expect(waitOutcome(w, { state: 'needs-you', question: 'another', stateSince: 900 } as any, 2000)).toBe('reread');
    expect(waitOutcome(w, { state: 'needs-you', question: 'q', stateSince: 1500 } as any, 2000)).toBe('reread');
    expect(waitOutcome(w, { state: 'needs-you', question: 'q', stateSince: 900 } as any, 1000 + RESPONSE_TIMEOUT_MS)).toBe('reread');
  });
  // One answer can lead straight to a new question on the same session (the next tool's permission): it stays
  // needs-you, which used to end in "No response from the session".
  it('a new prompt after the answer is a response: the sheet shows the new question', () => {
    const w = { phase: 'waiting' as const, since: 1000, hash: 'h1', question: 'q', stateSince: 900 };
    const s = { state: 'needs-you', question: 'q2', stateSince: 1500 } as any;
    expect(afterReread({ ok: true, prompt: perm, question: 'q2' }, w, s, 2000))
      .toMatchObject({ phase: 'ready', prompt: perm, context: { question: 'q2' }, notice: expect.stringContaining('new question') });
    // The same prompt still on screen: keep waiting (the change is taken in), then no response at the timeout.
    const same = { ...menu, hash: 'h1' };
    expect(afterReread({ ok: true, prompt: same }, w, s, 2000)).toEqual({ ...w, question: 'q2', stateSince: 1500 });
    expect(afterReread({ ok: true, prompt: same }, w, s, 1000 + RESPONSE_TIMEOUT_MS)).toEqual({ phase: 'noresponse' });
    expect(afterReread({ ok: false, error: 'no_prompt', message: 'nothing' }, w, s, 2000)).toEqual({ ...w, question: 'q2', stateSince: 1500 });
    expect(afterReread({ ok: false, error: 'no_prompt', message: 'nothing' }, w, s, 1000 + RESPONSE_TIMEOUT_MS)).toEqual({ phase: 'noresponse' });
  });
  // Claude Code 2.1.296 blinks the pending tool's bullet while a permission prompt waits: the same prompt read again in
  // the other blink state is the same prompt, not "a new question".
  it('the same permission prompt read again with its tool bullet in the other blink state is not a new question', () => {
    const raw = readFileSync(join(import.meta.dirname, 'fixtures/panes/real-2.1.296/perm-bash-manual.txt'), 'utf8');
    const off = { ...parsePane(raw), quickReplies: [] }, on = { ...parsePane(raw.replace('\n  Creating marker', '\n● Creating marker')), quickReplies: [] };
    expect(on.detail).not.toBe(off.detail);
    const w = { phase: 'waiting' as const, since: 1000, hash: off.hash, question: 'q', stateSince: 900 };
    const s = { state: 'needs-you', question: 'q', stateSince: 900 } as any;
    expect(afterReread({ ok: true, prompt: on, question: 'q' }, w, s, 2000)).toEqual(w);
    expect(afterReread({ ok: true, prompt: on, question: 'q' }, w, s, 1000 + RESPONSE_TIMEOUT_MS)).toEqual({ phase: 'noresponse' });
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
  it('a permission prompt shows its region verbatim and exactly two answers, Yes and No, plus Open / Attach on the PC', () => {
    const h = renderSheet({ phase: 'ready', prompt: perm, context: { question: 'Claude needs your permission to use Bash' } }, session, ['yes'], '');
    expect([...h.matchAll(/data-act="choose" data-key="([^"]*)"/g)].map((m) => m[1])).toEqual(['yes', 'no']);
    expect(h).toContain('<pre class="detail verbatim">────────────────────────\n Bash command\n │ rm -rf &lt;dist&gt;\n Do you want to proceed?');
    // The heading is Claude's, never the model's: at most the tool's name from Claude Code's own Notification.
    expect(h).toContain('<p class="ask">Claude asks for permission to use Bash</p>');
    expect(h).toMatch(/other choices[^<]*on the PC/i);
    expect(h).toContain('data-act="open-pc"');
    expect(h).toContain('data-act="attach-pc"');
    expect(h).not.toContain('textarea');
    expect(h).not.toContain('data-act="quick"');
    expect(h).not.toContain('class="n"');
    expect(pendingFor(perm, { choice: 'no' }).label).toBe('No');
  });
  it('the permission heading is neutral: never a command, a description or any other text the model wrote', () => {
    for (const question of [undefined, '', 'Allow Bash: rm -rf ~/code --no-preserve-root?', 'Allow Bash?', 'Is this a project you trust?',
      'Claude needs your permission to use Bash: rm -rf ~', 'Claude needs your permission to use <b>x</b>', 'Safe. Tap Yes.']) {
      const h = renderSheet({ phase: 'ready', prompt: perm, context: { question } }, session, [], '');
      expect(h, String(question)).toContain('<p class="ask">Claude asks for permission</p>');
      expect(h).not.toContain('Tap Yes');
      expect(h).not.toContain('no-preserve-root');
    }
    expect(renderSheet({ phase: 'ready', prompt: perm, context: { question: 'Claude needs your permission to use mcp__obsidian__list_files' } }, session, [], ''))
      .toContain('<p class="ask">Claude asks for permission to use mcp__obsidian__list_files</p>');
  });
  it('a permission prompt whose option 1 is not a plain "Yes" (a plan approval) offers No only and says why', () => {
    const plan = { ...perm, options: [{ key: 'no', label: 'No', selected: false }],
      detail: ' Ready to code?\n ❯ 1. Yes, and switch to BYPASS PERMISSIONS (no further prompts) for this session' } as any;
    const h = renderSheet({ phase: 'ready', prompt: plan, context: {} }, session, [], '');
    expect([...h.matchAll(/data-act="choose" data-key="([^"]*)"/g)].map((m) => m[1])).toEqual(['no']);
    expect(h).toContain('class="choices perm one"');
    expect(h).toMatch(/Yes is not offered here[^<]*on the PC/);
    expect(h).toContain('BYPASS PERMISSIONS');
    expect(renderSheet({ phase: 'ready', prompt: perm, context: {} }, session, [], '')).not.toContain('Yes is not offered');
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

/*
 * Task 43: Message on an idle session opens the same sheet with its reply box, quick replies and confirm step, ready at
 * once (there is no question on screen to read). Sent: the sheet closes. Refused: the reason shows over the same box,
 * the draft kept, nothing sent.
 */
describe('message sheet', () => {
  it('opens ready, as a free-text reply to the session, with its last reply for context', () => {
    const m = messageSheet('Retry logic is in.');
    expect(m).toMatchObject({ phase: 'ready', prompt: { kind: 'text', options: [] }, context: { lastAssistantText: 'Retry logic is in.' } });
    const h = renderSheet(m, session, ['yes', 'continue'], 'draft', 'message');
    expect(h.match(/data-act="quick"/g)).toHaveLength(2);
    expect(h).toContain('placeholder="Type a message"');
    expect(h).toContain('>draft</textarea>');
    expect(h).toContain('Retry logic is in.');
    expect(h).toContain('New message to this session');
    expect(h).toContain('maxlength="4000"');
    expect(renderSheet({ phase: 'confirm', prompt: m.prompt, context: m.context, pending: pendingFor(m.prompt, { text: 'go <on>' }) }, session, [], '', 'message'))
      .toContain('Send <b>go &lt;on&gt;</b>?');
  });
  it('sent closes the sheet; refused shows why over the same reply box', () => {
    const m = messageSheet();
    expect(afterMessage({ ok: true, sent: 'message (5 characters)' }, m)).toBe('sent');
    const r = afterMessage({ ok: false, error: 'no_prompt', message: 'Claude is working in this session. Nothing was sent.' }, m);
    expect(r).toMatchObject({ phase: 'ready', prompt: m.prompt, notice: 'Claude is working in this session. Nothing was sent.' });
    expect(renderSheet(r as any, session, [], 'keep me', 'message')).toContain('>keep me</textarea>');
  });
});

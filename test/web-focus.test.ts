// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { focusModel, fmtTime, fmtTokens } from '../web/src/focus-model.js';
import { buttonsHtml, feedHtml, minisHtml, ringSvg, shellHtml, statsHtml, summaryHtml, updateHeader } from '../web/src/focus-view.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const session = (o: object = {}) => ({ key: 'k', name: 'orchard-api', host: 'desk', account: 'studio', state: 'needs-you', tmux: 'desk:@1.%1', bridgeSessionId: 'session_x', hostOnline: true, model: 'claude-opus-5-5', effort: 'high', contextPct: 91, ...o }) as any;
const sum = { lastPrompt: 'Add retry', lastAssistantText: 'Done', files: ['a.ts', 'b.ts'], toolCount: 12, tokensIn: 182_400, tokensOut: 14_950, startedAt: NOW - 95 * 60_000,
  tools: [1, 2, 3].map((i) => ({ at: new Date(2026, 9, 12, 14, 0, i).getTime(), name: 'Bash', target: `echo <${i}>` })) };

describe('focus model', () => {
  it('builds the stats, a newest-first feed and the available buttons', () => {
    const v = focusModel(session(), sum, NOW, 'Studio');
    expect(v).toMatchObject({ name: 'orchard-api', meta: 'Studio · desk · desk', word: 'NEEDS YOU', ctxPct: 91, model: 'opus-5-5', tokensIn: '182.4k', tokensOut: '15k', toolCount: 12, running: '1h 35m', canAnswer: true, canOpen: true, canAttach: true });
    expect(v.feed.map((f) => f.time)).toEqual(['14:00:03', '14:00:02', '14:00:01']);
  });
  it('limits buttons by what the session has', () => {
    expect(focusModel(session({ state: 'working' }), null, NOW, 'S')).toMatchObject({ canAnswer: false, toolCount: null, running: '–', tokensIn: '–' });
    expect(focusModel(session({ tmux: undefined }), null, NOW, 'S')).toMatchObject({ canAnswer: false, canAttach: false, canOpen: true });
    expect(focusModel(session({ bridgeSessionId: undefined }), null, NOW, 'S')).toMatchObject({ canOpen: false });
    expect(focusModel(session({ hostOnline: false }), null, NOW, 'S')).toMatchObject({ canAnswer: false, canOpen: false, canAttach: false, offline: true });
  });
  // Task 43: Message on an idle session in tmux, beside Open and Attach, as Answer is on one that needs you.
  it('offers Message only for an asleep session in tmux on an online host, not while starting', () => {
    expect(focusModel(session({ state: 'asleep' }), null, NOW, 'S')).toMatchObject({ canMessage: true, canAnswer: false });
    expect(focusModel(session(), null, NOW, 'S')).toMatchObject({ canMessage: false });
    for (const o of [{ state: 'working' }, { state: 'asleep', tmux: undefined }, { state: 'asleep', hostOnline: false }, { state: 'asleep', starting: true }, { state: 'stopped' }])
      expect(focusModel(session(o), null, NOW, 'S'), JSON.stringify(o)).toMatchObject({ canMessage: false });
  });
  it('formats times and token counts', () => {
    expect(fmtTime(new Date(2026, 0, 1, 3, 4, 5).getTime())).toBe('03:04:05');
    expect([undefined, 950, 1500, 2_400_000].map(fmtTokens)).toEqual(['–', '950', '1.5k', '2.4M']);
  });
});

describe('focus view html', () => {
  const v = focusModel(session(), sum, NOW, 'Studio');
  it('renders buttons per capability and escapes the feed', () => {
    expect(buttonsHtml(v)).toContain('data-act="answer"');
    expect(buttonsHtml({ ...v, canAnswer: false, canOpen: false })).not.toContain('answer');
    expect(buttonsHtml(v)).not.toContain('data-act="message"');
    expect(buttonsHtml({ ...v, canAnswer: false, canMessage: true })).toContain('<button class="primary" data-act="message">Message</button>');
    expect(feedHtml(v)).toContain('echo &lt;3&gt;');
    expect(feedHtml({ ...v, feed: [] })).toContain('No tool calls yet');
  });
  it('shows the ring amber from 85% and the summary parts', () => {
    expect(ringSvg(91)).toContain('var(--needs)');
    expect(ringSvg(40)).not.toContain('var(--needs)');
    expect(ringSvg(null)).toContain('>–<');
    expect(summaryHtml(v)).toContain('Files touched');
    expect(statsHtml(v)).toContain('182.4k / 15k');
  });
  it('lists other sessions as small cards', () => {
    expect(minisHtml([{ key: 'a', name: 'x<y', state: 'working' }])).toContain('data-key="a"');
    expect(minisHtml([{ key: 'a', name: 'x<y', state: 'working' }])).toContain('x&lt;y');
  });
});

describe('focus header refresh', () => {
  it('follows a state change: panel class, word, name and meta', () => {
    const root = document.createElement('section');
    root.innerHTML = shellHtml(focusModel(session(), null, NOW, 'Studio'));
    updateHeader(root, focusModel(session({ state: 'working', name: 'a<b', tmux: 'lap:@2.%3' }), null, NOW, 'Home'));
    const panel = root.querySelector('.focus-panel')!;
    expect(panel.className).toBe('focus-panel st-working');
    expect(root.querySelector('.who .word')!.textContent).toBe('WORKING');
    expect(root.querySelector('.who h2')!.textContent).toBe('a<b');
    expect(root.querySelector('.who .meta')!.textContent).toBe('Home · desk · lap');
  });
});

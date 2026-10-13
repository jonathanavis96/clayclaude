import { describe, it, expect } from 'vitest';
import { rowActionsHtml } from '../web/src/row-actions.js';

const s = (o: object) => ({ key: 'h:a:<s>', state: 'needs-you', tmux: 'x:@1.%1', bridgeSessionId: 'session_abc1', hostOnline: true, ...o }) as any;

describe('row actions', () => {
  it('a needs-you row in tmux gets no button (its question bubble answers, Task 36); without tmux but with a link it gets Open; otherwise nothing', () => {
    expect(rowActionsHtml(s({}))).toBe('');
    expect(rowActionsHtml(s({ tmux: undefined }))).toContain('data-act="open"');
    expect(rowActionsHtml(s({ tmux: undefined }))).toContain('data-key="h:a:&lt;s&gt;"');
    expect(rowActionsHtml(s({ tmux: undefined, bridgeSessionId: undefined }))).toBe('');
    expect(rowActionsHtml(s({ hostOnline: false }))).toBe('');
    expect(rowActionsHtml(s({ state: 'working' }))).toBe('');
  });
});

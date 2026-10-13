import { describe, it, expect } from 'vitest';
import { buildSummary } from '../src/core/summary.js';

const J = (o: object) => JSON.stringify(o);
const asst = (ts: string, content: object[], usage: object = { input_tokens: 10, cache_creation_input_tokens: 5, output_tokens: 7 }) =>
  J({ type: 'assistant', timestamp: ts, message: { content, usage } });

describe('buildSummary', () => {
  it('collects prompt, last reply, files, tool feed and token totals', () => {
    const s = buildSummary([
      J({ type: 'user', message: { content: 'Add retry logic to the fetcher' } }),
      asst('2026-10-12T10:00:00Z', [{ type: 'text', text: 'On it.' }, { type: 'tool_use', id: '1', name: 'Read', input: { file_path: '/p/fetch.ts' } }]),
      J({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }] } }),
      asst('2026-10-12T10:00:05Z', [{ type: 'tool_use', id: '2', name: 'Edit', input: { file_path: '/p/fetch.ts' } }, { type: 'tool_use', id: '3', name: 'Write', input: { file_path: '/p/retry.ts' } }]),
      asst('2026-10-12T10:00:09Z', [{ type: 'text', text: 'Done. Tests pass.' }]),
    ], 1000);
    expect(s.lastPrompt).toBe('Add retry logic to the fetcher');
    expect(s.lastAssistantText).toBe('Done. Tests pass.');
    expect(s.files).toEqual(['/p/retry.ts', '/p/fetch.ts']);
    expect(s.toolCount).toBe(3);
    expect(s.tools.map((t) => [t.name, t.target])).toEqual([['Read', '/p/fetch.ts'], ['Edit', '/p/fetch.ts'], ['Write', '/p/retry.ts']]);
    expect(s.tools[0].at).toBe(Date.parse('2026-10-12T10:00:00Z'));
    expect(s).toMatchObject({ tokensIn: 45, tokensOut: 21, startedAt: 1000 });
  });
  it('ignores injected reminders as prompts, falls back to last-prompt, and skips bad lines', () => {
    const s = buildSummary(['{bad', J({ type: 'last-prompt', lastPrompt: 'earlier prompt' }), J({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } })]);
    expect(s.lastPrompt).toBe('earlier prompt');
    expect(s.toolCount).toBe(0);
  });
  it('counts usage once per message.id when one reply is split across lines', () => {
    const u = { input_tokens: 100, cache_creation_input_tokens: 1000, output_tokens: 50 };
    const line = (id: string, content: object[], usage: object) =>
      J({ type: 'assistant', timestamp: '2026-10-12T10:00:00Z', message: { id, content, usage } });
    const s = buildSummary([
      line('msg_1', [{ type: 'text', text: 'a' }], u),
      line('msg_1', [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/p/a.ts' } }], u),
      line('msg_2', [{ type: 'text', text: 'b' }], { input_tokens: 1, output_tokens: 2 }),
      line('msg_2', [{ type: 'text', text: 'c' }], { input_tokens: 1, output_tokens: 9 }),
    ]);
    expect(s).toMatchObject({ tokensIn: 1101, tokensOut: 59, toolCount: 1 });
  });
  it('skips injected user entries (meta, compact summary, sidechain, interrupt marker) as the last prompt', () => {
    const s = buildSummary([
      J({ type: 'user', message: { content: 'Fix the login bug' } }),
      J({ type: 'user', isMeta: true, message: { content: [{ type: 'text', text: 'Base directory for this skill: /x' }] } }),
      J({ type: 'user', isMeta: true, message: { content: 'Stop hook feedback: keep going' } }),
      J({ type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation...' } }),
      J({ type: 'user', isSidechain: true, message: { content: 'Subagent task prompt' } }),
      J({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
      J({ type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user for tool use]' }] } }),
    ]);
    expect(s.lastPrompt).toBe('Fix the login bug');
  });
  it('caps the tool feed and clips long text', () => {
    const lines = Array.from({ length: 60 }, (_, i) => asst('2026-10-12T10:00:00Z', [{ type: 'tool_use', id: String(i), name: 'Bash', input: { command: `echo ${i}` } }]));
    lines.push(asst('2026-10-12T10:00:01Z', [{ type: 'text', text: 'x'.repeat(2000) }]));
    const s = buildSummary(lines);
    expect(s.tools).toHaveLength(40);
    expect(s.tools.at(-1)!.target).toBe('echo 59');
    expect(s.lastAssistantText).toHaveLength(800);
  });
});

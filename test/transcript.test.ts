import { describe, it, expect } from 'vitest';
import { extractTranscript, summariseInput } from '../src/core/transcript.js';

const J = (o: object) => JSON.stringify(o);
const asst = (ts: string, content: object[], extra: object = {}) =>
  J({ type: 'assistant', timestamp: ts, effort: 'high', message: { model: 'claude-opus-5-5', content,
    usage: { input_tokens: 10, cache_read_input_tokens: 1000, cache_creation_input_tokens: 90, output_tokens: 5 } }, ...extra });
const result = (ts: string, id: string) => J({ type: 'user', timestamp: ts, message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

describe('extractTranscript', () => {
  it('reads model, effort, context tokens and the current action', () => {
    const t = extractTranscript([
      J({ type: 'last-prompt', lastPrompt: 'fix the tests' }),
      asst('2026-10-12T10:00:00Z', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npx   vitest run' } }]),
      result('2026-10-12T10:00:05Z', 't1'),
    ]);
    expect(t).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', contextTokens: 1100,
      currentAction: 'Bash: npx vitest run', lastPrompt: 'fix the tests',
      lastAssistantAt: Date.parse('2026-10-12T10:00:00Z'), lastEntryAt: Date.parse('2026-10-12T10:00:05Z') });
    expect(t.pendingTool).toBeUndefined();
  });

  it('reports a tool_use with no result as pending', () => {
    const t = extractTranscript([asst('2026-10-12T10:00:00Z', [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/a/b.ts' } }])]);
    expect(t.pendingTool).toEqual({ name: 'Edit', summary: '/a/b.ts', id: 't2' });
  });

  it('ignores a stray unresolved tool_use from before the last user prompt', () => {
    const t = extractTranscript([
      asst('2026-10-12T10:00:00Z', [{ type: 'tool_use', id: 'lost', name: 'Bash', input: { command: 'ls' } }]),
      J({ type: 'user', timestamp: '2026-10-12T10:05:00Z', message: { content: 'carry on' } }),
      asst('2026-10-12T10:05:05Z', [{ type: 'text', text: 'done' }]),
    ]);
    expect(t.pendingTool).toBeUndefined();
    expect(t.lastUserAt).toBe(Date.parse('2026-10-12T10:05:00Z'));
  });

  it('extracts a pending AskUserQuestion question', () => {
    const t = extractTranscript([asst('2026-10-12T10:00:00Z', [{ type: 'tool_use', id: 'q', name: 'AskUserQuestion',
      input: { questions: [{ question: 'Apply the migration now?' }] } }])]);
    expect(t.askQuestion).toBe('Apply the migration now?');
  });

  it('notes compaction and a usage-limit message', () => {
    const t = extractTranscript([
      J({ type: 'system', subtype: 'compact_boundary', timestamp: '2026-10-12T09:00:00Z' }),
      asst('2026-10-12T10:00:00Z', [{ type: 'text', text: "Claude usage limit reached. Your limit will reset at 3pm." }],
        { isApiErrorMessage: true }),
    ]);
    expect(t.lastCompactAt).toBe(Date.parse('2026-10-12T09:00:00Z'));
    expect(t.limitHit).toBe(true);
    expect(t.lastAssistantText).toMatch(/limit reached/);
  });

  it('flags a real usage-limit error entry, ignoring the metadata written after it', () => {
    const t = extractTranscript([
      asst('2026-10-12T10:00:00Z', [{ type: 'text', text: 'Working on it.' }]),
      J({ type: 'assistant', timestamp: '2026-10-12T10:01:00Z', error: 'rate_limit', isApiErrorMessage: true,
        message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3:50am (Africa/Johannesburg)" }],
          usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } }),
      J({ type: 'system', subtype: 'turn_duration', timestamp: '2026-10-12T10:01:01Z' }),
      J({ type: 'last-prompt', lastPrompt: 'keep going' }),
    ]);
    expect(t.limitHit).toBe(true);
    expect(t.model).toBe('claude-opus-5-5');
    expect(t.contextTokens).toBe(1100);
  });

  it('does not flag ordinary assistant text that mentions a rate limit', () => {
    const t = extractTranscript([
      asst('2026-10-12T10:00:00Z', [{ type: 'text', text: 'I added rate limit handling to the API client.' }]),
    ]);
    expect(t.limitHit).toBe(false);
  });

  it('clears the limit flag once the conversation moves on', () => {
    const t = extractTranscript([
      asst('2026-10-12T10:00:00Z', [{ type: 'text', text: 'Claude usage limit reached. Your limit will reset at 3pm.' }],
        { isApiErrorMessage: true, error: 'rate_limit' }),
      J({ type: 'user', timestamp: '2026-10-12T15:01:00Z', message: { content: 'carry on' } }),
      asst('2026-10-12T15:01:05Z', [{ type: 'thinking', thinking: 'resume' },
        { type: 'tool_use', id: 't9', name: 'Bash', input: { command: 'ls' } }]),
    ]);
    expect(t.limitHit).toBe(false);
  });

  it('ignores unparseable lines and returns empties for no input', () => {
    expect(extractTranscript(['{bad', '']).lastEntryAt).toBeNull();
  });

  it('clips long summaries', () => {
    expect(summariseInput('Bash', { command: 'a'.repeat(300) })).toHaveLength(120);
  });
});

describe('extractTranscript: re-check findings', () => {
  it('skips a line that parses to null instead of throwing', () => {
    expect(() => extractTranscript(['null', '5', '"x"'])).not.toThrow();
  });
  it('with parallel tool calls, reports the oldest unresolved one (the one Claude Code is asking about)', () => {
    const t = extractTranscript([asst('2026-10-12T10:00:00Z', [
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'make build' } },
      { type: 'tool_use', id: 'b', name: 'Edit', input: { file_path: '/x.ts' } }])]);
    expect(t.pendingTool?.id).toBe('a');
  });
});

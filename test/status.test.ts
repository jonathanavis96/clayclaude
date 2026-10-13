import { describe, it, expect } from 'vitest';
import { deriveSession, parseEvents, contextWindowFor, type DeriveInput } from '../src/core/status.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const J = (o: object) => JSON.stringify(o);
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const asst = (msAgo: number, content: object[] = [{ type: 'text', text: 'done' }]) =>
  J({ type: 'assistant', timestamp: iso(msAgo), message: { model: 'claude-opus-5-5', content, usage: { input_tokens: 0, cache_read_input_tokens: 180000, cache_creation_input_tokens: 0 } } });

function input(over: Partial<DeriveInput> & { data?: any; live?: boolean; transcript?: string[] } = {}): DeriveInput {
  const { data, live, transcript, ...rest } = over;
  return {
    host: 'local', account: 'me', events: [], usageExhausted: false, cacheTtlMinutes: 60,
    contextWindows: { default: 200000 }, hostOnline: true, lastSeen: NOW,
    reg: { file: '1.json', mtimeMs: NOW - 5000, live: live ?? true, transcript: transcript ?? [asst(600_000)],
      data: { pid: 1, sessionId: 's', cwd: '/home/u/code/my-app', startedAt: NOW - 3600_000, status: 'idle', ...data } },
    ...rest,
  };
}
const state = (i: DeriveInput) => deriveSession(i, NOW)!.state;

describe('deriveSession', () => {
  it('dead process -> stopped, even if status says busy', () => {
    expect(state(input({ live: false, data: { status: 'busy' } }))).toBe('stopped');
  });
  it('usage exhausted -> limit', () => expect(state(input({ usageExhausted: true }))).toBe('limit'));
  it('PreCompact newer than last assistant -> compacting', () => {
    expect(state(input({ events: [{ event: 'PreCompact', sessionId: 's', ts: NOW - 1000 }] }))).toBe('compacting');
  });
  it('Notification newer than last assistant -> needs-you with its message', () => {
    const s = deriveSession(input({ events: [{ event: 'Notification', sessionId: 's', ts: NOW - 1000, message: 'Claude needs your permission to use Bash' }] }), NOW)!;
    expect(s.state).toBe('needs-you');
    expect(s.question).toBe('Claude needs your permission to use Bash');
    expect(s.stateSince).toBe(NOW - 1000);
  });
  it('a Notification for another session is ignored', () => {
    expect(state(input({ events: [{ event: 'Notification', sessionId: 'other', ts: NOW - 1000 }] }))).toBe('asleep');
  });
  it('an old Notification (before the last assistant turn) is ignored', () => {
    expect(state(input({ events: [{ event: 'Notification', sessionId: 's', ts: NOW - 700_000 }] }))).toBe('asleep');
  });
  it('pending tool + idle -> needs-you (transcript fallback)', () => {
    const s = deriveSession(input({ transcript: [asst(30_000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf dist' } }])] }), NOW)!;
    expect(s.state).toBe('needs-you');
    expect(s.question).toBe('Allow Bash: rm -rf dist?');
  });
  it('pending tool + busy -> working (tool is running)', () => {
    expect(state(input({ data: { status: 'busy' }, transcript: [asst(30_000, [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }])] }))).toBe('working');
  });
  it('no status field but a fresh transcript entry -> working', () => {
    expect(state(input({ data: { status: undefined }, transcript: [asst(5_000)] }))).toBe('working');
  });
  it('idle and quiet -> asleep, with cache expiry and context %', () => {
    const s = deriveSession(input(), NOW)!;
    expect(s.state).toBe('asleep');
    expect(s.cacheExpiresAt).toBe(NOW - 600_000 + 3600_000);
    expect(s.contextPct).toBe(90);
    expect(s.overContext).toBe(true);
  });
  it('a session past 200k tokens with a plain model id is on the 1M window, not full', () => {
    const big = J({ type: 'assistant', timestamp: iso(600_000), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 25, cache_read_input_tokens: 266_000, cache_creation_input_tokens: 800 } } });
    const s = deriveSession(input({ transcript: [big] }), NOW)!;
    expect(s.contextPct).toBe(27);
    expect(s.overContext).toBe(false);
  });
  it('ignores the idle "waiting for your input" Notification', () => {
    expect(state(input({ events: [{ event: 'Notification', sessionId: 's', ts: NOW - 1000, message: 'Claude is waiting for your input' }] }))).toBe('asleep');
  });
  it('a user entry after the Notification answers it', () => {
    const user = J({ type: 'user', timestamp: iso(500), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'denied' }] } });
    expect(state(input({ transcript: [asst(600_000), user], data: { status: 'busy' },
      events: [{ event: 'Notification', sessionId: 's', ts: NOW - 1000, message: 'Claude needs your permission to use Bash' }] }))).toBe('working');
  });
  it('a busy status written after the Notification answers it', () => {
    expect(state(input({ data: { status: 'busy', statusUpdatedAt: NOW - 500 },
      events: [{ event: 'Notification', sessionId: 's', ts: NOW - 1000, message: 'Claude needs your permission to use Bash' }] }))).toBe('working');
  });
  it('a busy status from before the Notification does not answer it', () => {
    expect(state(input({ data: { status: 'busy', statusUpdatedAt: NOW - 5000 },
      events: [{ event: 'Notification', sessionId: 's', ts: NOW - 1000, message: 'Claude needs your permission to use Bash' }] }))).toBe('needs-you');
  });
  it('derives with the given clock, so a remote host is judged by its own time', () => {
    // Entry 5 s old on the remote clock; the local clock is 60 s ahead.
    const remoteNow = NOW - 60_000;
    expect(deriveSession(input({ transcript: [asst(65_000)], data: { status: undefined } }), remoteNow)!.state).toBe('working');
  });
  it('falls back to the cwd basename for the name', () => {
    expect(deriveSession(input(), NOW)!.name).toBe('my-app');
  });
  it('returns null for an unparsed registry', () => {
    const i = input(); i.reg.data = null;
    expect(deriveSession(i, NOW)).toBeNull();
  });
});

describe('helpers', () => {
  it('parses events, skipping bad lines, ts seconds or ms', () => {
    expect(parseEvents(['{"event":"Stop","sessionId":"s","ts":1791800000}', 'x', '{"event":"Stop","sessionId":"s","ts":1791800000000}'])
      .map((e) => e.ts)).toEqual([1791800000000, 1791800000000]);
  });
  it('picks context windows', () => {
    const w = { default: 200000, 'claude-sonnet': 1000000 };
    expect(contextWindowFor('claude-sonnet-5-5', w)).toBe(1000000);
    expect(contextWindowFor('claude-opus-5-5[1m]', w)).toBe(1000000);
    expect(contextWindowFor(undefined, w)).toBe(200000);
  });
});

describe('deriveSession: re-check findings', () => {
  const tool = (msAgo: number) => asst(msAgo, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf dist' } }]);
  it('registry status "waiting" (Claude Code requires_action) with a pending tool -> needs-you, from statusUpdatedAt', () => {
    const s = deriveSession(input({ transcript: [tool(30_000)], data: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 29_000 } }), NOW)!;
    expect(s.state).toBe('needs-you');
    expect(s.question).toBe('Allow Bash: rm -rf dist?');
    expect(s.stateSince).toBe(NOW - 29_000);
  });
  it('registry status "waiting" for input -> needs-you even without a pending tool in the tail', () => {
    expect(state(input({ data: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 5000 } }))).toBe('needs-you');
  });
  it('a dialog the user opened is not needs-you', () => {
    expect(state(input({ data: { status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: NOW - 5000 } }))).toBe('asleep');
  });
  it('a limit from the usage provider with no transcript has a stable stateSince, not the poll time', () => {
    const a = deriveSession(input({ usageExhausted: true, transcript: [] }), NOW)!;
    const b = deriveSession(input({ usageExhausted: true, transcript: [] }), NOW + 2000)!;
    expect(a.state).toBe('limit');
    expect(b.stateSince).toBe(a.stateSince);
  });
  it('a PreCompact that never produced a boundary is over once the user has written again', () => {
    const user = J({ type: 'user', timestamp: iso(60_000), message: { content: 'are you there?' } });
    expect(state(input({ transcript: [asst(600_000), user], events: [{ event: 'PreCompact', sessionId: 's', ts: NOW - 300_000 }] }))).toBe('asleep');
  });
  it('context % after an auto-compaction uses the post-compaction size, not the old turn', () => {
    const boundary = J({ type: 'system', subtype: 'compact_boundary', timestamp: iso(500_000), compactMetadata: { trigger: 'manual', preTokens: 180_000, postTokens: 30_000 } });
    expect(deriveSession(input({ transcript: [asst(600_000), boundary] }), NOW)!.contextPct).toBe(15);
  });
  it('a session that auto-compacted above 200k is on the 1M window after compaction too', () => {
    const boundary = J({ type: 'system', subtype: 'compact_boundary', timestamp: iso(500_000), compactMetadata: { trigger: 'auto', preTokens: 267_000, postTokens: 39_000 } });
    const after = J({ type: 'assistant', timestamp: iso(400_000), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, cache_read_input_tokens: 70_000, cache_creation_input_tokens: 0 } } });
    expect(deriveSession(input({ transcript: [boundary, after] }), NOW)!.contextPct).toBe(7);
  });
  it('the cache timer ignores a synthetic API error entry (no request reached the cache)', () => {
    const err = J({ type: 'assistant', timestamp: iso(60_000), isApiErrorMessage: true, message: { model: '<synthetic>', content: [{ type: 'text', text: 'API Error: 529 overloaded' }] } });
    expect(deriveSession(input({ transcript: [asst(600_000), err] }), NOW)!.cacheExpiresAt).toBe(NOW - 600_000 + 3600_000);
  });
});

describe('deriveSession: a resumed session (new process, same session id)', () => {
  const started = { startedAt: NOW - 60_000 };
  it('ignores a Notification from before this process started', () => {
    const tool = asst(7200_000 + 1000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]);
    expect(state(input({ transcript: [tool], data: started,
      events: [{ event: 'Notification', sessionId: 's', ts: NOW - 7200_000, message: 'Claude needs your permission to use Bash' }] }))).toBe('asleep');
  });
  it('ignores a PreCompact from before this process started (killed mid-compaction)', () => {
    expect(state(input({ data: started, events: [{ event: 'PreCompact', sessionId: 's', ts: NOW - 300_000 }] }))).toBe('asleep');
  });
  it('does not treat a tool call left unresolved by the dead process as a prompt', () => {
    const tool = asst(7200_000, [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?' }] } }]);
    expect(state(input({ transcript: [tool], data: started }))).toBe('asleep');
    const bash = asst(7200_000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'ls' } }]);
    expect(state(input({ transcript: [bash], data: started }))).toBe('asleep');
  });
});

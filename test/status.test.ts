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
  it('a session once seen past its configured window stays on the 1M window after that has left the tail', () => {
    const turn = (tokens: number) => J({ type: 'assistant', timestamp: iso(600_000), message: { model: 'claude-opus-5-5', content: [{ type: 'text', text: 'x' }],
      usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } });
    const wide = new Set<string>();
    expect(deriveSession(input({ transcript: [turn(266_000)], wide }), NOW)!.contextPct).toBe(27);
    expect(wide.has('local:me:s')).toBe(true);
    expect(deriveSession(input({ transcript: [turn(198_000)], wide }), NOW)!.contextPct).toBe(20);
    // Never seen past it: still the configured window.
    expect(deriveSession(input({ transcript: [turn(198_000)], wide: new Set() }), NOW)!.contextPct).toBe(99);
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

describe('deriveSession: a pending permission, reported by Claude Code itself', () => {
  const PERM = 'Claude needs your permission to use Bash';
  const note = (msAgo: number, message = PERM) => ({ event: 'Notification', sessionId: 's', ts: NOW - msAgo, message });
  const perm = (i: DeriveInput) => deriveSession(i, NOW)!.permission;
  it('the registry waits on a permission prompt (or on anything but input or a dialog the user opened)', () => {
    expect(perm(input({ data: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 5000 } }))).toBe(true);
    expect(perm(input({ data: { status: 'waiting', waitingFor: 'sandbox request', statusUpdatedAt: NOW - 5000 } }))).toBe(true);
    expect(perm(input({ data: { status: 'waiting', statusUpdatedAt: NOW - 5000 } }))).toBe(true);
    expect(perm(input({ data: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 5000 } }))).toBeUndefined();
    expect(perm(input({ data: { status: 'waiting', waitingFor: 'dialog open', statusUpdatedAt: NOW - 5000 } }))).toBeUndefined();
    expect(perm(input({ data: { status: 'busy' } }))).toBeUndefined();
    expect(perm(input())).toBeUndefined();
  });
  it('a "needs your permission" Notification not yet followed by a later event or an answer', () => {
    expect(perm(input({ events: [note(1000)] }))).toBe(true);
    expect(perm(input({ events: [note(1000), { event: 'Stop', sessionId: 's', ts: NOW - 500 }] }))).toBeUndefined();
    expect(perm(input({ events: [note(1000), note(500, 'Claude is waiting for your input')] }))).toBeUndefined();
    expect(perm(input({ events: [note(1000)], data: { status: 'busy', statusUpdatedAt: NOW - 500 } }))).toBeUndefined();
    const user = J({ type: 'user', timestamp: iso(500), message: { content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] } });
    expect(perm(input({ events: [note(1000)], transcript: [asst(600_000), user] }))).toBeUndefined();
    // Another session's, one from before this process started, or another kind of notification: not a permission.
    expect(perm(input({ events: [{ ...note(1000), sessionId: 'other' }] }))).toBeUndefined();
    expect(perm(input({ events: [note(4000_000)] }))).toBeUndefined();
    expect(perm(input({ events: [note(1000, 'Claude Code needs your input')] }))).toBeUndefined();
  });
  it('an unresolved tool call while the registry says idle (older Claude Code)', () => {
    const tool = asst(30_000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf dist' } }]);
    expect(perm(input({ transcript: [tool] }))).toBe(true);
    expect(perm(input({ transcript: [tool], data: { status: 'busy' } }))).toBeUndefined();
  });
  it('a stopped session has none', () => {
    expect(perm(input({ live: false, events: [note(1000)], data: { status: 'waiting', waitingFor: 'permission prompt' } }))).toBeUndefined();
  });
  // Claude Code 2.1.296 sends "Claude needs your permission" 6 s into an AskUserQuestion menu too.
  it('the "needs your permission" note sent for an AskUserQuestion menu is not a permission', () => {
    const ask = asst(8000, [{ type: 'tool_use', id: 't', name: 'AskUserQuestion', input: { questions: [{ question: 'Which colour should the label be?', options: [{ label: 'Red' }, { label: 'Green' }] }] } }]);
    const s = deriveSession(input({ transcript: [ask], events: [note(2000, 'Claude needs your permission')], data: { status: 'waiting', waitingFor: 'input needed', statusUpdatedAt: NOW - 8000 } }), NOW)!;
    expect(s.state).toBe('needs-you');
    expect(s.permission).toBeUndefined();
    // Either signal alone: the registry waits for input, or the tool waiting on the user is AskUserQuestion.
    expect(perm(input({ events: [note(2000)], data: { status: 'waiting', waitingFor: 'input needed' } }))).toBeUndefined();
    expect(perm(input({ transcript: [ask], events: [note(2000)] }))).toBeUndefined();
    // A tool approval still is, by the note alone or by the registry.
    const bash = asst(8000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf dist' } }]);
    expect(perm(input({ transcript: [bash], events: [note(2000)] }))).toBe(true);
    expect(perm(input({ transcript: [ask], events: [note(2000)], data: { status: 'waiting', waitingFor: 'permission prompt' } }))).toBe(true);
  });
});

describe('deriveSession: Claude working, reported by Claude Code itself', () => {
  const busy = (i: DeriveInput) => deriveSession(i, NOW)!.busy;
  it('the registry status is busy, or it is compacting', () => {
    expect(busy(input({ data: { status: 'busy', statusUpdatedAt: NOW - 1000 } }))).toBe(true);
    expect(busy(input({ events: [{ event: 'PreCompact', sessionId: 's', ts: NOW - 1000 }] }))).toBe(true);
    expect(busy(input())).toBeUndefined();
    expect(busy(input({ data: { status: 'waiting', waitingFor: 'input needed' } }))).toBeUndefined();
    expect(busy(input({ live: false, data: { status: 'busy' } }))).toBeUndefined();
  });
  it('an older Claude Code that writes no status: its derived state', () => {
    expect(busy(input({ transcript: [asst(2000)], data: { status: undefined } }))).toBe(true);
    expect(busy(input({ transcript: [asst(600_000)], data: { status: undefined } }))).toBeUndefined();
    // With a status, a recent transcript entry alone is not Claude working (a question it has just finished asking).
    expect(busy(input({ transcript: [asst(2000)] }))).toBeUndefined();
  });
});

/*
 * Task 43 / 42, the idle gate's first condition: Claude Code itself (never the screen) says the session finished its turn
 * and waits for a new prompt. With hooks: the session's last event is Stop, or SessionStart with nothing after it (an
 * idle "waiting for your input" note does not count, it follows every finished turn), and no prompt in the transcript
 * since. Without hook events for the session: its registry status is idle. Never while it needs you, works, compacts or
 * has a permission pending.
 */
describe('deriveSession: idle and waiting for a new prompt, reported by Claude Code itself', () => {
  const ev = (event: string, msAgo: number, message?: string) => ({ event, sessionId: 's', ts: NOW - msAgo, ...(message ? { message } : {}) });
  const idle = (i: DeriveInput) => deriveSession(i, NOW)!.idle;
  const prompt = (msAgo: number) => J({ type: 'user', timestamp: iso(msAgo), message: { content: 'next task please' } });
  it('hooks: the last event is Stop, or SessionStart with nothing after it', () => {
    expect(idle(input({ events: [ev('SessionStart', 3000_000), ev('Stop', 590_000)] }))).toBe(true);
    expect(idle(input({ events: [ev('Stop', 590_000), ev('Notification', 580_000, 'Claude is waiting for your input')] }))).toBe(true);
    expect(idle(input({ events: [ev('SessionStart', 3000_000)] }))).toBe(true);
    // Another session's events and events from before this process started are not this session's.
    expect(idle(input({ events: [ev('Stop', 590_000), { ...ev('Notification', 1000, 'Claude needs your permission to use Bash'), sessionId: 'other' }] }))).toBe(true);
  });
  it('hooks: never when the last event is a permission or question Notification, PreCompact or SessionEnd', () => {
    expect(idle(input({ events: [ev('Stop', 590_000), ev('Notification', 1000, 'Claude needs your permission to use Bash')] }))).toBeUndefined();
    expect(idle(input({ events: [ev('Stop', 590_000), ev('Notification', 1000, 'Claude Code needs your input')] }))).toBeUndefined();
    expect(idle(input({ events: [ev('Stop', 590_000), ev('PreCompact', 1000)] }))).toBeUndefined();
    expect(idle(input({ events: [ev('Stop', 590_000), ev('SessionEnd', 1000)] }))).toBeUndefined();
    expect(idle(input({ events: [ev('SessionStart', 590_000), ev('UserPromptSubmit', 1000)] }))).toBeUndefined();
  });
  it('hooks: never when a prompt was submitted after the Stop or SessionStart', () => {
    expect(idle(input({ events: [ev('Stop', 590_000)], transcript: [asst(600_000), prompt(30_000)] }))).toBeUndefined();
    expect(idle(input({ events: [ev('SessionStart', 3000_000)], transcript: [asst(600_000), prompt(30_000)] }))).toBeUndefined();
  });
  it('hooks: never when the registry contradicts them (busy or waiting)', () => {
    expect(idle(input({ events: [ev('Stop', 590_000)], data: { status: 'busy', statusUpdatedAt: NOW - 1000 } }))).toBeUndefined();
    expect(idle(input({ events: [ev('Stop', 590_000)], data: { status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: NOW - 1000 } }))).toBeUndefined();
    expect(idle(input({ events: [ev('Stop', 590_000)], data: { status: undefined } }))).toBe(true);
  });
  it('no hook events for the session: the registry status says idle; no status, no idle', () => {
    expect(idle(input())).toBe(true);
    expect(idle(input({ data: { status: undefined } }))).toBeUndefined();
    expect(idle(input({ data: { status: 'busy' } }))).toBeUndefined();
    expect(idle(input({ data: { status: 'waiting', waitingFor: 'input needed' } }))).toBeUndefined();
  });
  it('never while it needs you, works, compacts, is at its limit or has stopped', () => {
    const bash = asst(30_000, [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'rm -rf dist' } }]);
    expect(idle(input({ transcript: [bash] }))).toBeUndefined();                                    // unresolved tool + idle: needs-you
    expect(idle(input({ transcript: [asst(5000)], data: { status: undefined }, events: [ev('Stop', 4000)] }))).toBeUndefined(); // fresh entry: working
    expect(idle(input({ usageExhausted: true }))).toBeUndefined();
    expect(idle(input({ live: false }))).toBeUndefined();
    expect(idle(input({ events: [ev('PreCompact', 1000)] }))).toBeUndefined();
  });
});

describe('deriveSession: the status line bridge record', () => {
  const turn = (tokens: number, msAgo = 600_000, model = 'claude-opus-5-5') => J({ type: 'assistant', timestamp: iso(msAgo), message: { model, content: [{ type: 'text', text: 'x' }],
    usage: { input_tokens: 0, cache_read_input_tokens: tokens, cache_creation_input_tokens: 0 } } });
  const rec = (o: object = {}) => ({ sessionId: 's', ts: NOW - 500_000, contextWindowSize: 1_000_000, usedPercentage: 15, totalInputTokens: 150_000, model: 'claude-opus-5-5[1m]', ...o });

  it('uses the recorded window, which beats both the configured one and the 1M guess', () => {
    const s = deriveSession(input({ transcript: [turn(150_000)], context: rec() }), NOW)!;
    expect(s).toMatchObject({ contextPct: 15, contextTokens: 150_000, contextWindow: 1_000_000 });
    // a 200k session recorded as such stays on 200k even after a 1M guess was made for it
    const wide = new Set(['local:me:s']);
    expect(deriveSession(input({ transcript: [turn(150_000)], wide, context: rec({ contextWindowSize: 200_000 }) }), NOW)).toMatchObject({ contextPct: 75, contextWindow: 200_000 });
  });
  it('without a record, keeps the existing rules and says which window it used', () => {
    expect(deriveSession(input({ transcript: [turn(150_000)] }), NOW)).toMatchObject({ contextPct: 75, contextTokens: 150_000, contextWindow: 200_000 });
    expect(deriveSession(input({ transcript: [turn(266_000)] }), NOW)).toMatchObject({ contextPct: 27, contextWindow: 1_000_000 });
  });
  it('counts tokens from the transcript, which is newer, and falls back to the record\'s when the tail has none', () => {
    expect(deriveSession(input({ transcript: [turn(400_000, 60_000)], context: rec({ totalInputTokens: 150_000 }) }), NOW)).toMatchObject({ contextTokens: 400_000, contextPct: 40 });
    const user = J({ type: 'user', timestamp: iso(60_000), message: { content: 'hi' } });
    expect(deriveSession(input({ transcript: [user], context: rec() }), NOW)).toMatchObject({ contextTokens: 150_000, contextPct: 15 });
  });
  it('ignores a record from before a model switch', () => {
    const switched = deriveSession(input({ transcript: [turn(150_000, 60_000, 'claude-sonnet-5-5')], context: rec({ ts: NOW - 120_000 }) }), NOW)!;
    expect(switched).toMatchObject({ contextWindow: 200_000, contextPct: 75 });
    // the same model with the [1m] suffix is the same model
    expect(deriveSession(input({ transcript: [turn(150_000, 60_000)], context: rec({ ts: NOW - 120_000 }) }), NOW)).toMatchObject({ contextWindow: 1_000_000 });
  });
  it('counts against the account\'s auto-compact window when it is smaller than the model\'s', () => {
    expect(deriveSession(input({ transcript: [turn(190_000)], context: rec(), compactWindow: 500_000 }), NOW)).toMatchObject({ contextPct: 38, contextTokens: 190_000, contextWindow: 500_000 });
    // without a record too, and a cap above the window (or nonsense) changes nothing
    expect(deriveSession(input({ transcript: [turn(266_000)], compactWindow: 300_000 }), NOW)).toMatchObject({ contextPct: 89, contextWindow: 300_000 });
    expect(deriveSession(input({ transcript: [turn(150_000)], compactWindow: 500_000 }), NOW)).toMatchObject({ contextPct: 75, contextWindow: 200_000 });
    for (const w of [0, -1, Number.NaN, 1.5]) expect(deriveSession(input({ transcript: [turn(150_000)], context: rec(), compactWindow: w }), NOW), String(w)).toMatchObject({ contextWindow: 1_000_000 });
  });
  it('ignores a record for another session or with a nonsense window', () => {
    expect(deriveSession(input({ transcript: [turn(150_000)], context: rec({ sessionId: 'other' }) }), NOW)).toMatchObject({ contextWindow: 200_000 });
    for (const w of [0, -1, Number.NaN, '1000000', 1e12]) expect(deriveSession(input({ transcript: [turn(150_000)], context: rec({ contextWindowSize: w }) as any }), NOW), String(w)).toMatchObject({ contextWindow: 200_000 });
  });
});

import { describe, it, expect } from 'vitest';
import { deriveSession, parseEvents } from '../src/core/status.js';
import { buildSummary } from '../src/core/summary.js';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const base = { host: 'h', account: 'a', events: [], usageExhausted: false, cacheTtlMinutes: 5,
  contextWindows: { default: 200_000 }, hostOnline: true, lastSeen: NOW };
const reg = (data: object, transcript: string[] = [], live = true) =>
  ({ file: 'f.json', mtimeMs: NOW - 1000, live, transcript, data: { pid: 1, sessionId: 's', cwd: '/x', ...data } });
const asst = (ts: string, message: object = {}) =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { model: 'claude-opus-4-1', content: [{ type: 'text', text: 'hi' }], ...message } });
const iso = (ms: number) => new Date(ms).toISOString();

describe('status chaos: clocks', () => {
  it('does not call a session working for an hour because its transcript is stamped in the future (clock stepped back)', () => {
    const s = deriveSession({ ...base, reg: reg({ startedAt: NOW - 3_600_000 }, [asst(iso(NOW + 3_600_000))]) }, NOW)!;
    expect(s.state).toBe('asleep');
  });

  it('still calls a session working for an entry a few seconds old, or a moment ahead of the probe clock', () => {
    for (const at of [NOW - 5000, NOW + 500]) {
      expect(deriveSession({ ...base, reg: reg({ startedAt: NOW - 3_600_000 }, [asst(iso(at))]) }, NOW)!.state).toBe('working');
    }
  });

  it('reads registry times written in seconds as seconds', () => {
    const stopped = deriveSession({ ...base, reg: reg({ startedAt: (NOW - 600_000) / 1000, updatedAt: (NOW - 60_000) / 1000 }, [], false) }, NOW)!;
    expect(stopped.stateSince).toBe(NOW - 60_000);
    const idle = deriveSession({ ...base, reg: reg({ startedAt: (NOW - 600_000) / 1000, status: 'idle', statusUpdatedAt: (NOW - 30_000) / 1000 }) }, NOW)!;
    expect(idle.stateSince).toBe(NOW - 30_000);
  });

  it('applies a seconds startedAt to hook events, so a dead process\'s notification does not leak into its resume', () => {
    const events = parseEvents([JSON.stringify({ event: 'Notification', sessionId: 's', ts: NOW - 7_200_000, message: 'Allow Bash?' })]);
    const s = deriveSession({ ...base, events, reg: reg({ startedAt: (NOW - 600_000) / 1000 }) }, NOW)!;
    expect(s.state).not.toBe('needs-you');
  });

  it('drops hook events with absurd timestamps instead of pinning a state forever', () => {
    const ev = parseEvents([
      '{"event":"Notification","sessionId":"s","ts":1e300,"message":"far"}',
      '{"event":"Notification","sessionId":"s","ts":1791820000000000,"message":"micro"}',
      '{"event":"Notification","sessionId":"s","ts":-5,"message":"neg"}',
      `{"event":"Stop","sessionId":"s","ts":${NOW / 1000}}`,
    ]);
    expect(ev.map((e) => e.event)).toEqual(['Stop']);
    expect(ev[0].ts).toBe(NOW);
  });
});

describe('status chaos: wrong types in transcripts', () => {
  it('ignores token counts that are not numbers', () => {
    const s = deriveSession({ ...base, reg: reg({ startedAt: NOW - 3_600_000 },
      [asst(iso(NOW - 60_000), { usage: { input_tokens: 5, cache_read_input_tokens: '100000', cache_creation_input_tokens: null } })]) }, NOW)!;
    expect(s.contextPct).toBe(0);
  });

  it('sums summary tokens as numbers', () => {
    const sum = buildSummary([asst(iso(NOW), { id: 'm1', usage: { input_tokens: '5', output_tokens: { a: 1 }, cache_creation_input_tokens: 7 } }),
      asst(iso(NOW), { id: 'm2', usage: { input_tokens: 10, output_tokens: 3 } })]);
    expect(sum.tokensIn).toBe(17);
    expect(sum.tokensOut).toBe(3);
  });
});

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mergeEntry, pendingRequest, cloudSession, MAX_LINES } from '../src/cloud/reduce.js';
import type { CloudRaw, CloudRequest } from '../src/cloud/types.js';

const FIX = join(import.meta.dirname, 'fixtures/cloud');
const raw = (f: string): CloudRaw => { const { _note, ...r } = JSON.parse(readFileSync(join(FIX, f), 'utf8')); return r; };
const PENDING = raw('ask-pending.raw.json');
const ANSWERED = raw('ask-answered.raw.json');
const O = { account: 'main', host: 'local', hostOnline: true, lastSeen: 1_000 };
const lit = (o: Partial<CloudRaw> = {}): CloudRaw => ({
  id: 'session_01Lit', title: 'Lit', status: 'idle', unread: false, createdAt: '2026-11-11T08:00:00Z', updatedAt: '2026-11-11T09:00:00Z', ...o,
});
const req = (o: Partial<CloudRequest> = {}): CloudRequest => ({
  requestId: 'r1', eventId: 'e1', prevId: 'e0', toolName: 'Bash', input: { command: 'date' }, createdAt: '2026-11-11T09:00:00Z', ...o,
});
const ev = (o: object = {}) => ({ lines: [], requests: [], resolved: [], lastId: 'e1', more: false, ...o });

describe('cloud reduce', () => {
  it('pending AskUserQuestion is needs-you with its question', () => {
    const s = cloudSession(mergeEntry(undefined, PENDING), O);
    expect(s).toMatchObject({ key: 'cloud:session_01FixtureAskAnswered', sessionId: 'session_01FixtureAskAnswered', pid: 0, cloud: true, live: true,
      state: 'needs-you', question: 'Pick a colour for the test', name: 'Answer spike', cwd: '', host: 'local', account: 'main', repo: 'example/widgets' });
    expect(s.stateSince).toBe(Date.parse(PENDING.events!.requests[0].createdAt));
    expect(s.permission).toBeUndefined();
    expect(s.tmux).toBeUndefined();
    expect(s.cacheExpiresAt).toBeUndefined();
  });

  it('a permission request sets permission and the Claude heading', () => {
    const s = cloudSession(mergeEntry(undefined, lit({ status: 'requires_action', events: ev({ requests: [req()] }) })), O);
    expect(s).toMatchObject({ state: 'needs-you', question: 'Claude needs your permission to use Bash', permission: true });
    expect(s.stateSince).toBe(Date.parse('2026-11-11T09:00:00Z'));
  });

  it('requires_action before its request is read is needs-you since updatedAt', () => {
    const s = cloudSession(mergeEntry(undefined, lit({ status: 'requires_action', updatedAt: '2026-11-11T09:30:00Z' })), O);
    expect(s).toMatchObject({ state: 'needs-you', stateSince: Date.parse('2026-11-11T09:30:00Z') });
    expect(s.question).toBeUndefined();
  });

  it('resolved requests drop out across merges', () => {
    const a = mergeEntry(undefined, lit({ status: 'requires_action', events: ev({ requests: [req()] }) }));
    expect(a.requests).toHaveLength(1);
    const b = mergeEntry(a, lit({ status: 'requires_action', updatedAt: 'later', events: ev({ resolved: ['r1'], lastId: 'e2' }) }));
    expect(b.requests).toEqual([]);
    expect(b.afterId).toBe('e2');
  });

  it('a request is not pending unless the list says requires_action', () => {
    const e = mergeEntry(undefined, lit({ status: 'idle', events: ev({ requests: [req()] }) }));
    expect(e.requests).toHaveLength(1);
    expect(pendingRequest(e)).toBeUndefined();
  });

  it('several pending requests: the oldest first', () => {
    const e = mergeEntry(undefined, lit({ status: 'requires_action', events: ev({ requests: [
      req({ requestId: 'late', createdAt: '2026-11-11T09:05:00Z' }), req({ requestId: 'early', createdAt: '2026-11-11T09:01:00Z' })] }) }));
    expect(pendingRequest(e)?.requestId).toBe('early');
  });

  it('idle is asleep whether unread or read, since the last result: only a pending request needs you', () => {
    const unread = cloudSession(mergeEntry(undefined, { ...ANSWERED, unread: true }), O);
    expect(unread).toMatchObject({ state: 'asleep', idle: true, stateSince: Date.parse('2026-11-11T10:59:05.192147Z') });
    const read = cloudSession(mergeEntry(undefined, { ...ANSWERED, unread: false }), O);
    expect(read).toMatchObject({ state: 'asleep', idle: true, stateSince: Date.parse('2026-11-11T10:59:05.192147Z') });
    const noResult = cloudSession(mergeEntry(undefined, lit()), O);
    expect(noResult).toMatchObject({ state: 'asleep', stateSince: Date.parse('2026-11-11T09:00:00Z') });
  });

  it('running is working and busy', () => {
    const s = cloudSession(mergeEntry(undefined, lit({ status: 'running' })), O);
    expect(s).toMatchObject({ state: 'working', busy: true, stateSince: Date.parse('2026-11-11T08:00:00Z') });
    const withPrompt = cloudSession(mergeEntry(undefined, { ...ANSWERED, status: 'running' }), O);
    expect(withPrompt.stateSince).toBe(Date.parse('2026-11-11T10:59:00.783364Z'));
  });

  it('an unknown status is asleep since updatedAt', () => {
    expect(cloudSession(mergeEntry(undefined, lit({ status: 'paused' })), O)).toMatchObject({ state: 'asleep', stateSince: Date.parse('2026-11-11T09:00:00Z') });
  });

  it('lastPrompts and lastSaid come from the event lines', () => {
    const s = cloudSession(mergeEntry(undefined, ANSWERED), { ...O, prompts: ['an older prompt from before'] });
    expect(s.lastPrompts).toContain('hello from the tablet');
    expect(s.lastPrompts![0]).toBe('an older prompt from before');
    expect(s.lastSaid).toBe('GOT: hello from the tablet');
  });

  it('context from context_usage', () => {
    const s = cloudSession(mergeEntry(undefined, lit({ contextUsed: 900000, contextMax: 1000000, model: 'claude-opus-5-5' })), O);
    expect(s).toMatchObject({ contextPct: 90, contextTokens: 900000, contextWindow: 1000000, overContext: true, model: 'claude-opus-5-5' });
    expect(cloudSession(mergeEntry(undefined, lit()), O).contextPct).toBeUndefined();
  });

  it('events.more forces a re-read', () => {
    expect(mergeEntry(undefined, lit({ events: ev({ more: true }) })).updatedAt).toBe('');
    expect(mergeEntry(undefined, lit({ events: ev() })).updatedAt).toBe('2026-11-11T09:00:00Z');
  });

  it('a poll that skipped the events keeps the read state and its updatedAt', () => {
    const a = mergeEntry(undefined, ANSWERED);
    const b = mergeEntry(a, { ...lit({ id: ANSWERED.id, updatedAt: '2026-11-11T12:00:00Z' }) });
    expect(b.lines).toBe(a.lines);
    expect(b.afterId).toBe(a.afterId);
    expect(b.updatedAt).toBe(a.updatedAt);
    expect(b.raw.updatedAt).toBe('2026-11-11T12:00:00Z');
    expect(mergeEntry(undefined, lit()).updatedAt).toBe('');
  });

  it('keeps the newest MAX_LINES lines', () => {
    const many = Array.from({ length: MAX_LINES + 5 }, (_, i) => `{"n":${i}}`);
    const e = mergeEntry(mergeEntry(undefined, lit({ events: ev({ lines: many.slice(0, 30) }) })), lit({ events: ev({ lines: many.slice(30) }) }));
    expect(e.lines).toHaveLength(MAX_LINES);
    expect(e.lines[MAX_LINES - 1]).toBe(`{"n":${MAX_LINES + 4}}`);
  });

  it('has no raw events in the entry', () => {
    expect('events' in mergeEntry(undefined, PENDING).raw).toBe(false);
  });
});

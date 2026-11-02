import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lastPromptsOf, mergePrompts, promptText, readmeAbout, saidText, MAX_PROMPTS, SAID_CHARS } from '../src/core/prompts.js';
import { deriveSession, type DeriveInput } from '../src/core/status.js';
import { PROBE } from './helpers/probe.js';

const J = (o: object) => JSON.stringify(o);
const user = (content: unknown, extra: object = {}) => J({ type: 'user', timestamp: '2026-10-22T10:00:00Z', message: { role: 'user', content }, ...extra });

describe('promptText', () => {
  it('keeps a typed prompt, one line', () => {
    expect(promptText(JSON.parse(user('fix the login\nbug on the settings page')))).toBe('fix the login bug on the settings page');
    expect(promptText(JSON.parse(user([{ type: 'text', text: 'run the tests and fix what fails' }])))).toBe('run the tests and fix what fails');
  });
  it('skips tool results, meta, sidechain and compaction entries', () => {
    expect(promptText(JSON.parse(user([{ type: 'tool_result', tool_use_id: 't', content: 'a long enough tool output' }])))).toBeUndefined();
    expect(promptText(JSON.parse(user('a skill body injected as a user entry', { isMeta: true })))).toBeUndefined();
    expect(promptText(JSON.parse(user('a sub-agent prompt that is long enough', { isSidechain: true })))).toBeUndefined();
    expect(promptText(JSON.parse(user('This session summary is long enough', { isCompactSummary: true })))).toBeUndefined();
    expect(promptText(JSON.parse(J({ type: 'assistant', message: { content: 'an assistant reply long enough' } })))).toBeUndefined();
  });
  it('skips reminders, hook output, slash commands, interrupts and pasted blobs', () => {
    for (const t of ['<system-reminder>stuff that is long</system-reminder>', '<command-name>/clear</command-name>', '/compact keep the plan please',
      '[Request interrupted by user for tool use]', 'Caveat: the messages below were generated',
      'it fails with\nTraceback (most recent call last):\n  File "x.py"', 'here is the log ```\nerr\n```', 'router.mjs:12:4 TypeError: x is undefined',
      'the payload was {"a": 1, "b": 2} why', '$ npm test fails here'])
      expect(promptText(JSON.parse(user(t))), t).toBeUndefined();
  });
  it('skips lines too short or too long, and cuts to 160 characters', () => {
    expect(promptText(JSON.parse(user('yes do it')))).toBeUndefined();
    expect(promptText(JSON.parse(user('x'.repeat(401))))).toBeUndefined();
    const t = promptText(JSON.parse(user(`make the ${'very '.repeat(60)}long thing`)))!;
    expect(t.length).toBe(160);
    expect(t.endsWith('…')).toBe(true);
  });
});

describe('lastPromptsOf / mergePrompts', () => {
  it('the last n typed prompts, oldest first, each once', () => {
    const lines = ['add a dark mode toggle', 'tool', 'now fix the header colours', 'add a dark mode toggle', 'ship it to main please', 'write the changelog entry']
      .map((t) => (t === 'tool' ? user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]) : user(t)));
    expect(lastPromptsOf(['not json', ...lines], 3)).toEqual(['add a dark mode toggle', 'ship it to main please', 'write the changelog entry']);
    expect(lastPromptsOf(['not json', ...lines])).toEqual(['now fix the header colours', 'add a dark mode toggle', 'ship it to main please', 'write the changelog entry']);
  });
  it('keeps eight by default', () => {
    expect(MAX_PROMPTS).toBe(8);
    const lines = Array.from({ length: 10 }, (_, i) => user(`prompt number ${i} for the router`));
    expect(lastPromptsOf(lines)).toEqual(Array.from({ length: 8 }, (_, i) => `prompt number ${i + 2} for the router`));
  });
  it('keeps remembered prompts that scrolled out of the tail', () => {
    expect(mergePrompts(['one older prompt', 'two older prompt'], ['three newest prompt'])).toEqual(['one older prompt', 'two older prompt', 'three newest prompt']);
    expect(mergePrompts(['a', 'b', 'c'], ['b', 'd'], 3)).toEqual(['c', 'b', 'd']);
    expect(mergePrompts(undefined, ['a', 'b', 'c', 'd'], 3)).toEqual(['b', 'c', 'd']);
    expect(mergePrompts(['a', 'b', 'c'], ['b', 'd'])).toEqual(['a', 'c', 'b', 'd']);
    expect(mergePrompts(['a'], [])).toEqual(['a']);
  });
});

describe('deriveSession lastPrompts', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const input = (transcript: string[], prompts?: Map<string, string[]>): DeriveInput => ({
    host: 'local', account: 'me', events: [], usageExhausted: false, cacheTtlMinutes: 60, contextWindows: { default: 200000 }, hostOnline: true, lastSeen: NOW,
    reg: { file: '1.json', mtimeMs: NOW - 5000, live: true, transcript, data: { pid: 1, sessionId: 's', cwd: '/home/u/code/app', startedAt: NOW - 3600_000, status: 'idle' } },
    ...(prompts && { prompts }),
  });
  it('carries the typed prompts and remembers them across polls', () => {
    const memory = new Map<string, string[]>();
    expect(deriveSession(input([user('add a dark mode toggle')], memory), NOW)!.lastPrompts).toEqual(['add a dark mode toggle']);
    // The next poll's tail has scrolled past it.
    const s = deriveSession(input([user('now fix the header colours')], memory), NOW)!;
    expect(s.lastPrompts).toEqual(['add a dark mode toggle', 'now fix the header colours']);
    expect(memory.get('local:me:s')).toEqual(s.lastPrompts);
  });
  it('has no field when nothing was typed', () => {
    expect(deriveSession(input([user([{ type: 'tool_result', tool_use_id: 't', content: 'x' }])]), NOW)!.lastPrompts).toBeUndefined();
  });
});

describe('lastSaid', () => {
  const NOW = Date.parse('2026-10-22T12:00:00Z');
  const said = (text: string) => J({ type: 'assistant', timestamp: '2026-10-22T10:01:00Z', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'text', text }] } });
  const input = (transcript: string[]): DeriveInput => ({
    host: 'local', account: 'me', events: [], usageExhausted: false, cacheTtlMinutes: 60, contextWindows: { default: 200000 }, hostOnline: true, lastSeen: NOW,
    reg: { file: '1.json', mtimeMs: NOW - 5000, live: true, transcript, data: { pid: 1, sessionId: 's', cwd: '/home/u/code/app', startedAt: NOW - 3600_000, status: 'idle' } },
  });
  it('the start of the last reply, one line, cut', () => {
    expect(saidText('The tablet\n\nreconnects now.')).toBe('The tablet reconnects now.');
    expect(saidText('  ')).toBeUndefined();
    expect(saidText(undefined)).toBeUndefined();
    const t = saidText('word '.repeat(300))!;
    expect(t.length).toBe(SAID_CHARS);
    expect(t.endsWith('…')).toBe(true);
  });
  it('deriveSession carries it from the transcript tail', () => {
    expect(deriveSession(input([user('add a dark mode toggle'), said('Added the toggle in settings.\nIt follows the system theme.')]), NOW)!.lastSaid)
      .toBe('Added the toggle in settings. It follows the system theme.');
    expect(deriveSession(input([user('add a dark mode toggle')]), NOW)!.lastSaid).toBeUndefined();
  });
});

describe('readmeAbout', () => {
  it('the first sentence of the first prose paragraph', () => {
    const md = '---\ntitle: x\n---\n# ClayClaude\n\n[![ci](https://x/badge.svg)](https://x)\n<p align="center"><img src="a.png"></p>\n\n'
      + 'A **board** for every [Claude Code](https://claude.com) session on your `tablet`. It shows who needs you.\n\nMore.';
    expect(readmeAbout(md)).toBe('A board for every Claude Code session on your tablet.');
  });
  it('a paragraph with no sentence end is taken whole; nothing usable is undefined', () => {
    expect(readmeAbout('# t\n\nDocker stacks on the Pi\n')).toBe('Docker stacks on the Pi');
    expect(readmeAbout('# Title only\n\n- a list\n```\ncode\n```\n')).toBeUndefined();
    expect(readmeAbout(undefined)).toBeUndefined();
    expect(readmeAbout('# t\n\nShort.')).toBeUndefined();
    expect(readmeAbout('# t\n\nThis repository contains:\n\n- a\n- b\n\nThe site for a client. More.')).toBe('The site for a client.');
    expect(readmeAbout('# t\n\nThis repository contains:\n- a\n')).toBeUndefined();
  });
  it('cuts a long sentence to 140 characters at a word boundary', () => {
    const a = readmeAbout(`# t\n\n${'word '.repeat(80)}end.`)!;
    expect(a.length).toBeLessThanOrEqual(140);
    expect(a.endsWith('word…')).toBe(true);
  });
});

describe('probe repos readme', () => {
  it('sends the README head only when asked', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-readme-'));
    mkdirSync(join(home, 'code', 'alpha', '.git'), { recursive: true });
    mkdirSync(join(home, 'code', 'beta', '.git'), { recursive: true });
    writeFileSync(join(home, 'code', 'alpha', 'README.md'), `# Alpha\n\nAlpha does things. ${'x'.repeat(5000)}`);
    const probe = (req: object) => JSON.parse(execFileSync('python3', [PROBE, JSON.stringify(req)], { encoding: 'utf8', env: { ...process.env, HOME: home } }));
    const r = probe({ mode: 'repos', roots: ['~/code'], configDirs: [], readme: true });
    const alpha = r.repos.find((x: any) => x.name === 'alpha');
    expect(alpha.readme.startsWith('# Alpha\n\nAlpha does things.')).toBe(true);
    expect(alpha.readme.length).toBe(2048);
    expect(r.repos.find((x: any) => x.name === 'beta').readme).toBeUndefined();
    expect(probe({ mode: 'repos', roots: ['~/code'], configDirs: [] }).repos.find((x: any) => x.name === 'alpha').readme).toBeUndefined();
  });
  it('never follows a symlinked README, inside or outside the repo, and skips a secret-looking head', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-readme-'));
    for (const r of ['out', 'in', 'env', 'key', 'ok']) mkdirSync(join(home, 'code', r, '.git'), { recursive: true });
    mkdirSync(join(home, '.ssh'));
    writeFileSync(join(home, '.ssh', 'id_rsa'), `-----BEGIN ${'OPENSSH'} PRIVATE ${'KEY'}-----\nabc\n`);
    symlinkSync(join(home, '.ssh', 'id_rsa'), join(home, 'code', 'out', 'README.md'));
    writeFileSync(join(home, 'code', 'in', 'notes.md'), '# In\n\nA file inside the repo.');
    symlinkSync(join(home, 'code', 'in', 'notes.md'), join(home, 'code', 'in', 'README.md'));
    writeFileSync(join(home, 'code', 'env', 'README.md'), '# Env\n\nSet these.\nEXAMPLE_TOKEN=placeholder\n');
    writeFileSync(join(home, 'code', 'key', 'README.md'), `-----BEGIN ${'RSA'} PRIVATE ${'KEY'}-----\nabc\n`);
    writeFileSync(join(home, 'code', 'ok', 'README.md'), '# Ok\n\nA plain readme.');
    const r = JSON.parse(execFileSync('python3', [PROBE, JSON.stringify({ mode: 'repos', roots: ['~/code'], configDirs: [], readme: true })], { encoding: 'utf8', env: { ...process.env, HOME: home } }));
    const head = (n: string) => r.repos.find((x: any) => x.name === n).readme;
    expect(head('out')).toBeUndefined();
    expect(head('in')).toBeUndefined();
    expect(head('env')).toBeUndefined();
    expect(head('key')).toBeUndefined();
    expect(head('ok')).toBe('# Ok\n\nA plain readme.');
  });
});

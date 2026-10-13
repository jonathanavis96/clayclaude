import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PYTHON } from './helpers/probe.js';

const HOOK = join(import.meta.dirname, '../src/hooks/clayclaude-hook.py');

function hookDir() {
  const d = join(mkdtempSync(join(tmpdir(), 'cc-hookchaos-')), 'clayclaude');
  mkdirSync(d);
  copyFileSync(HOOK, join(d, 'hook.py'));
  return d;
}
const run = (d: string, input: string) =>
  execFileSync(PYTHON, [join(d, 'hook.py'), 'Stop'], { input, encoding: 'utf8', timeout: 5000 });

describe('hook chaos', () => {
  it('does not block Claude Code when events.jsonl is a FIFO with no reader', () => {
    const d = hookDir();
    execFileSync('mkfifo', [join(d, 'events.jsonl')]);
    expect(run(d, '{"session_id":"s"}')).toBe('');
  });

  it('does not block or grow an endless file when events.jsonl points at a device', () => {
    const d = hookDir();
    symlinkSync('/dev/null', join(d, 'events.jsonl'));
    expect(run(d, '{"session_id":"s"}')).toBe('');
  });

  it('survives deeply nested hook input', () => {
    const d = hookDir();
    expect(run(d, '['.repeat(100_000) + ']'.repeat(100_000))).toBe('');
    run(d, '{"session_id":"s2"}');
    expect(readFileSync(join(d, 'events.jsonl'), 'utf8')).toContain('"s2"');
  });
});

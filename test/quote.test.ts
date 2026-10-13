import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { shq, shJoin, shqPath } from '../src/actions/quote.js';
import { parseTmuxRef, safeName } from '../src/actions/validate.js';

const NASTY = ["plain", "it's", `a"b`, 'x; rm -rf /', '$(id)', '`id`', 'a\nb', '-n', '--', '', '  lead trail  ', '*?[]{}', 'a\\b', "'", "''", 'tab\there', 'ünï ☃',
  // fish reads `\\` and `\'` as escapes even inside single quotes (sshd runs the command with the login shell).
  "\\'; touch pwned; #", 'end\\', '\\\\', "x\\'y", '\\\''];

/** A fish binary for the login-shell round trip: CLAYCLAUDE_TEST_FISH, or fish on PATH. */
const FISH = process.env.CLAYCLAUDE_TEST_FISH
  || (() => { try { return execFileSync('sh', ['-c', 'command -v fish'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();

/** The single-quoted spans of a quoted word (no shell-specific escapes inside them). */
function quotedSpans(q: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] === '\\') { i++; continue; }           // an escape outside quotes
    if (q[i] !== "'") continue;
    const end = q.indexOf("'", i + 1);
    spans.push(q.slice(i + 1, end));
    i = end;
  }
  return spans;
}

describe('shq', () => {
  it('round-trips through a real shell for hostile strings', () => {
    for (const s of NASTY) {
      const out = execFileSync('sh', ['-c', `printf %s ${shq(s)}`], { encoding: 'utf8' });
      expect(out).toBe(s);
    }
  });
  // A remote login shell may be fish, which reads `\\` and `\'` inside single quotes as escapes, so a reply such as
  // `\'; touch pwned; #` closed the quote early and ran the rest. Backslashes must stay outside the quotes.
  it('keeps every backslash outside single quotes, so fish reads the word as sh does', () => {
    for (const s of NASTY) for (const span of quotedSpans(shq(s))) expect(span).not.toContain('\\');
  });
  it.skipIf(!FISH)('round-trips through fish as a login shell', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'cc-fish-'));
    for (const s of NASTY) {
      const out = execFileSync(FISH, ['--no-config', '-c', `printf %s ${shJoin([s])}; printf '|%s' ${shJoin(['next', s])}`], { encoding: 'utf8', cwd });
      expect(out).toBe(`${s}|next|${s}`);
    }
    expect(existsSync(join(cwd, 'pwned'))).toBe(false);
  });
  it('shJoin keeps argument boundaries', () => {
    const out = execFileSync('sh', ['-c', `for a in ${shJoin(['a b', "c'd", ';'])}; do printf '[%s]' "$a"; done`], { encoding: 'utf8' });
    expect(out).toBe("[a b][c'd][;]");
  });
  it('rejects NUL', () => expect(() => shq('a\0b')).toThrow());
  it('shqPath lets the shell expand ~ but nothing else', () => {
    const out = execFileSync('sh', ['-c', `HOME=/h; printf %s ${shqPath('~/a b/$x')}`], { encoding: 'utf8' });
    expect(out).toBe('/h/a b/$x');
    expect(execFileSync('sh', ['-c', `printf %s ${shqPath('/p/~x')}`], { encoding: 'utf8' })).toBe('/p/~x');
  });
});

describe('validate', () => {
  it('parses registry tmux refs and rejects junk', () => {
    expect(parseTmuxRef('main:@1.%1')).toEqual({ session: 'main', window: '@1', pane: '%1' });
    expect(parseTmuxRef('my agents:@12.%34')).toEqual({ session: 'my agents', window: '@12', pane: '%34' });
    for (const bad of [undefined, '', 'main', 'main:@1', "o';id:@1.%1", 'o:@1.%1;x', '-x:@1.%1', 'a:b:@1.%1', 'o:@x.%1']) expect(parseTmuxRef(bad)).toBeNull();
  });
  it('makes safe window names', () => {
    expect(safeName('my repo; $(x)')).toBe('my-repo-x');
    expect(safeName('///')).toBe('claude');
  });
});

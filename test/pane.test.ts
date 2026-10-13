import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePane } from '../src/actions/pane.js';

const fx = (n: string) => readFileSync(join(import.meta.dirname, 'fixtures/panes', n), 'utf8');

describe('parsePane', () => {
  it('reads a permission prompt into one option per line', () => {
    const p = parsePane(fx('perm-bash.txt'));
    expect(p.kind).toBe('menu');
    expect(p.title).toBe('Do you want to proceed?');
    expect(p.detail).toContain('npm run build');
    expect(p.options.map((o) => [o.key, o.label, o.selected])).toEqual([
      ['1', 'Yes', true],
      ['2', "Yes, and don't ask again for npm run build commands in /home/demo/orchard-api", false],
      ['3', 'No, and tell Claude what to do differently (esc)', false],
    ]);
  });
  it('reads the boxed layout the same way', () => {
    const p = parsePane(fx('perm-bash-boxed.txt'));
    expect(p.kind).toBe('menu');
    expect(p.options).toHaveLength(3);
    expect(p.detail).toContain('rm -rf dist');
  });
  it('does not mistake diff line numbers for options and keeps the diff as detail', () => {
    const p = parsePane(fx('perm-edit.txt'));
    expect(p.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(p.title).toBe('Do you want to make this edit to server.ts?');
    expect(p.detail).toContain("const host = '127.0.0.1';");
  });
  it('reads a question menu with descriptions', () => {
    const p = parsePane(fx('askuser.txt'));
    expect(p.kind).toBe('menu');
    expect(p.title).toBe('Which database should the new service use?');
    expect(p.options.map((o) => o.label)).toEqual(['PostgreSQL', 'SQLite', 'Type something.']);
    expect(p.options[0].description).toBe('Mature, relational, good tooling');
  });
  it('reads a free-text question as text', () => {
    const p = parsePane(fx('idle-text.txt'));
    expect(p.kind).toBe('text');
    expect(p.options).toEqual([]);
    expect(p.detail).toContain('update the changelog');
  });
  it('does not treat a numbered list in earlier output as a menu', () => {
    const p = parsePane(fx('old-list.txt'));
    expect(p.kind).toBe('text');
    expect(p.options).toEqual([]);
  });
  it('does not treat an earlier list as a menu when the input box holds a multi-line draft over a tall status area', () => {
    const p = parsePane(fx('old-list-draft.txt'));
    expect(p.kind).toBe('text');
    expect(p.options).toEqual([]);
    expect(p.detail).toContain('Want me to continue?');
  });
  it('does not treat an earlier list as a menu when an empty input box sits over a status area taller than six rows', () => {
    const lines = fx('old-list-tall-status.txt').trimEnd().split('\n');
    for (const rows of [8, 7]) {
      const p = parsePane(lines.slice(0, lines.length - (8 - rows)).join('\n'));
      expect(p.kind, `${rows} status rows`).toBe('text');
      expect(p.options).toEqual([]);
      expect(p.detail).toContain('Want me to continue?');
    }
  });
  it('never reads a list as a menu when an input box is drawn below it, even if the box itself is not recognised', () => {
    // A status row shaped like an option keeps findBox from accepting the box; the list must still not become a menu.
    const raw = fx('old-list-tall-status.txt').replace('  1 background shell running', '  3. background shells running');
    expect(parsePane(raw).kind).not.toBe('menu');
    expect(parsePane(raw).options).toEqual([]);
  });
  it('does not treat a numbered list typed into the input box as a menu', () => {
    const p = parsePane(fx('draft-numbered.txt'));
    expect(p.kind).toBe('text');
    expect(p.options).toEqual([]);
    expect(p.detail).toContain('open the PR');
  });
  it('a real menu under an old input-box-shaped pair in the output is still a menu', () => {
    const rule = '─'.repeat(60);
    const p = parsePane(`${rule}\n> quoted earlier\n   output\n${fx('perm-bash.txt')}`);
    expect(p.kind).toBe('menu');
    expect(p.options.map((o) => o.key)).toEqual(['1', '2', '3']);
  });
  it('a rule and a ">" line inside a boxed command do not turn the menu into a text prompt', () => {
    const p = parsePane(fx('perm-boxed-quote.txt'));
    expect(p.kind).toBe('menu');
    expect(p.options.map((o) => o.key)).toEqual(['1', '2']);
    expect(p.detail).toContain('> a quote');
  });
  it('a rule and a ">" line inside a borderless command near the bottom do not turn the menu into a text prompt', () => {
    const rule = '─'.repeat(60);
    const p = parsePane(`${rule}\n Bash command\n\n   echo hi \\\n   ----------\n   > out.txt\n   Write file\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n`);
    expect(p.kind).toBe('menu');
    expect(p.options.map((o) => o.key)).toEqual(['1', '2']);
  });
  it('returns none when there is neither a menu nor an input box', () => {
    expect(parsePane(fx('shell.txt')).kind).toBe('none');
    expect(parsePane('').kind).toBe('none');
  });
  it('hashes are stable across timers and spinners but change with the prompt', () => {
    const a = parsePane(fx('perm-bash.txt')), b = parsePane(fx('perm-bash.txt'));
    expect(a.hash).toBe(b.hash);
    expect(parsePane(fx('perm-bash-boxed.txt')).hash).not.toBe(a.hash);
    const busy = fx('busy.txt');
    expect(parsePane(busy).hash).toBe(parsePane(busy.replace('47s', '48s').replace('1.2k', '1.3k')).hash);
    expect(parsePane(fx('idle-text.txt')).hash).not.toBe(parsePane(busy).hash);
  });
  it('a different command in the same prompt changes the hash', () => {
    const base = fx('perm-bash.txt');
    expect(parsePane(base.replaceAll('npm run build', 'rm -rf /')).hash).not.toBe(parsePane(base).hash);
  });
  it('reads wrapped lines: the whole command as detail, the wrapped option still one option, and the wrapped part in the hash', () => {
    const raw = fx('perm-wrapped.txt');
    const p = parsePane(raw);
    expect(p.kind).toBe('menu');
    expect(p.options.map((o) => o.key)).toEqual(['1', '2', '3']);
    expect(p.detail).toContain('--if-present');
    const two = p.options[1];
    expect(`${two.label} ${two.description ?? ''}`).toContain('/home/demo/code/a-very-long-project-name');
    expect(parsePane(raw.replace('a-very-long-project-name', 'another-project-name-xx')).hash).not.toBe(p.hash);
  });
  // Claude Code 2.1.296 draws the command between dashed rules (U+254C) with no blank line before the question.
  it('reads the dashed-rule layout: the question alone as the title, the header and command as the detail', () => {
    const p = parsePane(fx('perm-bash-dashed.txt'));
    expect(p.kind).toBe('menu');
    expect(p.title).toBe('Do you want to proceed?');
    expect(p.detail).toContain('Bash command');
    expect(p.detail).toContain("mkdir -p /tmp/scratch && printf 'ok\\n' >");
    expect(p.options.map((o) => o.key)).toEqual(['1', '2', '3', '4']);
    const w = parsePane(fx('perm-write-dashed.txt'));
    expect(w.title).toBe('Do you want to create ok2.txt?');
    expect(w.detail).toContain('Create file');
    expect(w.detail).toContain('1 ok');
    expect(w.options.map((o) => o.key)).toEqual(['1', '2', '3']);
  });
  it('shows a dashed rule short, so it never widens the sheet, and does not end the detail with one', () => {
    for (const f of ['perm-bash-dashed.txt', 'perm-write-dashed.txt']) {
      const lines = parsePane(fx(f)).detail.split('\n');
      expect(Math.max(...lines.map((l) => [...l].length))).toBeLessThan(80);
      expect(lines.some((l) => /^╌+$/.test(l))).toBe(true);
      expect(lines[lines.length - 1]).not.toMatch(/^╌+$/);
    }
  });
  it('a different command between dashed rules changes the hash', () => {
    const raw = fx('perm-bash-dashed.txt');
    expect(parsePane(raw.replaceAll('mkdir -p /tmp/scratch', 'rm -rf ~/scratch')).hash).not.toBe(parsePane(raw).hash);
  });
  it('offers at most nine options (answers are single digits)', () => {
    const many = Array.from({ length: 11 }, (_, i) => `  ${i + 1}. Choice ${i + 1}`).join('\n');
    expect(parsePane(`Pick one?\n${many}\n`).options.map((o) => o.key)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
  });
  it('reads a command with a blank line in it whole: header, every paragraph, in the detail and the hash', () => {
    const raw = fx('perm-heredoc.txt');
    const p = parsePane(raw);
    expect(p.kind).toBe('menu');
    expect(p.title).toBe('Do you want to proceed?');
    expect(p.detail).toContain('Bash command');
    expect(p.detail).toContain('git commit -m "$(cat <<\'EOF\'\nFix the parser\n\nCovers the whole command');
    expect(p.detail).toContain('Commit the parser fix');
    expect(parsePane(raw.replace('Fix the parser', 'Break the parser')).hash).not.toBe(p.hash);
    expect(parsePane(raw.replace('git commit -m', 'git commit --amend -m')).hash).not.toBe(p.hash);
  });
  it('a dangerous first paragraph is never hidden behind a blank line', () => {
    const rule = '─'.repeat(60);
    const menu = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No, and tell Claude what to do differently (esc)\n';
    const pane = (cmd: string) => `${rule}\n Bash command\n\n   ${cmd}\n\n   echo done\n   Clean up\n\n${menu}`;
    const rm = parsePane(pane('rm -rf ~/important'));
    expect(rm.detail).toContain('rm -rf ~/important');
    expect(rm.hash).not.toBe(parsePane(pane('ls')).hash);
  });
  it('hashes a long command whole and marks where the shown detail was cut', () => {
    const rule = '─'.repeat(60);
    const body = Array.from({ length: 40 }, (_, i) => `   echo line ${i + 1}`).join('\n');
    const pane = (first: string) =>
      `${rule}\n Bash command\n\n   ${first}\n${body}\n   Long script\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n`;
    const p = parsePane(pane('rm -rf ~/important'));
    expect(p.hash).not.toBe(parsePane(pane('ls')).hash);
    expect(p.detail).toContain('rm -rf ~/important');
    expect(p.detail).toContain('Long script');
    expect(p.detail).toMatch(/…\s*\d+ more lines?\s*…/);
  });
  it('a line of dashes inside a command does not cut it short, and a very long line is cut with a marker', () => {
    const rule = '─'.repeat(60);
    const pane = (first: string, last: string) =>
      `${rule}\n Bash command\n\n   ${first}\n   ────────────────\n   ${last}\n   Demo\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. No (esc)\n`;
    const p = parsePane(pane('rm -rf ~/important', 'echo done'));
    expect(p.detail).toContain('rm -rf ~/important');
    expect(p.hash).not.toBe(parsePane(pane('ls', 'echo done')).hash);
    const long = parsePane(pane('echo start', 'x'.repeat(5000)));
    expect(long.detail).toContain('echo start');
    expect(long.detail).toMatch(/… \d+ more characters …/);
    expect(long.detail.length).toBeLessThan(1700);
  });
  it('keeps the header group in the detail of an edit prompt', () => {
    const p = parsePane(fx('perm-edit.txt'));
    expect(p.detail).toContain('Edit file\nsrc/server.ts');
    expect(p.detail).toContain("const host = '127.0.0.1';");
    expect(parsePane(fx('perm-edit.txt').replace('src/server.ts', 'src/other.ts')).hash).not.toBe(p.hash);
  });
});

describe('parsePane: the folder-trust question (Task 40)', () => {
  it('reads the 2.1.296 trust dialog, whose options are not numbered, as a trust menu picked with arrow keys', () => {
    const p = parsePane(fx('trust-folder.txt'));
    expect(p.kind).toBe('menu');
    expect(p.trust).toBe(true);
    expect(p.title).toBe('Is this a project you created or one you trust?');
    expect(p.detail).toContain('/home/demo/code/harbor-notes');
    expect(p.detail).toContain("Claude Code'll be able to read, edit, and execute files here.");
    expect(p.options.map((o) => [o.key, o.label, o.selected])).toEqual([['1', 'No, exit', true], ['2', 'Yes, I trust this folder', false]]);
  });
  it('changes its hash when the cursor moves, so an answer for one cursor position is never sent at another', () => {
    const a = parsePane(fx('trust-folder.txt'));
    const moved = fx('trust-folder.txt').replace(' ❯ No, exit', '   No, exit').replace('   Yes, I trust this folder', ' ❯ Yes, I trust this folder');
    const b = parsePane(moved);
    expect(b.options.map((o) => o.selected)).toEqual([false, true]);
    expect(b.hash).not.toBe(a.hash);
  });
  it('does not read a permission prompt or an unrelated two-line list as the trust question', () => {
    expect(parsePane(fx('perm-bash.txt')).trust).toBeUndefined();
    const plain = ' Pick one\n\n ❯ Apples\n   Pears\n\n Enter to confirm · Esc to cancel\n';
    expect(parsePane(plain).trust).toBeUndefined();
  });
});

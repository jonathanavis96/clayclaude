// Release QA round 2, security track: written before its fix.
import { describe, it, expect } from 'vitest';
import { parseConfig } from '../src/config.js';
import { terminalCmd } from '../src/actions/open.js';
import { parseTmuxRef } from '../src/actions/validate.js';

describe('terminal title from a session name', () => {
  const cfg = parseConfig('hosts: [{id: local}]\naccounts: [{id: a, label: A, colour: "#fff", host: local, configDir: /x}]\n', '/home/u');
  const ref = parseTmuxRef('main:@1.%1')!;
  // The name can be Claude's AI title. wt.exe's parser reads "-p Evil" after --title as the -p (profile) option.
  it('never starts with a dash, so it cannot be read as an option', () => {
    const c = terminalCmd(cfg, cfg.hosts[0], ref, { kind: 'wsl' }, '-p Evil');
    expect(c.args[3]).toBe('--title');
    expect(c.args[4].startsWith('-')).toBe(false);
    expect(c.args[4]).toContain('p Evil');
    expect(terminalCmd(cfg, cfg.hosts[0], ref, { kind: 'wsl' }, '--').args[4]).toBe('clayclaude');
    const t = { ...cfg, terminal: { type: 'template' as const, bin: 'x', template: ['term', '-T', '{title}', '{argv}'] } };
    expect(terminalCmd(t, cfg.hosts[0], ref, { kind: 'linux' }, '--help').args[1].startsWith('-')).toBe(false);
  });
});

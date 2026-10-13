// Release QA round 2, security track: written before its fix.
import { describe, it, expect } from 'vitest';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig, tokenFileWarning } from '../src/config.js';

describe('config file holding a LAN token', () => {
  const lanYaml = `
hosts: [{id: local}]
accounts: [{id: a, label: A, colour: "#fff", host: local, configDir: /c/a}]
lan: {enabled: true, token: "abcdefghijklmnopqrstuvwxyz0123", hosts: [192.168.1.5]}
`;
  const file = (text: string, mode: number) => {
    const p = join(mkdtempSync(join(tmpdir(), 'cc-cfg-')), 'config.yaml');
    writeFileSync(p, text); chmodSync(p, mode);
    return p;
  };
  it('warns when other users can read it', () => {
    const p = file(lanYaml, 0o644);
    expect(tokenFileWarning(p, parseConfig(lanYaml))).toMatch(/chmod 600/);
    expect(tokenFileWarning(p, parseConfig(lanYaml))).not.toContain('abcdefghijklmnop');
  });
  it('is quiet when it is private, or holds no token', () => {
    expect(tokenFileWarning(file(lanYaml, 0o600), parseConfig(lanYaml))).toBeNull();
    const plain = 'hosts: [{id: local}]\naccounts: [{id: a, label: A, colour: "#fff", host: local, configDir: /c/a}]\n';
    expect(tokenFileWarning(file(plain, 0o644), parseConfig(plain))).toBeNull();
  });
});

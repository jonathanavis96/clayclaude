import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { ConfigSchema, parseConfig } from '../src/config.js';
import { USAGE } from '../src/commands/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string) => readFileSync(join(root, p), 'utf8');
const pkg = JSON.parse(read('package.json'));

/** Every key path in a zod schema, e.g. "accounts.usage.refresh". Record values are free-form, so they stop there. */
function keyPaths(t: z.ZodTypeAny, prefix = ''): string[] {
  const def = t._def as { typeName: string; innerType?: z.ZodTypeAny; schema?: z.ZodTypeAny; type?: z.ZodTypeAny };
  switch (def.typeName) {
    case 'ZodDefault': case 'ZodOptional': case 'ZodNullable': return keyPaths(def.innerType!, prefix);
    case 'ZodEffects': return keyPaths(def.schema!, prefix);
    case 'ZodArray': return keyPaths(def.type!, prefix);
    case 'ZodDiscriminatedUnion': return [...new Set((t as z.ZodDiscriminatedUnion<string, z.ZodObject<any>[]>).options.flatMap((o) => keyPaths(o, prefix)))];
    case 'ZodObject': return Object.entries((t as z.ZodObject<z.ZodRawShape>).shape).flatMap(([k, v]) => {
      const p = prefix ? `${prefix}.${k}` : k;
      return [p, ...keyPaths(v as z.ZodTypeAny, p)];
    });
    default: return [];
  }
}

describe('release packaging', () => {
  it('package.json describes the package and ships only the runtime', () => {
    expect(pkg.name).toBe('clayclaude');
    expect(pkg.version).toBe('0.1.0');
    expect(pkg.license).toBe('MIT');
    expect(pkg.description).toBeTruthy();
    expect(pkg.keywords.length).toBeGreaterThan(3);
    expect(pkg.engines.node).toBe('>=22');
    expect(pkg.bin).toEqual({ clayclaude: 'dist/cli.js' });
    expect(read('src/cli.ts').startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect([...pkg.files].sort()).toEqual(['CHANGELOG.md', 'LICENSE', 'README.md', 'dist', 'example.config.yaml', 'web/dist'].sort());
    // A pack builds from a clean dist, so a file deleted from src never ships as a stale .js.
    expect(pkg.scripts.prepack).toMatch(/clean/);
    expect(pkg.scripts.clean).toMatch(/dist/);
    expect(pkg.scripts.clean).toMatch(/web\/dist/);
  });

  it('the build puts the probe, hook and hotkey scripts next to the code that loads them', () => {
    const post = pkg.scripts.postbuild as string;
    for (const f of ['src/probe/probe.py', 'src/hooks/clayclaude-hook.py', 'src/hotkey/clayclaude-hotkey.ahk']) expect(post).toContain(f);
  });

  it('CHANGELOG.md has an entry for the current version', () => {
    expect(read('CHANGELOG.md')).toMatch(new RegExp(`^## \\[?${pkg.version.replace(/\./g, '\\.')}\\]?`, 'm'));
  });

  it('LICENSE is MIT', () => {
    expect(read('LICENSE')).toMatch(/^MIT License/);
  });
});

describe('example.config.yaml', () => {
  const text = read('example.config.yaml');

  it('loads as it stands', () => {
    const c = parseConfig(text, '/home/you');
    expect(c.accounts.length).toBeGreaterThan(0);
  });

  it('mentions every key the config accepts (set, or in a comment)', () => {
    const missing = keyPaths(ConfigSchema).filter((p) => !new RegExp(`(^|[\\s{,#])${p.split('.').pop()}:`, 'm').test(text));
    expect(missing).toEqual([]);
  });
});

describe('README.md', () => {
  const text = read('README.md');
  it('documents every command and option the CLI prints', () => {
    const words = [...USAGE.matchAll(/clayclaude (\w+)|(--[a-z]+)/g)].map((m) => m[1] ? `clayclaude ${m[1]}` : m[2]);
    expect(words.length).toBeGreaterThan(6);
    expect(words.filter((w) => !text.includes(w))).toEqual([]);
  });
  it('has the sections a release needs', () => {
    for (const h of ['Screenshots', 'Requirements', 'Install', 'Configuration', 'The tablet', 'The hotkey', 'Demo mode', 'Security', 'Troubleshooting', 'License'])
      expect(text).toMatch(new RegExp(`^## ${h}`, 'm'));
    expect(text).toContain('docs/media/board.gif');
    expect(text).toContain('refresh: false');
  });
  it('README and CHANGELOG describe the double-tap, not the removed ⛶ button', () => {
    for (const doc of [text, read('CHANGELOG.md')]) {
      expect(doc).not.toContain('⛶');
      expect(doc).toMatch(/double-tap/);
    }
  });
});

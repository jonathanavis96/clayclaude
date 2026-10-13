#!/usr/bin/env node
// tools/live-daemon.sh's guard: exits 0 only when no account in the config file would poll usage with OAuth refresh
// on. An account with no `usage` key gets the default, oauth with refresh on, so it must say `refresh: false` too.
//
//   node tools/refresh-guard.mjs <config.yaml>
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

const path = process.argv[2];
let doc;
try { doc = parse(readFileSync(path, 'utf8')); } catch (e) {
  console.error(`refresh-guard: cannot read ${path}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  process.exit(1);
}
const accounts = Array.isArray(doc?.accounts) ? doc.accounts : [];
const bad = accounts.filter((a) => {
  const u = a && typeof a === 'object' && a.usage && typeof a.usage === 'object' ? a.usage : {};
  return (u.provider ?? 'oauth') === 'oauth' && u.refresh !== false;
}).map((a) => String(a?.id ?? '?'));
if (bad.length) {
  console.error(`refresh-guard: oauth usage without refresh: false (an account with no usage key defaults to it): ${bad.join(', ')}`);
  process.exit(1);
}

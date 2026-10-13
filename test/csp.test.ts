import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { parseConfig } from '../src/config.js';
import { Guard } from '../src/security.js';
import { CHROMIUM, launch } from './helpers/browser.js';

// A Content-Security-Policy on every response: session text reaches the board's DOM (names, questions, replies), and
// although every such place escapes it, the policy is the second line: no inline or foreign script can run.
const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim().split(/\s+/)).filter((d) => d[0]).map(([k, ...v]) => [k, v]));

class FakeCollector extends EventEmitter { sessions() { return []; } }
class FakeUsage extends EventEmitter { usage() { return []; } publicShape() { return {}; } }
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

function loginPage(): { headers: Record<string, string>; body: string } {
  const out = { headers: {} as Record<string, string>, body: '' };
  const res = { writeHead: (_c: number, h: Record<string, string>) => { Object.assign(out.headers, h); }, end: (b?: string) => { out.body = b ?? ''; } };
  new Guard({ lan: { enabled: true, token: 'x'.repeat(32), hosts: ['pc.local'] } })
    .deny({ method: 'GET', headers: { accept: 'text/html' } } as any, res as any, { ok: false, status: 401, reason: 'token required', login: true });
  return out;
}

describe('Content-Security-Policy', () => {
  it('the board and every other response: scripts from the daemon only, no plugins, no base or framing', async () => {
    const web = mkdtempSync(join(tmpdir(), 'cc-csp-'));
    writeFileSync(join(web, 'index.html'), '<h1>board</h1>');
    const s = await startServer({ cfg: parseConfig('hosts: [{id: local}]\naccounts: [{id: me, label: Me, colour: "#fff", host: local, configDir: /c}]\n'),
      collector: new FakeCollector() as any, usage: new FakeUsage() as any, webRoot: web, port: 0 });
    close = s.close;
    for (const path of ['/', '/api/state', '/missing']) {
      const r = await fetch(`http://127.0.0.1:${s.port}${path}`);
      const d = directives(r.headers.get('content-security-policy') ?? '');
      expect(d.get('script-src'), path).toEqual(["'self'"]);
      expect(d.get('default-src'), path).toEqual(["'self'"]);
      expect(d.get('connect-src'), path).toEqual(["'self'"]);
      expect(d.get('object-src'), path).toEqual(["'none'"]);
      expect(d.get('base-uri'), path).toEqual(["'none'"]);
      expect(d.get('frame-ancestors'), path).toEqual(["'none'"]);
    }
  });
  it('the LAN login page allows exactly its own inline script, by hash', () => {
    const { headers, body } = loginPage();
    const script = /<script>([\s\S]*?)<\/script>/.exec(body)![1];
    const hash = `'sha256-${createHash('sha256').update(script).digest('base64')}'`;
    const d = directives(headers['content-security-policy']);
    expect(d.get('script-src')).toEqual([hash]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });
  it.skipIf(!CHROMIUM)('Chromium runs the login page\'s script under that policy', async () => {
    const browser = await launch();
    try {
      const page = await browser.newPage();
      const violations: string[] = [];
      page.on('console', (m) => { if (/Content.Security.Policy/i.test(m.text())) violations.push(m.text()); });
      const { headers, body } = loginPage();
      await page.route('http://login.test/', (r) => r.fulfill({ status: 401, headers, body }));
      await page.goto('http://login.test/');
      expect(await page.evaluate(() => typeof (document.getElementById('f') as HTMLFormElement).onsubmit)).toBe('function');
      expect(violations).toEqual([]);
    } finally { await browser.close(); }
  }, 60_000);
});

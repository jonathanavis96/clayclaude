import { userInfo } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import type { Browser } from 'playwright-core';
import { CHROMIUM_ARGS, findChromium } from '../../src/clay/chromium.js';

export const ROOT = join(import.meta.dirname, '..', '..');
/** The browser tests need a local Chromium (Playwright's cache or a system Chrome). Without one they skip, loudly. */
// The test harness points $HOME at a temp dir; Playwright's browser cache lives in the real home. Reading it is harmless.
export const CHROMIUM = findChromium(undefined, userInfo().homedir);
if (!CHROMIUM) console.warn('\n*** clay browser tests SKIPPED: no Chromium found. Run `npx playwright-core install chromium` or set CLAYCLAUDE_CHROMIUM. ***\n');

/** Vite dev server for web/ on a free port. `daemon`: a test daemon's base URL to proxy /api, /ws and /clay/ to (never the real one). */
export async function startWeb(daemon?: string): Promise<{ url: string; close(): Promise<void> }> {
  const proxy = daemon ? { '/ws': { target: daemon.replace(/^http/, 'ws'), ws: true }, '/api': daemon, '/clay/': daemon } : undefined;
  const server = await createServer({ configFile: join(ROOT, 'web', 'vite.config.ts'), server: { port: 0, host: '127.0.0.1', strictPort: false, proxy }, logLevel: 'error' });
  await server.listen();
  const addr = server.httpServer!.address() as { port: number };
  return { url: `http://127.0.0.1:${addr.port}`, close: () => server.close() };
}

export async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright-core');
  return chromium.launch({ executablePath: CHROMIUM!, args: CHROMIUM_ARGS });
}

/** Which browser the snapshots were made with matters: print it once per run. */
export function describeBrowser(): string {
  return CHROMIUM ?? 'none';
}

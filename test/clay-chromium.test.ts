import { describe, it, expect } from 'vitest';
import { findChromium } from '../src/clay/chromium.js';

describe('findChromium', () => {
  it('prefers the env var, then the newest Playwright revision, and skips the 2020-era folders', () => {
    const files = new Set([
      '/h/.cache/ms-playwright/chromium-815036/chrome-linux/chrome',
      '/h/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome',
      '/h/.cache/ms-playwright/chromium-1217/chrome-linux64/chrome',
      '/usr/bin/google-chrome',
    ]);
    const fs = { exists: (p: string) => files.has(p), list: () => ['chromium-815036', 'chromium-1217', 'chromium-1243', 'chromium_headless_shell-1243'] };
    const saved = process.env.CLAYCLAUDE_CHROMIUM;
    delete process.env.CLAYCLAUDE_CHROMIUM;
    delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    expect(findChromium(undefined, '/h', fs)).toBe('/h/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome');
    expect(findChromium(undefined, '/h', { exists: (p) => p === '/usr/bin/google-chrome', list: () => [] })).toBe('/usr/bin/google-chrome');
    expect(findChromium(undefined, '/h', { exists: () => false, list: () => [] })).toBeNull();
    process.env.CLAYCLAUDE_CHROMIUM = '/opt/c';
    expect(findChromium(undefined, '/h', { exists: (p) => p === '/opt/c', list: () => [] })).toBe('/opt/c');
    if (saved === undefined) delete process.env.CLAYCLAUDE_CHROMIUM; else process.env.CLAYCLAUDE_CHROMIUM = saved;
  });
});

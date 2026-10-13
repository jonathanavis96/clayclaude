import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const dir = new URL('../web/public/', import.meta.url);

describe('web manifest', () => {
  it('has installable PNG icons at 192 and 512 that exist', () => {
    const m = JSON.parse(readFileSync(new URL('manifest.webmanifest', dir), 'utf8'));
    for (const size of ['192x192', '512x512']) {
      const icon = m.icons.find((i: any) => i.sizes === size && i.type === 'image/png');
      expect(icon, size).toBeTruthy();
      expect(existsSync(new URL(icon.src.slice(1), dir))).toBe(true);
    }
  });
});

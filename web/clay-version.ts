import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Files that decide what a frame looks like. Changing any of them changes RENDERER_VERSION; `overrides.json` (the
 * authored overrides, spec §7.4.7) included, so sheets baked on the tablet or by the PC re-bake when it changes.
 */
export const RENDERER_FILES = ['bake.ts', 'character.ts', 'glyphs.ts', 'noise.ts', 'override-schema.ts', 'overrides.json', 'overrides.ts', 'pose.ts', 'scripts.ts', 'sheet.ts', 'stage.ts', 'timeline.ts'];

/**
 * Short content hash of the renderer files, for Vite/Vitest `define: { __CLAY_VERSION__ }`.
 * A file that does not exist yet (while the renderer is being built task by task) is skipped.
 */
export function clayVersion(clayDir = join(import.meta.dirname, 'src', 'clay')): string {
  const h = createHash('sha256');
  for (const f of RENDERER_FILES) {
    const p = join(clayDir, f);
    if (existsSync(p)) h.update(f).update('\0').update(readFileSync(p));
  }
  return h.digest('hex').slice(0, 12);
}

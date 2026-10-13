import type { Plugin } from 'vite';
import type { BuildStamp } from '../src/build-info.js';

/**
 * Bakes the build stamp into the page (`__CLAY_BUILD__`, read by web/src/build.ts) and writes the same stamp to
 * `build.json` in the bundle, which the daemon serves at /api/version. One stamp object, so the two always agree.
 * Builds only: a page served from source by the dev server is `dev` (web/src/build.ts), which never compares itself
 * with the daemon's build.json through the dev proxy (else every dev page reloaded once, then said it was old).
 */
export function buildStampPlugin(stamp: BuildStamp): Plugin {
  const json = JSON.stringify(stamp);
  return {
    name: 'clayclaude-build-stamp',
    apply: 'build',
    config: () => ({ define: { __CLAY_BUILD__: json } }),
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'build.json', source: json }); },
  };
}

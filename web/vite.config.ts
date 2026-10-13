import { join } from 'node:path';
import { defineConfig } from 'vite';
import { clayOverridesPlugin } from './clay-overrides-plugin.js';
import { clayVersion } from './clay-version.js';
import { buildStampPlugin } from './build-stamp.js';
import { makeStamp } from '../src/build-info.js';

export default defineConfig(({ command }) => ({
  root: import.meta.dirname,
  publicDir: 'public',
  // __CLAY_EDITOR__: the pose editor (spec §7.4.7) exists on the dev server only; a build drops it as dead code
  define: { __CLAY_VERSION__: JSON.stringify(clayVersion()), __CLAY_EDITOR__: JSON.stringify(command === 'serve') },
  plugins: [clayOverridesPlugin(), buildStampPlugin(makeStamp(join(import.meta.dirname, '..')))],
  worker: { format: 'es' },
  build: {
    outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 800,
    rollupOptions: { input: { main: `${import.meta.dirname}/index.html`, bake: `${import.meta.dirname}/clay-bake.html`, lab: `${import.meta.dirname}/clay-lab.html` } },
  },
  // Dev only: proxy to a daemon on 8420. Never under Vitest, so no test can reach a real daemon.
  server: process.env.VITEST ? {} : { proxy: { '/ws': { target: 'ws://127.0.0.1:8420', ws: true }, '/api': 'http://127.0.0.1:8420', '/clay/': 'http://127.0.0.1:8420' } },
}));

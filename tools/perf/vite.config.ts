import { defineConfig } from 'vite';
import { clayVersion } from '../../web/clay-version.js';

export default defineConfig({
  root: import.meta.dirname,
  define: { __CLAY_VERSION__: JSON.stringify(clayVersion()) },
  build: { outDir: 'dist', emptyOutDir: true },
  worker: { format: 'es' },
});

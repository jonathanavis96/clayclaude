import { defineConfig } from 'vitest/config';
import { clayVersion } from './web/clay-version.js';

export default defineConfig({
  define: { __CLAY_VERSION__: JSON.stringify(clayVersion()) },
  test: { include: ['test/**/*.test.ts'], setupFiles: ['test/setup/safety.ts'], testTimeout: 15000 },
});

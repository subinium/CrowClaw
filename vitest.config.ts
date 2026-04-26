import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/sandbox': path.resolve(__dirname, 'tests/stubs/cloudflare-sandbox.ts')
    }
  },
  // Mirror Wrangler's `define` so `__CROWCLAW_TEST_MODE__` / `__CROWCLAW_VERSION__`
  // resolve in unit tests. Production CF bundles set these via wrangler.jsonc.
  define: {
    __CROWCLAW_TEST_MODE__: 'true',
    __CROWCLAW_VERSION__: '"0.4.3-test"'
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
});

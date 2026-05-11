import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// #164: read version from package.json so __CROWCLAW_VERSION__ stays in sync
// with releases without manual edits to vitest.config.
const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as { version: string };

export default defineConfig({
  resolve: {
    alias: {
      '@cloudflare/sandbox': path.resolve(__dirname, 'tests/stubs/cloudflare-sandbox.ts'),
      // v0.9.0 worktree: route the packages we edit to source so vitest sees
      // worktree changes without a separate `tsc -b` step.
      '@crowclaw/tools': path.resolve(__dirname, 'packages/tools/src/index.ts'),
      '@crowclaw/core': path.resolve(__dirname, 'packages/core/src/index.ts'),
    }
  },
  // Mirror Wrangler's `define` so `__CROWCLAW_TEST_MODE__` / `__CROWCLAW_VERSION__`
  // resolve in unit tests. Production CF bundles set these via wrangler.jsonc.
  define: {
    __CROWCLAW_TEST_MODE__: 'true',
    __CROWCLAW_VERSION__: JSON.stringify(`${pkg.version}-test`)
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // #161: cap test/hook duration so a single hung WS reconnect or DO state
    // round-trip cannot stall the entire 175+ file suite indefinitely.
    testTimeout: 15_000,
    hookTimeout: 10_000,
    teardownTimeout: 10_000
  }
});

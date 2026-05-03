import { describe, expect, it } from 'vitest';
import { execSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = join(dirname(__filename), '..');

interface PackageManifest {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readManifest(path: string): Promise<PackageManifest> {
  const raw = await readFile(path, 'utf-8');
  return JSON.parse(raw) as PackageManifest;
}

describe('version drift (#254)', () => {
  it('sync-versions.mjs is idempotent on the current tree', () => {
    // If the working tree already drifts, this test fails fast with a clear message.
    // CI pairs this with `git diff --exit-code` to fail PRs that introduce drift.
    const output = execSync('node scripts/sync-versions.mjs', {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    expect(output).toContain('All packages already in sync');
  });

  it('all workspace package.json versions match root', async () => {
    const root = await readManifest(join(repoRoot, 'package.json'));
    const expected = root.version;
    expect(expected, 'root package.json must declare a version').toBeTruthy();

    // Read each workspace package directly so we don't depend on a pre-built lockfile.
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(join(repoRoot, 'packages'), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const manifestPath = join(repoRoot, 'packages', entry.name, 'package.json');
      let pkg: PackageManifest;
      try {
        pkg = await readManifest(manifestPath);
      } catch {
        continue;
      }
      expect(
        pkg.version,
        `${pkg.name ?? entry.name} version must match root ${expected ?? 'unknown'}`,
      ).toBe(expected);
    }
  });

  it('wrangler.jsonc __CROWCLAW_VERSION__ matches root package.json', async () => {
    const root = await readManifest(join(repoRoot, 'package.json'));
    const expected = root.version;
    expect(expected).toBeTruthy();

    const wrangler = await readFile(join(repoRoot, 'wrangler.jsonc'), 'utf-8');
    const match = wrangler.match(/"__CROWCLAW_VERSION__"\s*:\s*"\\?"([^"\\]+)\\?""/);
    expect(match, '__CROWCLAW_VERSION__ define must exist in wrangler.jsonc').toBeTruthy();
    expect(match?.[1]).toBe(expected);
  });
});

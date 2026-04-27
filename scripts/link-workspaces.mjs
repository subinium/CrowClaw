import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const packagesDir = path.join(repoRoot, 'packages');
const nodeModulesDir = path.join(repoRoot, 'node_modules');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file) {
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function safeRemove(target) {
  await fs.rm(target, { recursive: true, force: true });
}

// #136: validate package name segment to refuse anything that could resolve
// outside the scope directory or contain shell-interpretable characters.
// `@crowclaw/<segment>` segments are owned in-repo, so they should always
// match `[a-z0-9_-]+`; reject otherwise rather than silently symlinking.
const PACKAGE_NAME_RE = /^[a-z0-9_-]+$/;

async function main() {
  await ensureDir(nodeModulesDir);
  const scopeDir = path.join(nodeModulesDir, '@crowclaw');
  await ensureDir(scopeDir);

  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  const linked = [];
  const skipped = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const packageDir = path.join(packagesDir, entry.name);
    const packageJsonPath = path.join(packageDir, 'package.json');
    try {
      const pkg = await readJson(packageJsonPath);
      if (typeof pkg.name !== 'string' || !pkg.name.startsWith('@crowclaw/')) continue;
      const packageName = pkg.name.split('/')[1];
      if (!packageName || !PACKAGE_NAME_RE.test(packageName)) {
        skipped.push(pkg.name);
        continue;
      }
      const linkPath = path.join(scopeDir, packageName);
      await safeRemove(linkPath);
      const relativeTarget = path.relative(scopeDir, packageDir);
      await fs.symlink(relativeTarget, linkPath, 'dir');
      linked.push(pkg.name);
    } catch {
      // ignore folders without package.json
    }
  }

  console.log(`Linked ${linked.length} CrowClaw workspaces.`);
  if (skipped.length > 0) {
    console.warn(
      `Skipped ${skipped.length} package(s) with invalid name segment: ${skipped.join(', ')}`
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

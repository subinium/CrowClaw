import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function main() {
  const rootPkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf-8'));
  const version = rootPkg.version;
  console.log(`Syncing all packages to v${version}`);

  const packagesDir = path.join(repoRoot, 'packages');
  const entries = await fs.readdir(packagesDir, { withFileTypes: true });
  let updated = 0;

  // Collect all workspace package names first
  const workspaceNames = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(packagesDir, entry.name, 'package.json');
    try {
      const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      if (pkg.name) workspaceNames.add(pkg.name);
    } catch { continue; }
  }

  const wranglerPath = path.join(repoRoot, 'wrangler.jsonc');
  try {
    const raw = await fs.readFile(wranglerPath, 'utf-8');
    const next = raw.replace(
      /("__CROWCLAW_VERSION__"\s*:\s*)"\\?"[^"]+"\\?"/,
      `$1"\\"${version}\\""`
    );
    if (next !== raw) {
      await fs.writeFile(wranglerPath, next, 'utf-8');
      console.log(`  Updated wrangler.jsonc __CROWCLAW_VERSION__ -> ${version}`);
      updated++;
    }
  } catch {
    // Wrangler is optional for non-Cloudflare consumers.
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const pkgPath = path.join(packagesDir, entry.name, 'package.json');
    try {
      const raw = await fs.readFile(pkgPath, 'utf-8');
      const pkg = JSON.parse(raw);
      let changed = false;

      if (pkg.version !== version) {
        pkg.version = version;
        changed = true;
      }

      // Also sync inter-workspace dependency versions
      for (const depField of ['dependencies', 'devDependencies', 'peerDependencies']) {
        const deps = pkg[depField];
        if (!deps) continue;
        for (const [name, ver] of Object.entries(deps)) {
          if (workspaceNames.has(name) && ver !== version) {
            deps[name] = version;
            changed = true;
          }
        }
      }

      if (changed) {
        await fs.writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
        console.log(`  Updated ${pkg.name || entry.name} -> ${version}`);
        updated++;
      }
    } catch { continue; }
  }

  if (updated === 0) {
    console.log('All packages already in sync.');
  } else {
    console.log(`Updated ${updated} package(s).`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });

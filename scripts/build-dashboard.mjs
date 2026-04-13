import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const webSrc = path.resolve(repoRoot, 'packages', 'web', 'src');
const uiDir = path.resolve(repoRoot, 'packages', 'web', 'ui');
const viteConfig = path.join(uiDir, 'vite.config.mjs');
const viteBin = path.resolve(repoRoot, 'node_modules', '.bin', 'vite');

async function main() {
  // Build the Lit SPA via Vite (produces single-file HTML)
  console.log('Building Lit UI with Vite...');
  execSync(`${viteBin} build --config ${viteConfig}`, {
    cwd: repoRoot,
    stdio: 'inherit',
  });

  // Read the built single-file HTML
  const singleFileHtml = await fs.readFile(
    path.join(uiDir, 'dist', 'index.html'),
    'utf-8',
  );

  // JSON.stringify handles all escaping automatically
  const output =
    '// AUTO-GENERATED — do not edit directly.\n' +
    '// Built from packages/web/ui/ via Vite + vite-plugin-singlefile.\n' +
    '// Rebuild with: node scripts/build-dashboard.mjs\n' +
    '\n' +
    'export const DASHBOARD_HTML = ' + JSON.stringify(singleFileHtml) + ';\n';

  await fs.writeFile(path.join(webSrc, 'generated.ts'), output, 'utf-8');
  console.log('Dashboard built: packages/web/src/generated.ts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

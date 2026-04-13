import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(__dirname, '..', 'packages', 'web', 'src');

async function main() {
  const [html, css, js] = await Promise.all([
    fs.readFile(path.join(webSrc, 'dashboard.html'), 'utf-8'),
    fs.readFile(path.join(webSrc, 'dashboard.css'), 'utf-8'),
    fs.readFile(path.join(webSrc, 'dashboard.js'), 'utf-8'),
  ]);

  const combined = html
    .replace('%%CSS%%', css)
    .replace('%%JS%%', js);

  // JSON.stringify handles all escaping (backslashes, quotes, newlines)
  // automatically — safer than manual template literal escaping.
  const output =
    '// AUTO-GENERATED — do not edit directly.\n' +
    '// Edit dashboard.html, dashboard.css, and dashboard.js instead.\n' +
    '// Rebuild with: node scripts/build-dashboard.mjs\n' +
    '\n' +
    'export const DASHBOARD_HTML = ' + JSON.stringify(combined) + ';\n';

  await fs.writeFile(path.join(webSrc, 'generated.ts'), output, 'utf-8');
  console.log('Dashboard built: packages/web/src/generated.ts');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

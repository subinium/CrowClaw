import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function extractRoutes(source) {
  const routes = new Set();
  const literal = /url\.pathname\s*(?:===|!==)\s*['"]([^'"]+)['"]/g;
  const startsWith = /url\.pathname\.startsWith\(['"]([^'"]+)['"]\)/g;
  const endsWith = /url\.pathname\.endsWith\(['"]([^'"]+)['"]\)/g;
  const routePathLiteral = /['"]((?:\/api|\/health|\/readyz|\/ws|\/\.)[^'"]*)['"]/g;
  for (const regex of [literal, startsWith, endsWith]) {
    for (const match of source.matchAll(regex)) {
      routes.add(match[1]);
    }
  }
  for (const match of source.matchAll(routePathLiteral)) {
    routes.add(match[1]);
  }
  return [...routes].filter((route) => route !== '/api/' && route !== '/api').sort();
}

function extractRoutePathMap(source) {
  const map = new Map();
  const stack = [];
  for (const rawLine of source.split('\n')) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    const objectMatch = line.match(/^([A-Za-z0-9_]+):\s*\{\s*$/);
    if (objectMatch) {
      stack.push(objectMatch[1]);
      continue;
    }
    const valueMatch = line.match(/^([A-Za-z0-9_]+):\s*['"]([^'"]+)['"]/);
    if (valueMatch) {
      map.set([...stack, valueMatch[1]].join('.'), valueMatch[2]);
      continue;
    }
    if (/^}\s*,?/.test(line) && stack.length > 0) {
      stack.pop();
    }
  }
  return map;
}

function extractUsedRoutePathValues(handlerSource, routePathSource) {
  const map = extractRoutePathMap(routePathSource);
  const values = new Set();
  for (const match of handlerSource.matchAll(/routePaths\.([A-Za-z0-9_.]+)/g)) {
    const value = map.get(match[1]);
    if (value) values.add(value);
  }
  return values;
}

function extractCoverageMatchers(source) {
  const exact = new Set();
  const prefixes = new Set();
  const suffixes = new Set();
  const unsupported = new Set();
  const exactRegex = /url\.pathname\s*(?:===|!==)\s*['"]([^'"]+)['"]/g;
  const startsWithRegex = /url\.pathname\.startsWith\(['"]([^'"]+)['"]\)/g;
  const endsWithRegex = /url\.pathname\.endsWith\(['"]([^'"]+)['"]\)/g;
  const unsupportedRegex = /unsupportedOnWorkers\(url\.pathname\)/;
  const unsupportedSetRegex = /WORKER_UNSUPPORTED_ROUTES\s*=\s*new Set\(\[([\s\S]*?)\]\)/m;
  for (const match of source.matchAll(exactRegex)) exact.add(match[1]);
  const unsupportedSet = source.match(unsupportedSetRegex)?.[1] ?? '';
  for (const match of unsupportedSet.matchAll(/['"]([^'"]+)['"]/g)) unsupported.add(match[1]);
  for (const match of source.matchAll(startsWithRegex)) {
    const prefix = match[1];
    if (prefix === '/api/' || prefix === '/api' || prefix === '/ws') continue;
    prefixes.add(prefix);
  }
  for (const match of source.matchAll(endsWithRegex)) suffixes.add(match[1]);
  if (unsupportedRegex.test(source)) {
    prefixes.add('/api/terminal/');
    prefixes.add('/api/code/bridge/');
  }
  return { exact, prefixes, suffixes, unsupported };
}

function mergeCoverage(a, b) {
  return {
    exact: new Set([...a.exact, ...b.exact]),
    prefixes: new Set([...a.prefixes, ...b.prefixes]),
    suffixes: new Set([...a.suffixes, ...b.suffixes]),
    unsupported: new Set([...a.unsupported, ...b.unsupported]),
  };
}

function routePatternPrefix(route) {
  const marker = route.indexOf('/:');
  return marker === -1 ? route : route.slice(0, marker + 1);
}

const explicitWorkerUnsupported = [
  '/api/acp/',
  '/api/code/bridge/',
  '/api/config',
  '/api/events',
  '/api/mcp/server/',
  '/api/metrics',
  '/api/structured-output',
  '/api/terminal/',
  '/ws',
];

function classifyRoute(route, workerMatchers) {
  const prefix = routePatternPrefix(route);
  if (workerMatchers.unsupported.has(route)) return 'unsupported_on_workers';
  if (workerMatchers.exact.has(route)) return 'covered';
  if ([...workerMatchers.prefixes].some((candidate) => route.startsWith(candidate) || prefix.startsWith(candidate))) return 'covered';
  if ([...workerMatchers.suffixes].some((candidate) => route.endsWith(candidate))) return 'covered';
  if (explicitWorkerUnsupported.some((candidate) => route === candidate || route.startsWith(candidate))) {
    return 'unsupported_on_workers';
  }
  return 'missing';
}

async function main() {
  const check = process.argv.includes('--check');
  const nodeSource = await fs.readFile(path.join(repoRoot, 'packages/runtime-node/src/route-handlers.ts'), 'utf-8');
  const nodeRoutePathSource = await fs.readFile(path.join(repoRoot, 'packages/runtime-node/src/route-paths.ts'), 'utf-8');
  const workerSource = await fs.readFile(path.join(repoRoot, 'packages/runtime-cloudflare/src/index.ts'), 'utf-8');
  const durableObjectSource = await fs.readFile(path.join(repoRoot, 'packages/runtime-cloudflare/src/agent-do.ts'), 'utf-8');

  const nodeRoutes = [...new Set([
    ...extractRoutes(nodeSource),
    ...extractUsedRoutePathValues(nodeSource, nodeRoutePathSource),
  ])].filter((route) => !route.includes('${') && route !== '/api/agent/' && route !== '/api/toolset/').sort();
  const workerMatchers = mergeCoverage(
    extractCoverageMatchers(workerSource),
    extractCoverageMatchers(durableObjectSource)
  );
  const rows = nodeRoutes
    .filter((route) => route.startsWith('/api/') || route.startsWith('/.') || route.startsWith('/health'))
    .map((route) => ({
      route,
      cloudflare: classifyRoute(route, workerMatchers),
    }));

  const markdown = [
    '# Cloudflare Route Parity',
    '',
    'Generated by `node scripts/audit-routes.mjs` from `runtime-node/src/route-handlers.ts`, used `runtime-node/src/route-paths.ts` entries, and the Cloudflare worker/DO route tables.',
    '',
    '| Node route | Cloudflare coverage |',
    '| --- | --- |',
    ...rows.map((row) => `| \`${row.route}\` | ${row.cloudflare} |`),
    '',
  ].join('\n');

  const outputPath = path.join(repoRoot, 'docs/cloudflare-route-parity.md');
  if (check) {
    const existing = await fs.readFile(outputPath, 'utf-8');
    if (existing !== markdown) {
      console.error('docs/cloudflare-route-parity.md is stale. Run `node scripts/audit-routes.mjs`.');
      process.exit(1);
    }
    const missing = rows.filter((row) => row.cloudflare === 'missing');
    if (missing.length > 0) {
      console.error('Cloudflare route parity has missing routes:');
      for (const row of missing) console.error(`- ${row.route}`);
      process.exit(1);
    }
  } else {
    await fs.writeFile(outputPath, markdown, 'utf-8');
  }
  console.log(markdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

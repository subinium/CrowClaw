/**
 * Local Node.js HTTP server for CrowClaw runtime-node.
 * Bypasses @cloudflare/sandbox ESM issue by mocking it.
 * Usage: CROWCLAW_DASHBOARD_TOKEN=your-token node scripts/serve-local.mjs
 */

import { createRequire } from 'node:module';
import { register } from 'node:module';
import http from 'node:http';

// Mock @cloudflare/sandbox before anything imports it
const require = createRequire(import.meta.url);

// Register a loader that intercepts @cloudflare/sandbox
const originalResolve = import.meta.resolve;

// Pre-set the mock in globalThis so dynamic imports pick it up
globalThis.__cloudflare_sandbox_mock = {
  Sandbox: class Sandbox {},
  proxyToSandbox: async () => null,
  getSandbox: () => ({ exec: () => {} }),
};

// Patch require to intercept cloudflare modules
const Module = require('node:module');
const origLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === '@cloudflare/sandbox' || request.includes('@cloudflare/sandbox')) {
    return globalThis.__cloudflare_sandbox_mock;
  }
  if (request === '@cloudflare/containers' || request.includes('@cloudflare/containers')) {
    return { Container: class Container {} };
  }
  return origLoad.apply(this, arguments);
};

// Register ESM loader hook to also mock @cloudflare/* for ESM imports
register('./mock-cloudflare-loader.mjs', import.meta.url);

// Now import the runtime
const { createNodeRuntime } = await import('../packages/runtime-node/dist/index.js');

// Set sensible defaults for OpenRouter if key is present but model/base are empty
if (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_MODEL) {
  process.env.OPENROUTER_MODEL = 'openai/gpt-4o-mini';
}
if (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_BASE_URL) {
  process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
}

// Read version from package.json instead of hardcoding
import { readFile as readFileSync } from 'node:fs/promises';
const pkg = JSON.parse(await readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const port = parseInt(process.env.PORT ?? '3333', 10);
const runtime = createNodeRuntime({
  workingDirectory: process.cwd(),
  version: pkg.version,
});

// Static file serving for /docs/* assets (logo, hero, etc.)
import { readFile } from 'node:fs/promises';
import { join, extname } from 'node:path';

const MIME_TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.gif': 'image/gif',
  '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json',
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${port}`);

    // Serve static files from /docs/
    if (url.pathname.startsWith('/docs/') && req.method === 'GET') {
      const safePath = url.pathname.replace(/\.\./g, '');
      const filePath = join(process.cwd(), safePath);
      try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, { 'content-type': MIME_TYPES[ext] ?? 'application/octet-stream', 'cache-control': 'public, max-age=3600' });
        res.end(data);
        return;
      } catch {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
    }

    const headers = {};
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      headers[req.rawHeaders[i].toLowerCase()] = req.rawHeaders[i + 1];
    }
    let body = '';
    for await (const chunk of req) body += chunk;

    const request = new Request(url.href, {
      method: req.method,
      headers,
      ...(body && req.method !== 'GET' && req.method !== 'HEAD' ? { body } : {}),
    });

    const response = await runtime.fetch(request);
    const respHeaders = Object.fromEntries(response.headers.entries());
    res.writeHead(response.status, respHeaders);
    const text = await response.text();
    res.end(text);
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

// v0.7.1: WebSocket upgrade. The runtime's /ws fetch path uses
// WebSocketPair (Workers/Bun) which is unavailable on Node, so we
// terminate the upgrade here with the `ws` library and hand the resulting
// WHATWG-shaped socket to runtime.wsManager.addConnection().
import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, `http://localhost:${port}`);
  if (pathname !== '/ws') {
    socket.destroy();
    return;
  }
  // Localhost open-access mirrors the dev-mode auth carve-out: when no
  // CROWCLAW_DASHBOARD_TOKEN is set we accept the connection unauthenticated
  // so the dashboard can subscribe to live events from a fresh git clone.
  // Tokenless connections still pass authenticated=false so the broadcast
  // gate enforces per-connection scopes downstream.
  const dashToken = process.env.CROWCLAW_DASHBOARD_TOKEN;
  let authenticated = !dashToken;
  if (dashToken) {
    const auth = req.headers['authorization'];
    if (typeof auth === 'string' && auth === `Bearer ${dashToken}`) {
      authenticated = true;
    }
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    runtime.wsManager.addConnection(ws, authenticated);
  });
});

server.listen(port, () => {
  console.log(`CrowClaw v${pkg.version} running at http://localhost:${port}`);
  console.log(`Dashboard token: ${process.env.CROWCLAW_DASHBOARD_TOKEN ? 'SET' : 'NOT SET (open access)'}`);
  console.log(`Working directory: ${process.cwd()}`);
  console.log('');
  console.log('Try:');
  console.log(`  curl http://localhost:${port}/health`);
  console.log(`  curl http://localhost:${port}/`);
  if (process.env.CROWCLAW_DASHBOARD_TOKEN) {
    console.log(`  curl -H "Authorization: Bearer ${process.env.CROWCLAW_DASHBOARD_TOKEN}" http://localhost:${port}/api/tools`);
  }
});

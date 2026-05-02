import { Sandbox, proxyToSandbox } from '@cloudflare/sandbox';
import {
  buildDiscordDispatch,
  buildDiscordEditPayload,
  buildDiscordWebhookEditUrl,
  buildDiscordWebhookSendUrl,
  buildGatewaySessionKey,
  buildGatewayIdempotencyKey,
  buildEmailDispatch,
  buildSignalDispatch,
  buildWhatsAppDispatch,
  buildSlackDispatch,
  buildSlackEditPayload,
  buildSlackEditUrl,
  buildSlackSendPayload,
  buildSlackSendUrl,
  buildTelegramDispatch,
  buildTelegramEditPayload,
  buildTelegramEditUrl,
  buildTelegramSendPayload,
  buildTelegramSendUrl,
  normalizeGenericWebhook,
  normalizeEmailWebhook,
  normalizeSlackWebhook,
  normalizeSignalWebhook,
  normalizeTelegramWebhook,
  normalizeWhatsAppWebhook,
  verifySlackSignature,
  type TelegramUpdate,
} from '@crowclaw/gateway';
import type { RuntimeEnv } from './env';
import { AgentSessionDurableObject } from './agent-do';

export { AgentSessionDurableObject, Sandbox };

/**
 * Build-time flag. Wrangler replaces this with the literal `false` for production
 * worker bundles via `wrangler.jsonc` `define`; vitest replaces it with `true`.
 * Replaced the prior `process.env.VITEST` runtime check (#25) — runtime checks
 * couple production behavior to test-environment shape and fail open if any
 * polyfill ever exposes a partial `process` shim.
 */
declare const __CROWCLAW_TEST_MODE__: boolean;

/** Hex string -> Uint8Array. Used by Discord Ed25519 signature verification. */
function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * Verify a Discord webhook signature using Ed25519. Mirrors the Node runtime's
 * `verifyDiscordWebhookSignature` (`packages/runtime-node/src/index.ts:985-1013`).
 * Closes #24 — prior CF handler accepted any payload, allowing forged Discord
 * interactions against the operator's LLM keys.
 */
async function verifyDiscordWebhookSignature(
  request: Request,
  publicKey: string,
  body: string
): Promise<boolean> {
  const signature = request.headers.get('x-signature-ed25519');
  const timestamp = request.headers.get('x-signature-timestamp');
  if (!signature || !timestamp) return false;

  try {
    const key = await crypto.subtle.importKey(
      'raw',
      hexToUint8Array(publicKey).buffer as ArrayBuffer,
      { name: 'Ed25519', namedCurve: 'Ed25519' } as EcKeyImportParams,
      false,
      ['verify']
    );
    const encoder = new TextEncoder();
    const message = encoder.encode(timestamp + body);
    return await crypto.subtle.verify(
      'Ed25519',
      key,
      hexToUint8Array(signature).buffer as ArrayBuffer,
      message
    );
  } catch {
    return false;
  }
}

function getSpecialSessionStub(env: RuntimeEnv, name: string) {
  const durableId = env.AGENT_SESSIONS.idFromName(name);
  return env.AGENT_SESSIONS.get(durableId);
}

function unsupportedOnWorkers(path: string): Response {
  return Response.json(
    { ok: false, error: 'unsupported_on_workers', path },
    { status: 501 }
  );
}

// Public Node routes that require a host process, mutable local config, or
// provider credentials managed outside the Worker environment. Keep this table
// in sync with scripts/audit-routes.mjs so parity drift is explicit instead of
// silently falling through to 404.
const WORKER_UNSUPPORTED_ROUTES = new Set([
  '/api/acp/info',
  '/api/acp/prompt',
  '/api/acp/request',
  '/api/acp/sessions',
  '/api/agent/preset',
  '/api/clarify',
  '/api/config',
  '/api/config-presets',
  '/api/config/agent',
  '/api/config/provider',
  '/api/config/provider/test',
  '/api/context',
  '/api/events',
  '/api/feedback',
  '/api/gateway/activity',
  '/api/gateway/pairing/approve',
  '/api/gateway/pairing/reject',
  '/api/gateway/pairings',
  '/api/gateway/telegram/webhook',
  '/api/mcp/catalog',
  '/api/mcp/connect',
  '/api/mcp/disconnect',
  '/api/mcp/presets/status',
  '/api/mcp/server/request',
  '/api/mcp/server/tools',
  '/api/mcp/servers',
  '/api/mcp/servers/install',
  '/api/mcp/verify',
  '/api/metrics',
  '/api/persona/active',
  '/api/persona/switch',
  '/api/personas',
  '/api/plugins/catalog',
  '/api/plugins/configure',
  '/api/plugins/install',
  '/api/plugins/uninstall',
  '/api/providers/failover-preview',
  '/api/providers/failover-simulate',
  '/api/providers/models',
  '/api/providers/plan',
  '/api/providers/pool',
  '/api/providers/route',
  '/api/send-message',
  '/api/skills/import',
  '/api/skills/install',
  '/api/skills/preview',
  '/api/structured-output',
  '/api/system/preflight',
  '/api/system/release-check',
  '/api/system/version',
  '/api/todo',
  '/api/toolset/select',
  '/api/user/profile',
]);

function maybeUnsupportedOnWorkers(path: string): Response | null {
  return WORKER_UNSUPPORTED_ROUTES.has(path) ? unsupportedOnWorkers(path) : null;
}

async function forwardToSystemSession(request: Request, env: RuntimeEnv, url: URL, internalPath: string): Promise<Response> {
  const stub = getSpecialSessionStub(env, '__system__');
  const init: RequestInit = {
    method: request.method,
    headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.text();
  }
  return stub.fetch(new Request(`https://internal/session${internalPath}${url.search}`, init));
}

/**
 * Derive the cookie-safe token from CROWCLAW_DASHBOARD_TOKEN using HMAC-SHA256.
 * Mirrors the Node runtime so `/api/auth/verify` semantics are consistent
 * regardless of deployment target.
 */
async function deriveCookieToken(dashToken: string): Promise<string> {
  const keyData = new TextEncoder().encode(dashToken);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('crowclaw:cookie'));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function parseAuthCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const m = cookieHeader.match(/(?:^|;\s*)crowclaw_auth=([^;]+)/);
  return m ? m[1]! : null;
}

/**
 * Auth gate for protected surfaces. Prior to v0.4.0 the Cloudflare runtime had
 * ZERO authentication — any caller with the worker URL could run agent prompts,
 * fetch URLs (SSRF amplification), and exfiltrate session data against the
 * operator's LLM keys. This restores the same fail-closed semantics as Node:
 *   - /health, /webhooks/*, /api/auth/* are public
 *   - everything else requires CROWCLAW_DASHBOARD_TOKEN to be configured and
 *     the caller to present it as Bearer or the derived cookie.
 * Returns a Response on reject, or null to continue.
 */
async function enforceDashboardAuth(request: Request, env: RuntimeEnv, url: URL): Promise<Response | null> {
  // Public surfaces
  if (url.pathname === '/health') return null;
  if (url.pathname.startsWith('/webhooks/')) return null;
  if (url.pathname.startsWith('/api/auth/')) return null;
  // Only /api/* and /ws are protected; other paths (dashboard HTML, static) fall through.
  if (!url.pathname.startsWith('/api/') && url.pathname !== '/ws') return null;

  // Vitest bypass replaced with build-time flag (#25). Wrangler replaces this
  // with the literal `false` for production bundles, so esbuild dead-code-
  // eliminates the bypass before deploy. Vitest sets it to `true`.
  if (__CROWCLAW_TEST_MODE__) return null;

  const dashToken = env.CROWCLAW_DASHBOARD_TOKEN;
  if (!dashToken) {
    return Response.json(
      { error: 'CROWCLAW_DASHBOARD_TOKEN is required on Cloudflare deployments.' },
      { status: 500 }
    );
  }

  const bearer = request.headers.get('authorization');
  if (bearer?.startsWith('Bearer ')) {
    if (timingSafeStringEqual(bearer.slice(7).trim(), dashToken)) return null;
  }
  const cookieToken = parseAuthCookie(request.headers.get('cookie'));
  if (cookieToken) {
    const expected = await deriveCookieToken(dashToken);
    if (timingSafeStringEqual(cookieToken, expected)) return null;
  }
  return Response.json({ error: 'Unauthorized' }, { status: 401 });
}

export default {
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const sandboxNamespace = env.Sandbox;
    if (sandboxNamespace) {
      const proxyResponse = await proxyToSandbox(request, { Sandbox: sandboxNamespace });
      if (proxyResponse) {
        return proxyResponse;
      }
    }

    const url = new URL(request.url);

    // Public auth endpoints — process before the gate so verify/check/logout work.
    if (request.method === 'POST' && url.pathname === '/api/auth/verify') {
      const dashToken = env.CROWCLAW_DASHBOARD_TOKEN;
      if (!dashToken) {
        return Response.json({ error: 'CROWCLAW_DASHBOARD_TOKEN is required' }, { status: 500 });
      }
      const body = (await request.json().catch(() => ({}))) as { token?: string };
      if (!body.token || !timingSafeStringEqual(body.token, dashToken)) {
        return Response.json({ ok: false }, { status: 200 });
      }
      const cookie = await deriveCookieToken(dashToken);
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('Set-Cookie', `crowclaw_auth=${cookie}; HttpOnly; SameSite=Strict; Path=/; Secure`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    if (request.method === 'GET' && url.pathname === '/api/auth/check') {
      const dashToken = env.CROWCLAW_DASHBOARD_TOKEN;
      if (!dashToken) return Response.json({ ok: false, reason: 'no-token-configured' });
      const cookieToken = parseAuthCookie(request.headers.get('cookie'));
      if (!cookieToken) return Response.json({ ok: false });
      const expected = await deriveCookieToken(dashToken);
      return Response.json({ ok: timingSafeStringEqual(cookieToken, expected) });
    }

    if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
      const headers = new Headers({ 'content-type': 'application/json' });
      headers.set('Set-Cookie', `crowclaw_auth=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers });
    }

    // Fail-closed auth gate on every /api/* and /ws surface. Webhooks keep
    // their platform-specific signature checks.
    const authReject = await enforceDashboardAuth(request, env, url);
    if (authReject) return authReject;

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'crowclaw', runtime: 'cloudflare' });
    }

    if (request.method === 'GET' && url.pathname === '/healthz') {
      return Response.json({ ok: true, service: 'crowclaw', runtime: 'cloudflare' });
    }

    if (request.method === 'GET' && url.pathname === '/readyz') {
      return Response.json({ ok: true, service: 'crowclaw', runtime: 'cloudflare' });
    }

    if (request.method === 'GET' && url.pathname === '/.well-known/agent-skills') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/agent-skills', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/capabilities') {
      return Response.json({
        provider: {
          status: env.OPENAI_API_KEY ? 'live' : 'disconnected',
          detail: env.OPENAI_API_KEY ? (env.OPENAI_MODEL ?? 'gpt-4.1-mini') : 'OPENAI_API_KEY is not configured',
        },
        chat: { status: env.OPENAI_API_KEY ? 'live' : 'disconnected' },
        streaming: { status: 'live' },
        tools: { status: 'live', detail: 'Worker-safe tools' },
        memory: { status: 'live', detail: 'D1-backed' },
        skills: { status: 'live' },
        scheduler: { status: 'live' },
        gateway: { status: 'live' },
        mcp: { status: 'simulated', detail: 'Worker-safe MCP subset' },
        browser: { status: 'live' },
        workspace: { status: 'live', detail: 'Durable Object workspace' },
      });
    }

    if (request.method === 'GET' && url.pathname === '/api/tools') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/tools', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (url.pathname.startsWith('/api/terminal/')) {
      return unsupportedOnWorkers(url.pathname);
    }

    if (/^\/api\/code\/bridge\/(spawn|terminate|capabilities|process|ping|heartbeat)$/.test(url.pathname)) {
      return unsupportedOnWorkers(url.pathname);
    }

    if (request.method === 'GET' && url.pathname === '/api/system/status') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/system/status', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/diagnostics') {
      return forwardToSystemSession(request, env, url, '/diagnostics');
    }

    if (request.method === 'GET' && url.pathname === '/api/config/snapshot') {
      return forwardToSystemSession(request, env, url, '/config/snapshot');
    }

    if (request.method === 'GET' && url.pathname === '/api/config/schema') {
      return forwardToSystemSession(request, env, url, '/config/schema');
    }

    if (request.method === 'POST' && url.pathname === '/api/config/validate') {
      return forwardToSystemSession(request, env, url, '/config/validate');
    }

    if (request.method === 'POST' && url.pathname === '/api/config/diff') {
      return forwardToSystemSession(request, env, url, '/config/diff');
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/config/remote-access') {
      return forwardToSystemSession(request, env, url, '/config/remote-access');
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/memory/snapshot') {
      return forwardToSystemSession(request, env, url, '/memory/snapshot');
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/usage') {
      return forwardToSystemSession(request, env, url, '/usage');
    }

    if (request.method === 'POST' && url.pathname === '/api/usage/reset') {
      return forwardToSystemSession(request, env, url, '/usage/reset');
    }

    if (url.pathname.startsWith('/api/security/')) {
      return forwardToSystemSession(request, env, url, url.pathname.replace('/api', ''));
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname === '/api/providers/config') {
      return forwardToSystemSession(request, env, url, '/providers/config');
    }

    if (request.method === 'POST' && url.pathname === '/api/providers/test') {
      return forwardToSystemSession(request, env, url, '/providers/test');
    }

    if (request.method === 'GET' && url.pathname === '/api/skills') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/skills', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/presets') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/presets', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/gateway/status') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/gateway/status', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request(`https://internal/session/sessions${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/fetch') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/fetch', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/metadata') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/metadata', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/links') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/links', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/text') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/text', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/search') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/search', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/web/crawl') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/web/crawl', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/vision/analyze') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/vision/analyze', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/image/generate') {
      const stub = getSpecialSessionStub(env, '__web__');
      return stub.fetch(new Request('https://internal/session/image/generate', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/code/exec') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/code/exec', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/code/bridge') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/code/bridge', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/code/bridge/call') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/code/bridge/call', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/code/bridge/status') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request(`https://internal/session/code/bridge/status${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/code/bridge/transcript') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request(`https://internal/session/code/bridge/transcript${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/code/bridge/close') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/code/bridge/close', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/node/exec') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/node/exec', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/python/exec') {
      const stub = getSpecialSessionStub(env, '__code__');
      return stub.fetch(new Request('https://internal/session/python/exec', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/screenshot') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/screenshot', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/goto') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/goto', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/open') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/open', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && (url.pathname === '/api/browser/wait' || url.pathname === '/api/browser/wait-for')) {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/wait-for', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/navigate') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/navigate', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/snapshot') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/snapshot', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/back') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/back', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/scroll') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/scroll', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/press') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/press', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/console') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/console', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/vision') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/vision', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/images') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/images', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/click-ref') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/click-ref', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/extract') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/extract', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/click') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/click', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/type') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/type', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/browser/session') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request(`https://internal/session/browser/session${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/browser/session/reset') {
      const stub = getSpecialSessionStub(env, '__browser__');
      return stub.fetch(new Request('https://internal/session/browser/session/reset', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/file/read') {
      const stub = getSpecialSessionStub(env, '__files__');
      return stub.fetch(new Request('https://internal/session/file/read', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/file/write') {
      const stub = getSpecialSessionStub(env, '__files__');
      return stub.fetch(new Request('https://internal/session/file/write', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/file/exists') {
      const stub = getSpecialSessionStub(env, '__files__');
      return stub.fetch(new Request('https://internal/session/file/exists', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/file/delete') {
      const stub = getSpecialSessionStub(env, '__files__');
      return stub.fetch(new Request('https://internal/session/file/delete', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/workspace') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request(`https://internal/session/workspace${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/workspace/exists') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request(`https://internal/session/workspace/exists${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/workspace/')) {
      const suffix = url.pathname.replace('/api', '');
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request(`https://internal/session${suffix}${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/write') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request('https://internal/session/workspace/write', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/patch') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request('https://internal/session/workspace/patch', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/patch-text') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request('https://internal/session/workspace/patch-text', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/delete') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request('https://internal/session/workspace/delete', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/workspace/rename') {
      const stub = getSpecialSessionStub(env, '__workspace__');
      return stub.fetch(new Request('https://internal/session/workspace/rename', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/plugins') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/plugins', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/tools') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/tools', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/resources') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/resources', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/prompts') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/prompts', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/status') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/status', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/mcp/inspect') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request(`https://internal/session/mcp/inspect${url.search}`, {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/reload') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/reload', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/list-changed') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/list-changed', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/mcp/call') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/mcp/call', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/learning/drafts') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/learning/drafts', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/learning/drafts/pending') {
      return forwardToSystemSession(request, env, url, '/learning/drafts/pending');
    }

    if (request.method === 'GET' && url.pathname === '/api/learning/dashboard') {
      return forwardToSystemSession(request, env, url, '/learning/dashboard');
    }

    if (request.method === 'POST' && url.pathname === '/api/learning/auto-capture') {
      return forwardToSystemSession(request, env, url, '/learning/auto-capture');
    }

    if (request.method === 'POST' && url.pathname === '/api/learning/match') {
      return forwardToSystemSession(request, env, url, '/learning/match');
    }

    if (request.method === 'POST' && url.pathname === '/api/learning/drafts') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/learning/drafts', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname.startsWith('/api/learning/drafts/')) {
      const stub = getSpecialSessionStub(env, '__system__');
      const suffix = url.pathname.replace('/api', '');
      return stub.fetch(new Request(`https://internal/session${suffix}`, {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/scheduler/jobs') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/jobs', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/scheduler/jobs') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/jobs', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/scheduler/tick') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/tick', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
    }

    // Scheduler lifecycle parity routes (#39). Mirror the Node runtime's
    // route-paths.scheduler shape so dashboard buttons (pause/resume/delete/
    // history/dry-run/start/stop/status) work identically on CF.
    {
      const lifecycleMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)\/(pause|resume|history|dry-run)$/);
      const deleteMatch = url.pathname.match(/^\/api\/scheduler\/jobs\/([^/]+)$/);
      if (lifecycleMatch && (request.method === 'GET' || request.method === 'POST')) {
        const stub = getSpecialSessionStub(env, '__system__');
        const internalPath = `https://internal/session/scheduler/jobs/${lifecycleMatch[1]}/${lifecycleMatch[2]}${url.search}`;
        const init: RequestInit = {
          method: request.method,
          headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        };
        if (request.method === 'POST') init.body = await request.text();
        return stub.fetch(new Request(internalPath, init));
      }
      // DELETE /api/scheduler/jobs/:id — only when not also a lifecycle action.
      if (deleteMatch && !lifecycleMatch && request.method === 'DELETE') {
        const stub = getSpecialSessionStub(env, '__system__');
        return stub.fetch(new Request(`https://internal/session/scheduler/jobs/${deleteMatch[1]}`, {
          method: 'DELETE',
          headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        }));
      }
    }

    if (request.method === 'POST' && url.pathname === '/api/scheduler/start') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/start', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/scheduler/stop') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/stop', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      }));
    }

    if (request.method === 'GET' && url.pathname === '/api/scheduler/status') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/scheduler/status', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      }));
    }

    // Active config-preset selection (#33). Routes match Node's
    // `/api/config-presets/active` (GET) and `/api/config-presets/switch` (POST).
    if (request.method === 'GET' && url.pathname === '/api/config-presets/active') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/config-presets/active', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/config-presets/switch') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/config-presets/switch', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text(),
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/telegram/send') {
      const body = (await request.json()) as { botToken: string; chatId: string; text: string; parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; disableWebPagePreview?: boolean };
      const response = await fetch(buildTelegramSendUrl(body.botToken), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTelegramSendPayload(body))
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/telegram/edit') {
      const body = (await request.json()) as { botToken: string; chatId: string; messageId: number; text: string; parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML'; disableWebPagePreview?: boolean };
      const response = await fetch(buildTelegramEditUrl(body.botToken), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildTelegramEditPayload(body))
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/discord/send') {
      const body = (await request.json()) as { webhookUrl: string; content: string };
      const response = await fetch(buildDiscordWebhookSendUrl(body.webhookUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: body.content })
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/discord/edit') {
      const body = (await request.json()) as { webhookUrl: string; messageId: string; content: string };
      const response = await fetch(buildDiscordWebhookEditUrl(body.webhookUrl, body.messageId), {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDiscordEditPayload({ messageId: body.messageId, content: body.content }))
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/slack/send') {
      const body = (await request.json()) as { botToken: string; channel: string; text: string; threadTs?: string };
      const response = await fetch(buildSlackSendUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${body.botToken}`
        },
        body: JSON.stringify(buildSlackSendPayload(body))
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/slack/edit') {
      const body = (await request.json()) as { botToken: string; channel: string; text: string; ts: string; threadTs?: string };
      const response = await fetch(buildSlackEditUrl(), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${body.botToken}`
        },
        body: JSON.stringify(buildSlackEditPayload(body))
      });
      return new Response(await response.text(), {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' }
      });
    }

    if (request.method === 'POST' && url.pathname === '/api/gateway/webhook') {
      const payload = (await request.json()) as { channelId?: string; chatId?: string; userId?: string; text?: string; message?: string };
      const message = normalizeGenericWebhook(payload);
      const idempotencyKey = buildGatewayIdempotencyKey(message);
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message) });
        }
      }
      const sessionId = buildGatewaySessionKey(message);
      const durableId = env.AGENT_SESSIONS.idFromName(sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userMessage: message.text,
          userId: message.userId,
          workspaceId: message.channelId,
        })
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/gateway/inspect') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/gateway/inspect', {
        method: 'POST',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
        body: await request.text()
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/discord') {
      // Ed25519 signature verification (#24). Fail-closed when the public key
      // is not configured, matching the Node runtime's behavior at
      // `runtime-node/src/index.ts:3313-3324`. The raw body must be read once
      // for the signature check and reused for `JSON.parse` — re-reading the
      // request stream throws.
      const discordPubKey = env.DISCORD_PUBLIC_KEY;
      if (!discordPubKey) {
        return Response.json({ ok: false, error: 'Discord public key not configured' }, { status: 403 });
      }
      const rawBody = await request.text();
      const sigValid = await verifyDiscordWebhookSignature(request, discordPubKey, rawBody);
      if (!sigValid) {
        return Response.json({ ok: false, error: 'Invalid Discord webhook signature' }, { status: 403 });
      }

      const payload = JSON.parse(rawBody);
      const dispatch = buildDiscordDispatch(payload as never);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/slack') {
      const rawBody = await request.text();
      if (env.SLACK_SIGNING_SECRET) {
        const signature = request.headers.get('x-slack-signature') ?? '';
        const timestamp = request.headers.get('x-slack-request-timestamp') ?? '';
        const tsNum = parseInt(timestamp, 10);
        if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
          return Response.json({ ok: false, error: 'Slack timestamp outside replay window.' }, { status: 401 });
        }
        const verified = await verifySlackSignature({
          signingSecret: env.SLACK_SIGNING_SECRET,
          timestamp,
          body: rawBody,
          signature
        });
        if (!verified) {
          return Response.json({ ok: false, error: 'Invalid Slack signature.' }, { status: 401 });
        }
      }
      const payload = JSON.parse(rawBody) as unknown;
      if ((payload as { type?: string; challenge?: string }).type === 'url_verification') {
        return Response.json({ challenge: (payload as { challenge?: string }).challenge ?? '' });
      }
      const message = normalizeSlackWebhook(payload as never);
      const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message!) });
        }
      }
      const dispatch = buildSlackDispatch(payload as never);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/telegram') {
      const update = (await request.json()) as TelegramUpdate;
      const message = normalizeTelegramWebhook(update);
      const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message!) });
        }
      }
      const dispatch = buildTelegramDispatch(update);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/whatsapp') {
      const payload = await request.json();
      const message = normalizeWhatsAppWebhook(payload as never);
      const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message!) });
        }
      }
      const dispatch = buildWhatsAppDispatch(payload as never);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/signal') {
      const payload = await request.json();
      const message = normalizeSignalWebhook(payload as never);
      const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message!) });
        }
      }
      const dispatch = buildSignalDispatch(payload as never);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/webhooks/email') {
      const payload = await request.json();
      const message = normalizeEmailWebhook(payload as never);
      const idempotencyKey = message ? buildGatewayIdempotencyKey(message) : null;
      if (idempotencyKey) {
        const systemStub = getSpecialSessionStub(env, '__system__');
        const duplicateResponse = await systemStub.fetch(new Request('https://internal/session/gateway/idempotency', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ key: idempotencyKey })
        }));
        const duplicatePayload = await duplicateResponse.json() as { duplicate?: boolean };
        if (duplicatePayload.duplicate) {
          return Response.json({ ok: true, duplicate: true, sessionId: buildGatewaySessionKey(message!) });
        }
      }
      const dispatch = buildEmailDispatch(payload as never);
      if (!dispatch) {
        return Response.json({ ok: false, ignored: true });
      }

      const durableId = env.AGENT_SESSIONS.idFromName(dispatch.sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dispatch.payload)
      }));
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions') {
      const rawBody = await request.text();
      const body = (() => {
        if (!rawBody) {
          return {};
        }
        try {
          return JSON.parse(rawBody) as { sessionId?: string; userId?: string; workspaceId?: string };
        } catch {
          return {};
        }
      })();
      const { sessionId } = body;
      const durableId = env.AGENT_SESSIONS.idFromName(sessionId ?? crypto.randomUUID());
      const stub = env.AGENT_SESSIONS.get(durableId);
      return stub.fetch(new Request('https://internal/session/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: body.userId, workspaceId: body.workspaceId })
      }));
    }

    if ((request.method === 'GET' || request.method === 'POST') && url.pathname.startsWith('/api/sessions/')) {
      const parts = url.pathname.split('/').filter(Boolean);
      const sessionId = parts[2] ?? crypto.randomUUID();
      const suffixParts = parts.slice(3);
      const actionPath = suffixParts.length > 0
        ? suffixParts.join('/')
        : request.method === 'GET'
          ? 'history'
          : 'message';
      const durableId = env.AGENT_SESSIONS.idFromName(sessionId);
      const stub = env.AGENT_SESSIONS.get(durableId);
      const init: RequestInit = {
        method: request.method,
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      };
      if (request.method === 'POST') {
        init.body = await request.text();
      }
      const search = url.search || '';
      return stub.fetch(new Request(`https://internal/session/${actionPath}${search}`, init));
    }

    const unsupported = maybeUnsupportedOnWorkers(url.pathname);
    if (unsupported) return unsupported;

    return new Response('Not found', { status: 404 });
  },
};

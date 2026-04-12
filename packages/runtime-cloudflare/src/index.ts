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

function getSpecialSessionStub(env: RuntimeEnv, name: string) {
  const durableId = env.AGENT_SESSIONS.idFromName(name);
  return env.AGENT_SESSIONS.get(durableId);
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

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'crowclaw', runtime: 'cloudflare' });
    }

    if (request.method === 'GET' && url.pathname === '/api/system/status') {
      const stub = getSpecialSessionStub(env, '__system__');
      return stub.fetch(new Request('https://internal/session/system/status', {
        method: 'GET',
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' }
      }));
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
      const payload = await request.json();
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

    return new Response('Not found', { status: 404 });
  },
};

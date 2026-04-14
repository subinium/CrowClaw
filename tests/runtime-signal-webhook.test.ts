import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

const signalPayload = {
  envelope: {
    sourceNumber: '+15550001',
    timestamp: 1700000000,
    dataMessage: { message: 'hello from signal' }
  }
};

describe('signal webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes Signal webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, webhookSecrets: { signal: 'sig-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/signal/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const response = await runtime.fetch(new Request('http://localhost/webhooks/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sig-secret' },
      body: JSON.stringify(signalPayload)
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('signal:+15550001');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('deduplicates Signal webhook payloads in the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, webhookSecrets: { signal: 'sig-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/signal/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    await runtime.fetch(new Request('http://localhost/webhooks/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sig-secret' },
      body: JSON.stringify(signalPayload)
    }));

    const duplicate = await runtime.fetch(new Request('http://localhost/webhooks/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sig-secret' },
      body: JSON.stringify(signalPayload)
    }));

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'signal:+15550001' });
  });

  it('routes and deduplicates Signal webhook payloads through the Cloudflare runtime ingress', async () => {
    let seen = false;
    const sessionFetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const systemFetch = vi.fn(async () => {
      const duplicate = seen;
      seen = true;
      return Response.json({ ok: true, duplicate });
    });
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: (id: { toString(): string }) => id.toString() === '__system__' ? { fetch: systemFetch } : { fetch: sessionFetch }
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const first = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sig-secret' },
      body: JSON.stringify(signalPayload)
    }), env as never);
    const firstPayload = await first.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(firstPayload.forwardedTo).toContain('/message');
    expect(firstPayload.body).toEqual({
      userMessage: 'hello from signal',
      userId: '+15550001',
      workspaceId: '+15550001'
    });

    const duplicate = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/signal', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer sig-secret' },
      body: JSON.stringify(signalPayload)
    }), env as never);
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'signal:+15550001' });
  });
});

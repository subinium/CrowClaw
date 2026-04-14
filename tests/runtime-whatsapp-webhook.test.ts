import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

const whatsappPayload = {
  entry: [{
    changes: [{
      value: {
        metadata: { phone_number_id: 'wa-phone-1' },
        messages: [{
          id: 'wamid-1',
          from: 'user-wa-1',
          timestamp: '1700000000',
          text: { body: 'hello from whatsapp' }
        }]
      }
    }]
  }]
};

describe('whatsapp webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes WhatsApp webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, webhookSecrets: { whatsapp: 'wa-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/whatsapp/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const response = await runtime.fetch(new Request('http://localhost/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wa-secret' },
      body: JSON.stringify(whatsappPayload)
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('whatsapp:wa-phone-1');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('deduplicates WhatsApp webhook payloads in the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, webhookSecrets: { whatsapp: 'wa-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/whatsapp/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    await runtime.fetch(new Request('http://localhost/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wa-secret' },
      body: JSON.stringify(whatsappPayload)
    }));

    const duplicate = await runtime.fetch(new Request('http://localhost/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wa-secret' },
      body: JSON.stringify(whatsappPayload)
    }));

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'whatsapp:wa-phone-1' });
  });

  it('routes and deduplicates WhatsApp webhook payloads through the Cloudflare runtime ingress', async () => {
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

    const first = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wa-secret' },
      body: JSON.stringify(whatsappPayload)
    }), env as never);
    const firstPayload = await first.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(firstPayload.forwardedTo).toContain('/message');
    expect(firstPayload.body).toEqual({
      userMessage: 'hello from whatsapp',
      userId: 'user-wa-1',
      workspaceId: 'wa-phone-1'
    });

    const duplicate = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/whatsapp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer wa-secret' },
      body: JSON.stringify(whatsappPayload)
    }), env as never);
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'whatsapp:wa-phone-1' });
  });
});

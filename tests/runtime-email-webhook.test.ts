import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

const emailPayload = {
  messageId: 'email-1',
  from: 'user@example.com',
  to: 'agent@example.com',
  subject: 'Deploy request',
  text: 'please deploy crowclaw',
  inboxId: 'support-inbox'
};

describe('email webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes Email webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ webhookSecrets: { email: 'email-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/email/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const response = await runtime.fetch(new Request('http://localhost/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer email-secret' },
      body: JSON.stringify(emailPayload)
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('email:support-inbox');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('deduplicates Email webhook payloads in the node runtime', async () => {
    const runtime = createNodeRuntime({ webhookSecrets: { email: 'email-secret' } });
    await runtime.fetch(new Request('http://localhost/api/gateway/email/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    await runtime.fetch(new Request('http://localhost/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer email-secret' },
      body: JSON.stringify(emailPayload)
    }));

    const duplicate = await runtime.fetch(new Request('http://localhost/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer email-secret' },
      body: JSON.stringify(emailPayload)
    }));

    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'email:support-inbox' });
  });

  it('routes and deduplicates Email webhook payloads through the Cloudflare runtime ingress', async () => {
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

    const first = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer email-secret' },
      body: JSON.stringify(emailPayload)
    }), env as never);
    const firstPayload = await first.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(firstPayload.forwardedTo).toContain('/message');
    expect(firstPayload.body).toEqual({
      userMessage: 'Subject: Deploy request\nplease deploy crowclaw',
      userId: 'user@example.com',
      workspaceId: 'support-inbox'
    });

    const duplicate = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'authorization': 'Bearer email-secret' },
      body: JSON.stringify(emailPayload)
    }), env as never);
    expect(await duplicate.json()).toEqual({ ok: true, duplicate: true, sessionId: 'email:support-inbox' });
  });
});

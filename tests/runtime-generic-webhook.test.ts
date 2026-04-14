import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('generic webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes generic webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    // Configure a gateway policy for the 'webhook' platform so deny-by-default doesn't block
    await runtime.fetch(new Request('http://localhost/api/gateway/webhook/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));

    const response = await runtime.fetch(new Request('http://localhost/api/gateway/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'room-1', userId: 'user-1', text: 'hello webhook' })
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('webhook:room-1');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('routes generic webhook payloads through the Cloudflare runtime ingress', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/gateway/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: 'room-2', userId: 'user-2', text: 'hello generic webhook' })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(payload.forwardedTo).toContain('/message');
    expect(payload.body).toEqual({
      userMessage: 'hello generic webhook',
      userId: 'user-2',
      workspaceId: 'room-2'
    });
  });

  it('inspects gateway delivery plans through the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const response = await runtime.fetch(new Request('http://localhost/api/gateway/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'signal',
        payload: {
          envelope: {
            sourceNumber: '+15550001',
            timestamp: 1700000000,
            dataMessage: { message: 'hello from signal' }
          }
        }
      })
    }));

    const payload = await response.json() as { ok: boolean; deliveryPlan: { sessionId: string; retryPolicy: { maxAttempts: number }; idempotencyKey: string } };
    expect(payload.ok).toBe(true);
    expect(payload.deliveryPlan).toEqual({
      sessionId: 'signal:+15550001',
      retryPolicy: { maxAttempts: 2, baseDelayMs: 500 },
      idempotencyKey: 'signal:+15550001:1700000000',
      platform: 'signal',
      userMessage: 'hello from signal',
      userId: '+15550001',
      workspaceId: '+15550001'
    });
  });

  it('inspects Matrix and SMS gateway delivery plans through the node runtime', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });

    const matrix = await runtime.fetch(new Request('http://localhost/api/gateway/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'matrix',
        payload: {
          eventId: '$matrix-1',
          roomId: '!room:example.com',
          sender: '@alice:example.com',
          content: { body: 'hello from matrix', msgtype: 'm.text' },
          timestamp: 1700000000
        }
      })
    }));

    expect(await matrix.json()).toMatchObject({
      ok: true,
      deliveryPlan: {
        sessionId: 'matrix:!room:example.com',
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1000 },
        idempotencyKey: 'matrix:!room:example.com:$matrix-1',
        platform: 'matrix',
        userMessage: 'hello from matrix',
        userId: '@alice:example.com',
        workspaceId: '!room:example.com'
      }
    });

    const sms = await runtime.fetch(new Request('http://localhost/api/gateway/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'sms',
        payload: {
          messageId: 'sms-1',
          from: '+15550001',
          to: '+15550099',
          text: 'hello from sms',
          conversationId: 'conv-1',
          timestamp: 1700000000
        }
      })
    }));

    expect(await sms.json()).toMatchObject({
      ok: true,
      deliveryPlan: {
        sessionId: 'sms:conv-1',
        retryPolicy: { maxAttempts: 3, baseDelayMs: 1250 },
        idempotencyKey: 'sms:conv-1:sms-1',
        platform: 'sms',
        userMessage: 'hello from sms',
        userId: '+15550001',
        workspaceId: 'conv-1'
      }
    });
  });
});

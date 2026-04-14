import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('telegram webhook runtime paths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes Telegram webhooks into the node runtime session flow', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, telegramWebhookSecret: 'tg-secret' });
    // Configure gateway policy so deny-by-default doesn't block
    await runtime.fetch(new Request('http://localhost/api/gateway/telegram/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const response = await runtime.fetch(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-secret' },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 2,
          date: 1700000000,
          text: 'hello from telegram',
          from: { id: 42 },
          chat: { id: 99 }
        }
      })
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('telegram:99');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('routes Telegram webhooks into the session durable object', async () => {
    const worker = (await import('@crowclaw/runtime-cloudflare')).default;
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

    const response = await worker.fetch(new Request('https://example.com/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 2,
          date: 1700000000,
          text: 'hello from telegram',
          from: { id: 42 },
          chat: { id: 99 }
        }
      })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(payload.forwardedTo).toContain('/message');
    expect(payload.body).toEqual({
      userMessage: 'hello from telegram',
      userId: '42',
      workspaceId: '99'
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

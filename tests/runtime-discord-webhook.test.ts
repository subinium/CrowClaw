import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('discord webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes discord webhook payloads through the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/webhooks/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel_id: 'chan-1',
        member: { user: { id: 'user-1' } },
        data: { name: 'deploy', options: [{ value: 'crowclaw' }] }
      })
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('discord:chan-1');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('routes discord webhook payloads through the Cloudflare runtime ingress', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel_id: 'chan-2',
        member: { user: { id: 'user-2' } },
        data: { name: 'deploy', options: [{ value: 'cloudflare' }] }
      })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(payload.forwardedTo).toContain('/message');
    expect(payload.body).toEqual({
      userMessage: 'deploy cloudflare',
      userId: 'user-2',
      workspaceId: 'chan-2'
    });
  });
});

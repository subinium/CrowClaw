import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { buildSlackSignature } from '@crowclaw/gateway';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('slack webhook runtime integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes slack webhook payloads through the node runtime', async () => {
    const signingSecret = 'slack-test-secret';
    const runtime = createNodeRuntime({ configStorePath: null, slackSigningSecret: signingSecret });
    await runtime.fetch(new Request('http://localhost/api/gateway/slack/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C-1', user: 'U-1', text: 'deploy slack' }
    });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature(signingSecret, timestamp, body);

    const response = await runtime.fetch(new Request('http://localhost/webhooks/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
      body
    }));

    const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('slack:C-1');
    expect(payload.finalResponse).toContain('CrowClaw received');
  });

  it('routes slack webhook payloads through the Cloudflare runtime ingress', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'event_callback',
        event: { channel: 'C-2', user: 'U-2', text: 'deploy cloudflare slack' }
      })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(payload.forwardedTo).toContain('/message');
    expect(payload.body).toEqual({
      userMessage: 'deploy cloudflare slack',
      userId: 'U-2',
      workspaceId: 'C-2'
    });
  });

  it('responds to slack url verification without dispatching', async () => {
    const signingSecret = 'slack-test-secret';
    const runtime = createNodeRuntime({ configStorePath: null, slackSigningSecret: signingSecret });
    const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-123' });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature(signingSecret, timestamp, body);

    const response = await runtime.fetch(new Request('http://localhost/webhooks/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature },
      body
    }));

    expect(await response.json()).toEqual({ challenge: 'challenge-123' });
  });

  it('rejects invalid slack signatures when verification is configured', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, slackSigningSecret: 'correct-secret' });
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C-3', user: 'U-3', text: 'deploy signed slack' }
    });

    const response = await runtime.fetch(new Request('http://localhost/webhooks/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-slack-signature': 'v0=deadbeef'
      },
      body
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Invalid Slack signature.' });
  });

  it('accepts valid slack signatures when verification is configured', async () => {
    const runtime = createNodeRuntime({ configStorePath: null, slackSigningSecret: 'correct-secret' });
    await runtime.fetch(new Request('http://localhost/api/gateway/slack/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dmPolicy: 'open', groupPolicy: 'open' })
    }));
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C-4', user: 'U-4', text: 'deploy signed slack ok' }
    });
    const ts1 = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('correct-secret', ts1, body);

    const response = await runtime.fetch(new Request('http://localhost/webhooks/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts1,
        'x-slack-signature': signature
      },
      body
    }));

    expect(response.status).toBe(200);
    const payload = await response.json() as { session: { sessionId: string } };
    expect(payload.session.sessionId).toBe('slack:C-4');
  });

  it('rejects invalid slack signatures in the Cloudflare runtime ingress', async () => {
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
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      SLACK_SIGNING_SECRET: 'correct-secret'
    };
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C-5', user: 'U-5', text: 'cf signed slack' }
    });

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': Math.floor(Date.now() / 1000).toString(),
        'x-slack-signature': 'v0=bad'
      },
      body
    }), env as never);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ ok: false, error: 'Invalid Slack signature.' });
  });

  it('accepts valid slack signatures in the Cloudflare runtime ingress', async () => {
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
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      SLACK_SIGNING_SECRET: 'correct-secret'
    };
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C-6', user: 'U-6', text: 'cf signed slack ok' }
    });
    const ts3 = Math.floor(Date.now() / 1000).toString();
    const signature = await buildSlackSignature('correct-secret', ts3, body);

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/slack', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-slack-request-timestamp': ts3,
        'x-slack-signature': signature
      },
      body
    }), env as never);

    expect(response.status).toBe(200);
    const payload = await response.json() as { forwardedTo: string; body: { userMessage: string; userId: string; workspaceId: string } };
    expect(payload.forwardedTo).toContain('/message');
    expect(payload.body).toEqual({
      userMessage: 'cf signed slack ok',
      userId: 'U-6',
      workspaceId: 'C-6'
    });
  });
});

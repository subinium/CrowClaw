import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime memory capture routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures scoped memory in the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/api/sessions/demo/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'workspace',
        scopeKey: 'workspace-demo',
        messages: [
          { role: 'user', content: 'workspace convention', createdAt: new Date().toISOString() }
        ]
      })
    }));

    const payload = await response.json() as { scope: string; scopeKey?: string; summary: string };
    expect(payload.scope).toBe('workspace');
    expect(payload.scopeKey).toBe('workspace-demo');
    expect(payload.summary).toContain('workspace convention');
  });

  it('captures scoped memory in the Cloudflare runtime durable object', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scope: 'user', scopeKey: 'user-123', messages: [{ role: 'user', content: 'remember user pref' }] })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { scope: string; scopeKey: string } };
    expect(payload.forwardedTo).toContain('/capture');
    expect(payload.body.scope).toBe('user');
    expect(payload.body.scopeKey).toBe('user-123');
  });
});

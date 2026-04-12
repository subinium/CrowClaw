import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime scoped memory recall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supports memory scope recall in the node runtime', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Workspace note about cloudflare', tags: ['cloudflare'], metadata: { lane: 'ops' }, scope: 'workspace', scopeKey: 'workspace-a' })
    }));

    await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Workspace note about cloudflare second', tags: ['cloudflare'], scope: 'workspace', scopeKey: 'workspace-b' })
    }));

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/demo/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'memory', scope: 'workspace', scopeKey: 'workspace-a', query: 'cloudflare' })
    }));

    const payload = await response.json() as { scope: string; scopeKey?: string; results: Array<{ summary: string; scopeKey?: string }> };
    expect(payload.scope).toBe('workspace');
    expect(payload.scopeKey).toBe('workspace-a');
    expect(payload.results[0]?.summary).toContain('Workspace note about cloudflare');
    expect(payload.results).toHaveLength(1);
  });

  it('supports memory scope recall in the Cloudflare runtime ingress', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'memory', scope: 'workspace', scopeKey: 'workspace-a', query: 'cloudflare' })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { source: string; scope: string; scopeKey: string; query: string } };
    expect(payload.forwardedTo).toContain('/search');
    expect(payload.body).toEqual({ source: 'memory', scope: 'workspace', scopeKey: 'workspace-a', query: 'cloudflare' });
  });
});

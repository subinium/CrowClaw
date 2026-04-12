import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare nested session forwarding', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('preserves nested POST paths when forwarding to the durable object', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Draft', messages: [] })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { title: string } };
    expect(payload.forwardedTo).toContain('/learning/drafts');
    expect(payload.body.title).toBe('Draft');
  });

  it('preserves nested GET paths and query strings when forwarding to the durable object', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url }));
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/workspace?path=src/app.ts'), env as never);
    const payload = await response.json() as { forwardedTo: string };
    expect(payload.forwardedTo).toContain('/workspace?path=src/app.ts');
  });

  it('preserves nested path-style workspace reads when forwarding to the durable object', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url }));
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/workspace/src/app.ts'), env as never);
    const payload = await response.json() as { forwardedTo: string };
    expect(payload.forwardedTo).toContain('/workspace/src/app.ts');
  });

  it('preserves nested workspace mutation paths when forwarding to the durable object', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/workspace/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromPath: 'src/app.ts', toPath: 'src/main.ts' })
    }), env as never);
    const payload = await response.json() as { forwardedTo: string; body: { fromPath: string; toPath: string } };
    expect(payload.forwardedTo).toContain('/workspace/rename');
    expect(payload.body).toEqual({ fromPath: 'src/app.ts', toPath: 'src/main.ts' });
  });
});

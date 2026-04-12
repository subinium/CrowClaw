import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare worker routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('routes GET session history requests to the durable object action', async () => {
    const worker = (await import('@crowclaw/runtime-cloudflare')).default;
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, method: request.method }));
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

    const response = await worker.fetch(new Request('https://example.com/api/sessions/demo/history'), env as never);
    const payload = await response.json() as { forwardedTo: string; method: string };

    expect(payload.forwardedTo).toContain('/history');
    expect(payload.method).toBe('GET');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

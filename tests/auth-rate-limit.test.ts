import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '@crowclaw/runtime-node';
import { EchoProvider } from '@crowclaw/providers';

describe('auth rate limiting', () => {
  it('applies stricter rate limit (5/min) to auth endpoints', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // First 5 should succeed
    for (let i = 0; i < 5; i++) {
      const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
      expect(res.status).not.toBe(429);
    }

    // 6th should be rate limited
    const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('authentication attempts');
  });

  it('6th request returns 429 and subsequent ones also return 429', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // First 5 succeed
    for (let i = 0; i < 5; i++) {
      const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
      expect(res.status).toBe(200);
    }

    // 6th, 7th, 8th should all be 429
    for (let i = 0; i < 3; i++) {
      const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
      expect(res.status).toBe(429);
    }
  });

  it('auth rate limit is separate from general API rate limit', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // Exhaust auth limit
    for (let i = 0; i < 6; i++) {
      await runtime.fetch(new Request('http://localhost/api/auth/check'));
    }

    // General API endpoint should still work (200, not 429)
    const res = await runtime.fetch(new Request('http://localhost/api/sessions'));
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(200);
  });

  it('different auth endpoints share the same rate limit bucket', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // 3 requests to /verify, 2 to /check = 5 total
    for (let i = 0; i < 3; i++) {
      await runtime.fetch(new Request('http://localhost/api/auth/verify', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } }));
    }
    for (let i = 0; i < 2; i++) {
      await runtime.fetch(new Request('http://localhost/api/auth/check'));
    }

    // 6th should be rate limited
    const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
    expect(res.status).toBe(429);
  });
});

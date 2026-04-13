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

  it('auth rate limit is separate from general API rate limit', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // Exhaust auth limit
    for (let i = 0; i < 6; i++) {
      await runtime.fetch(new Request('http://localhost/api/auth/check'));
    }

    // General API endpoint should still work
    const res = await runtime.fetch(new Request('http://localhost/api/sessions'));
    expect(res.status).not.toBe(429);
  });
});

import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '@crowclaw/runtime-node';
import { EchoProvider } from '@crowclaw/providers';

describe('auth rate limiting', () => {
  // The dashboard hits /api/auth/check on every page load as a passive
  // cookie/bearer status read; rate-limiting it would lock real users out.
  // Only POST /api/auth/verify (which actually consumes a token attempt) is
  // throttled. The limit is also raised from 5 to 10 to match the CLI's
  // typical retry budget for failed first attempts.
  it('applies a stricter rate limit (10/min) to /api/auth/verify', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // First 10 should succeed (return 200 with {ok: false}, not 429)
    for (let i = 0; i < 10; i++) {
      const res = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
        method: 'POST', body: JSON.stringify({ token: 'wrong' }), headers: { 'content-type': 'application/json' },
      }));
      expect(res.status).not.toBe(429);
    }

    // 11th should be rate limited
    const res = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
      method: 'POST', body: JSON.stringify({ token: 'wrong' }), headers: { 'content-type': 'application/json' },
    }));
    expect(res.status).toBe(429);
    const body = await res.json() as { error: string };
    expect(body.error).toContain('authentication attempts');
  });

  it('11th request returns 429 and subsequent ones also return 429', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    const verifyReq = () => new Request('http://localhost/api/auth/verify', {
      method: 'POST', body: JSON.stringify({ token: 'wrong' }), headers: { 'content-type': 'application/json' },
    });

    for (let i = 0; i < 10; i++) {
      const res = await runtime.fetch(verifyReq());
      expect(res.status).not.toBe(429);
    }
    for (let i = 0; i < 3; i++) {
      const res = await runtime.fetch(verifyReq());
      expect(res.status).toBe(429);
    }
  });

  it('/api/auth/check is NOT rate-limited (passive status read)', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // 30 calls to /check should all succeed — the dashboard relies on this.
    for (let i = 0; i < 30; i++) {
      const res = await runtime.fetch(new Request('http://localhost/api/auth/check'));
      expect(res.status).not.toBe(429);
    }
  });

  it('auth rate limit is separate from general API rate limit', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });

    // Exhaust /verify limit
    for (let i = 0; i < 11; i++) {
      await runtime.fetch(new Request('http://localhost/api/auth/verify', {
        method: 'POST', body: JSON.stringify({ token: 'wrong' }), headers: { 'content-type': 'application/json' },
      }));
    }

    // General API endpoint should still work (200, not 429)
    const res = await runtime.fetch(new Request('http://localhost/api/sessions'));
    expect(res.status).not.toBe(429);
    expect(res.status).toBe(200);
  });
});

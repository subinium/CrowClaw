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

  it('rejects discord webhook payloads without public key configured', async () => {
    const runtime = createNodeRuntime({ configStorePath: null });
    const response = await runtime.fetch(new Request('http://localhost/webhooks/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel_id: 'chan-1',
        member: { user: { id: 'user-1' } },
        data: { name: 'deploy', options: [{ value: 'crowclaw' }] }
      })
    }));

    expect(response.status).toBe(403);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain('not configured');
  });

  it('rejects discord webhook payloads on Cloudflare without DISCORD_PUBLIC_KEY', async () => {
    // v0.5.0 (#24): CF runtime now enforces Ed25519 signature verification on
    // /webhooks/discord, mirroring the Node runtime's fail-closed semantics.
    // Without DISCORD_PUBLIC_KEY in env, the handler must 403.
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: vi.fn() })
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

    expect(response.status).toBe(403);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain('not configured');
  });

  it('rejects discord webhook payloads on Cloudflare with invalid signature', async () => {
    // With DISCORD_PUBLIC_KEY set but signature headers missing, the handler
    // must still 403 — never forward to the agent.
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => ({ fetch: vi.fn() })
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      DISCORD_PUBLIC_KEY: 'a'.repeat(64) // 32 bytes hex — valid format, won't verify
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/discord', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel_id: 'chan-2' })
    }), env as never);

    expect(response.status).toBe(403);
    const payload = await response.json() as { error: string };
    expect(payload.error).toContain('Invalid');
  });
});

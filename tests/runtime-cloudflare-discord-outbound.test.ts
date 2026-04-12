import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare discord outbound routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends discord webhook messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/discord/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://discord.test/webhook', content: 'hello discord' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { content: string } };

    expect(payload.body).toEqual({ content: 'hello discord' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.test/webhook',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('edits discord webhook messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/discord/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://discord.test/webhook', messageId: '123', content: 'edited' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { messageId: string; content: string } };

    expect(payload.body).toEqual({ messageId: '123', content: 'edited' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://discord.test/webhook/messages/123',
      expect.objectContaining({ method: 'PATCH' })
    );
  });
});

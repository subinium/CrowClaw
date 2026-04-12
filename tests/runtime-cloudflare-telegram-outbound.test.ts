import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare telegram outbound routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends Telegram messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/telegram/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'abc123', chatId: '99', text: 'hello telegram' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { chat_id: string; text: string } };

    expect(payload.body).toEqual({ chat_id: '99', text: 'hello telegram' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/sendMessage',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('edits Telegram messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/telegram/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'abc123', chatId: '99', messageId: 7, text: 'edited telegram' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { chat_id: string; message_id: number; text: string } };

    expect(payload.body).toEqual({ chat_id: '99', message_id: 7, text: 'edited telegram' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/editMessageText',
      expect.objectContaining({ method: 'POST' })
    );
  });
});

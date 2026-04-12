import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('slack outbound runtime routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends slack messages through the node runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createNodeRuntime();

    const response = await runtime.fetch(new Request('http://localhost/api/slack/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'xoxb-test', channel: 'C1', text: 'hello slack', threadTs: '1700.2' })
    }));
    const payload = await response.json() as { ok: boolean; body: { channel: string; text: string } };

    expect(payload.body).toEqual({ channel: 'C1', text: 'hello slack', thread_ts: '1700.2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-test' })
      })
    );
  });

  it('edits slack messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/slack/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'xoxb-test', channel: 'C1', text: 'edited', ts: '1700.1', threadTs: '1700.2' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { channel: string; text: string; ts: string; thread_ts: string } };

    expect(payload.body).toEqual({ channel: 'C1', text: 'edited', ts: '1700.1', thread_ts: '1700.2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-test' })
      })
    );
  });

  it('sends slack messages through the Cloudflare runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/slack/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'xoxb-test', channel: 'C1', text: 'hello cloudflare slack', threadTs: '1700.2' })
    }), env as never);
    const payload = await response.json() as { ok: boolean; body: { channel: string; text: string; thread_ts: string } };

    expect(payload.body).toEqual({ channel: 'C1', text: 'hello cloudflare slack', thread_ts: '1700.2' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-test' })
      })
    );
  });

  it('responds to slack url verification through the Cloudflare runtime', async () => {
    const env = {
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/webhooks/slack', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'url_verification', challenge: 'cf-challenge' })
    }), env as never);

    expect(await response.json()).toEqual({ challenge: 'cf-challenge' });
  });
});

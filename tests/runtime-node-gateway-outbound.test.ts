import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { RuntimeConfigStore } from '../packages/runtime-node/src/config-store.js';
import { EventBus, type RuntimeEvent } from '../packages/runtime-node/src/event-bus.js';
import { createGatewayActivityLog, createGatewayDelivery } from '../packages/runtime-node/src/gateway-wiring.js';

describe('runtime-node gateway outbound routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends and edits Telegram messages through the node runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createNodeRuntime();

    const send = await runtime.fetch(new Request('http://localhost/api/telegram/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'abc123', chatId: '99', text: 'hello telegram' })
    }));
    expect((await send.json() as { body: { chat_id: string; text: string } }).body).toEqual({
      chat_id: '99',
      text: 'hello telegram'
    });

    const edit = await runtime.fetch(new Request('http://localhost/api/telegram/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'abc123', chatId: '99', messageId: 7, text: 'edited telegram' })
    }));
    expect((await edit.json() as { body: { chat_id: string; message_id: number; text: string } }).body).toEqual({
      chat_id: '99',
      message_id: 7,
      text: 'edited telegram'
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.telegram.org/botabc123/sendMessage',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.telegram.org/botabc123/editMessageText',
      expect.objectContaining({ method: 'POST' })
    );
  });

  it('sends and edits Discord webhook messages through the node runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createNodeRuntime();

    const send = await runtime.fetch(new Request('http://localhost/api/discord/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://discord.test/webhook', content: 'hello discord' })
    }));
    expect((await send.json() as { body: { content: string } }).body).toEqual({ content: 'hello discord' });

    const edit = await runtime.fetch(new Request('http://localhost/api/discord/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://discord.test/webhook', messageId: '123', content: 'edited discord' })
    }));
    expect((await edit.json() as { body: { messageId: string; content: string } }).body).toEqual({ messageId: '123', content: 'edited discord' });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.test/webhook',
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.test/webhook/messages/123',
      expect.objectContaining({ method: 'PATCH' })
    );
  });

  it('refuses Discord send routes that violate configured endpoint policy', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/gateway/discord/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        enabled: true,
        policyTier: 'balanced',
        allowedEndpoints: ['/api/webhooks/*'],
      })
    }));

    const send = await runtime.fetch(new Request('http://localhost/api/discord/send', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ webhookUrl: 'https://discord.test/not-webhook', content: 'blocked' })
    }));
    expect(send.status).toBe(403);
    await expect(send.json()).resolves.toMatchObject({ error: 'Endpoint policy blocked', reason: 'disallowed-path' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('derives Discord delivery endpoint policy from gateway config and emits denial events', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    const configStore = new RuntimeConfigStore();
    configStore.setGatewayConfig('discord', {
      enabled: true,
      policyTier: 'restricted',
      allowedEndpoints: ['/api/webhooks/*'],
    });
    const eventBus = new EventBus();
    const events: RuntimeEvent[] = [];
    eventBus.subscribe((event) => events.push(event));
    const deliver = createGatewayDelivery({
      configStore,
      eventBus,
      gatewayActivityLog: createGatewayActivityLog(10),
    });

    const result = await deliver(
      { platform: 'discord', config: { webhookUrl: 'https://discord.com/api/channels/123/messages' } },
      'blocked',
    );

    expect(result).toMatchObject({ ok: false, error: 'Endpoint policy blocked: disallowed-path' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events).toContainEqual(expect.objectContaining({
      type: 'gateway:policy_denied',
      data: expect.objectContaining({
        platform: 'discord',
        reason: 'disallowed-path',
        policyTier: 'restricted',
      }),
    }));
  });

  it('edits Slack messages through the node runtime', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);
    const runtime = createNodeRuntime();

    const edit = await runtime.fetch(new Request('http://localhost/api/slack/edit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ botToken: 'xoxb-test', channel: 'C1', text: 'edited slack', ts: '1700.1', threadTs: '1700.2' })
    }));
    expect((await edit.json() as { body: { channel: string; text: string; ts: string; thread_ts: string } }).body).toEqual({
      channel: 'C1',
      text: 'edited slack',
      ts: '1700.1',
      thread_ts: '1700.2'
    });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://slack.com/api/chat.update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ authorization: 'Bearer xoxb-test' })
      })
    );
  });
});

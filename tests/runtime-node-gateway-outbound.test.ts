import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

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

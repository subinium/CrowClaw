import { afterEach, describe, expect, it, vi } from 'vitest';
import { editTelegramMessage, sendTelegramMessage, telegramApiBase } from '../packages/runtime-cloudflare/src/telegram.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runtime-cloudflare telegram outbound helpers', () => {
  it('builds the correct telegram API base', () => {
    expect(telegramApiBase('abc123')).toBe('https://api.telegram.org/botabc123');
  });

  it('sends a telegram message using the Telegram send payload shape', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await sendTelegramMessage({ botToken: 'abc123' }, {
      chatId: '99',
      text: 'hello',
      parseMode: 'Markdown'
    });
    const payload = await response.json() as { ok: boolean; body: { chat_id: string; text: string; parse_mode: string } };

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/sendMessage',
      expect.objectContaining({ method: 'POST' })
    );
    expect(payload.body).toEqual({
      chat_id: '99',
      text: 'hello',
      parse_mode: 'Markdown'
    });
  });

  it('edits a telegram message using the Telegram edit payload shape', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => Response.json({ ok: true, body: JSON.parse(String(init?.body)) }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await editTelegramMessage({ botToken: 'abc123' }, {
      chatId: '99',
      messageId: 7,
      text: 'edited',
      parseMode: 'HTML'
    });
    const payload = await response.json() as { ok: boolean; body: { chat_id: string; message_id: number; text: string; parse_mode: string } };

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.telegram.org/botabc123/editMessageText',
      expect.objectContaining({ method: 'POST' })
    );
    expect(payload.body).toEqual({
      chat_id: '99',
      message_id: 7,
      text: 'edited',
      parse_mode: 'HTML'
    });
  });
});

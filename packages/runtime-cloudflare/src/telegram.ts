import { buildTelegramEditPayload, buildTelegramSendPayload } from '@crowclaw/gateway';

export interface TelegramApiConfig {
  botToken?: string;
}

export function telegramApiBase(botToken: string): string {
  return `https://api.telegram.org/bot${botToken}`;
}

export async function sendTelegramMessage(
  config: TelegramApiConfig,
  input: {
    chatId: string;
    text: string;
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    disableWebPagePreview?: boolean;
  }
): Promise<Response> {
  if (!config.botToken) {
    throw new Error('Telegram bot token is not configured.');
  }

  return fetch(`${telegramApiBase(config.botToken)}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildTelegramSendPayload(input))
  });
}

export async function editTelegramMessage(
  config: TelegramApiConfig,
  input: {
    chatId: string;
    messageId: number;
    text: string;
    parseMode?: 'Markdown' | 'MarkdownV2' | 'HTML';
    disableWebPagePreview?: boolean;
  }
): Promise<Response> {
  if (!config.botToken) {
    throw new Error('Telegram bot token is not configured.');
  }

  return fetch(`${telegramApiBase(config.botToken)}/editMessageText`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildTelegramEditPayload(input))
  });
}

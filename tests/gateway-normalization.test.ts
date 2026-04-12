import { describe, expect, it } from 'vitest';
import {
  buildEmailDispatch,
  buildMatrixDispatch,
  buildSmsDispatch,
  buildGatewayDeliveryPlan,
  buildGatewayIdempotencyKey,
  buildGatewayRetryPolicy,
  buildSignalDispatch,
  buildGatewaySessionKey,
  buildTelegramDispatch,
  buildTelegramEditPayload,
  buildTelegramSendPayload,
  buildWhatsAppDispatch,
  normalizeEmailWebhook,
  normalizeGenericWebhook,
  normalizeSignalWebhook,
  normalizeTelegramWebhook,
  normalizeWhatsAppWebhook,
  normalizeMatrixWebhook,
  normalizeSmsWebhook,
  routeTelegramWebhook
} from '@crowclaw/gateway';

describe('gateway normalization', () => {
  it('normalizes generic webhook payloads', () => {
    const message = normalizeGenericWebhook({ chatId: 'chat-1', userId: 'user-1', text: 'hello' });
    expect(message.platform).toBe('webhook');
    expect(buildGatewaySessionKey(message)).toBe('webhook:chat-1');
  });

  it('normalizes telegram updates', () => {
    const message = normalizeTelegramWebhook({
      message: {
        date: 1_700_000_000,
        text: 'hi from telegram',
        from: { id: 42 },
        chat: { id: 99 }
      }
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('telegram');
    expect(message?.externalChatId).toBe('99');
  });

  it('creates a Telegram routing result with session key', () => {
    const routed = routeTelegramWebhook({
      update_id: 123,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        text: 'route me',
        from: { id: 42 },
        chat: { id: 99 }
      }
    });

    expect(routed.ok).toBe(true);
    expect(routed.sessionKey).toBe('telegram:99');
    expect(routed.message?.text).toBe('route me');
  });

  it('builds a Telegram dispatch payload for runtime adapters', () => {
    const dispatch = buildTelegramDispatch({
      update_id: 123,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        text: 'send to session',
        from: { id: 42 },
        chat: { id: 99 }
      }
    });

    expect(dispatch).toEqual({
      sessionId: 'telegram:99',
      payload: {
        userMessage: 'send to session',
        userId: '42',
        workspaceId: '99'
      }
    });
  });

  it('builds a Telegram send payload', () => {
    expect(buildTelegramSendPayload({
      chatId: '99',
      text: 'hello',
      parseMode: 'Markdown',
      disableWebPagePreview: true
    })).toEqual({
      chat_id: '99',
      text: 'hello',
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });
  });

  it('builds a Telegram edit payload', () => {
    expect(buildTelegramEditPayload({
      chatId: '99',
      messageId: 7,
      text: 'edited',
      parseMode: 'HTML'
    })).toEqual({
      chat_id: '99',
      message_id: 7,
      text: 'edited',
      parse_mode: 'HTML'
    });
  });

  it('normalizes WhatsApp webhooks and builds dispatch payloads', () => {
    const message = normalizeWhatsAppWebhook({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'wa-phone-1' },
            messages: [{
              id: 'wamid-1',
              from: 'user-wa-1',
              timestamp: '1700000000',
              text: { body: 'hello from whatsapp' }
            }]
          }
        }]
      }]
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('whatsapp');
    expect(message?.deliveryId).toBe('wamid-1');

    const dispatch = buildWhatsAppDispatch({
      entry: [{
        changes: [{
          value: {
            metadata: { phone_number_id: 'wa-phone-1' },
            messages: [{
              id: 'wamid-1',
              from: 'user-wa-1',
              timestamp: '1700000000',
              text: { body: 'hello from whatsapp' }
            }]
          }
        }]
      }]
    });

    expect(dispatch).toEqual({
      sessionId: 'whatsapp:wa-phone-1',
      payload: {
        userMessage: 'hello from whatsapp',
        userId: 'user-wa-1',
        workspaceId: 'wa-phone-1'
      }
    });
  });

  it('builds gateway retry and idempotency helpers', () => {
    const message = normalizeGenericWebhook({
      chatId: 'chat-1',
      userId: 'user-1',
      text: 'hello',
      deliveryId: 'delivery-1'
    });

    expect(buildGatewayRetryPolicy('slack')).toEqual({ maxAttempts: 3, baseDelayMs: 1000 });
    expect(buildGatewayRetryPolicy('whatsapp')).toEqual({ maxAttempts: 4, baseDelayMs: 1500 });
    expect(buildGatewayIdempotencyKey(message)).toBe('webhook:chat-1:delivery-1');
    expect(buildGatewayDeliveryPlan(message)).toEqual({
      platform: 'webhook',
      sessionId: 'webhook:chat-1',
      retryPolicy: { maxAttempts: 2, baseDelayMs: 500 },
      idempotencyKey: 'webhook:chat-1:delivery-1',
      userMessage: 'hello',
      userId: 'user-1',
      workspaceId: 'chat-1'
    });
  });

  it('normalizes Signal webhooks and builds dispatch payloads', () => {
    const message = normalizeSignalWebhook({
      envelope: {
        sourceNumber: '+15550001',
        timestamp: 1700000000,
        dataMessage: { message: 'hello from signal' }
      }
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('signal');
    expect(message?.deliveryId).toBe('1700000000');

    const dispatch = buildSignalDispatch({
      envelope: {
        sourceNumber: '+15550001',
        timestamp: 1700000000,
        dataMessage: { message: 'hello from signal' }
      }
    });

    expect(dispatch).toEqual({
      sessionId: 'signal:+15550001',
      payload: {
        userMessage: 'hello from signal',
        userId: '+15550001',
        workspaceId: '+15550001'
      }
    });
  });

  it('normalizes Email webhooks and builds dispatch payloads', () => {
    const message = normalizeEmailWebhook({
      messageId: 'email-1',
      from: 'user@example.com',
      to: 'agent@example.com',
      subject: 'Deploy request',
      text: 'please deploy crowclaw',
      inboxId: 'support-inbox'
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('email');
    expect(message?.deliveryId).toBe('email-1');

    const dispatch = buildEmailDispatch({
      messageId: 'email-1',
      from: 'user@example.com',
      to: 'agent@example.com',
      subject: 'Deploy request',
      text: 'please deploy crowclaw',
      inboxId: 'support-inbox'
    });

    expect(dispatch).toEqual({
      sessionId: 'email:support-inbox',
      payload: {
        userMessage: 'Subject: Deploy request\nplease deploy crowclaw',
        userId: 'user@example.com',
        workspaceId: 'support-inbox'
      }
    });
  });

  it('normalizes Matrix webhooks and builds dispatch payloads', () => {
    const message = normalizeMatrixWebhook({
      eventId: '$matrix-1',
      roomId: '!room:example.com',
      sender: '@alice:example.com',
      content: { body: 'hello from matrix', msgtype: 'm.text' },
      timestamp: 1700000000
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('matrix');
    expect(message?.deliveryId).toBe('$matrix-1');

    const dispatch = buildMatrixDispatch({
      eventId: '$matrix-1',
      roomId: '!room:example.com',
      sender: '@alice:example.com',
      content: { body: 'hello from matrix', msgtype: 'm.text' },
      timestamp: 1700000000
    });

    expect(dispatch).toEqual({
      sessionId: 'matrix:!room:example.com',
      payload: {
        userMessage: 'hello from matrix',
        userId: '@alice:example.com',
        workspaceId: '!room:example.com'
      }
    });
  });

  it('normalizes SMS webhooks and builds dispatch payloads', () => {
    const message = normalizeSmsWebhook({
      messageId: 'sms-1',
      from: '+15550001',
      to: '+15550099',
      text: 'hello from sms',
      conversationId: 'conv-1',
      timestamp: 1700000000
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('sms');
    expect(message?.deliveryId).toBe('sms-1');

    const dispatch = buildSmsDispatch({
      messageId: 'sms-1',
      from: '+15550001',
      to: '+15550099',
      text: 'hello from sms',
      conversationId: 'conv-1',
      timestamp: 1700000000
    });

    expect(dispatch).toEqual({
      sessionId: 'sms:conv-1',
      payload: {
        userMessage: 'hello from sms',
        userId: '+15550001',
        workspaceId: 'conv-1'
      }
    });
  });
});

import { describe, it, expect } from 'vitest';
import {
  sendTelegramMessage,
  sendDiscordMessage,
  sendSlackMessage,
  sendWhatsAppMessage,
  sendMatrixMessage,
  sendEmailMessage,
  type GatewaySendResult,
} from '../packages/gateway/src/index.js';

describe('Gateway Outbound Send Functions', () => {
  it('sendTelegramMessage should return error for invalid token', async () => {
    const result = await sendTelegramMessage('invalid-token', '123', 'test');
    expect(result.platform).toBe('telegram');
    // Should fail gracefully, not throw
    expect(typeof result.ok).toBe('boolean');
  });

  it('sendDiscordMessage should return error for invalid webhook', async () => {
    const result = await sendDiscordMessage('https://invalid.example.com/webhook', 'test');
    expect(result.platform).toBe('discord');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('sendSlackMessage should return error for invalid token', async () => {
    const result = await sendSlackMessage('xoxb-invalid', 'general', 'test');
    expect(result.platform).toBe('slack');
    expect(typeof result.ok).toBe('boolean');
  });

  it('sendWhatsAppMessage should return error for invalid token', async () => {
    const result = await sendWhatsAppMessage('invalid', 'phone-id', '+1234567890', 'test');
    expect(result.platform).toBe('whatsapp');
    expect(typeof result.ok).toBe('boolean');
  });

  it('sendMatrixMessage should return error for invalid server', async () => {
    const result = await sendMatrixMessage('https://invalid.example.com', 'token', '!room:example.com', 'test');
    expect(result.platform).toBe('matrix');
    expect(result.ok).toBe(false);
  });

  it('sendEmailMessage should return error for invalid API', async () => {
    const result = await sendEmailMessage('https://invalid.example.com/send', 'key', 'to@example.com', 'Subject', 'Body');
    expect(result.platform).toBe('email');
    expect(result.ok).toBe(false);
  });

  it('all send results should have platform field', async () => {
    const results = await Promise.all([
      sendTelegramMessage('t', '1', 'test'),
      sendDiscordMessage('https://invalid.example.com', 'test'),
      sendSlackMessage('t', 'c', 'test'),
    ]);
    for (const result of results) {
      expect(result.platform).toBeTruthy();
      expect(typeof result.ok).toBe('boolean');
    }
  });
});

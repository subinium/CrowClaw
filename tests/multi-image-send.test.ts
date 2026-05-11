/**
 * Tests for #328 — native multi-image sending across all channels.
 *
 * Exercises the new `OutgoingMessage` envelope + `buildOutboundMessage` path
 * on each channel adapter. Backward compatibility (single-attachment, no-
 * attachment text) is asserted explicitly on the same call surfaces.
 */
import { describe, expect, it } from 'vitest';
import {
  channels,
  telegramChannel,
  discordChannel,
  slackChannel,
  whatsappChannel,
  signalChannel,
  matrixChannel,
  mattermostChannel,
  dingtalkChannel,
  emailChannel,
  type Attachment,
  type OutgoingMessage,
} from '../packages/gateway/src/index.js';

const image = (url: string, caption?: string): Attachment => ({
  type: 'image',
  url,
  ...(caption ? { caption } : {}),
});

describe('OutgoingMessage shape', () => {
  it('attachments are an array (multi-image contract)', () => {
    const message: OutgoingMessage = {
      text: 'gallery',
      attachments: [image('https://example.com/1.png'), image('https://example.com/2.png')],
    };
    expect(message.attachments).toHaveLength(2);
  });
});

describe('Telegram multi-image (#328)', () => {
  it('single image → sendPhoto with caption', () => {
    const payload = telegramChannel.buildOutboundMessage?.('chat-1', {
      text: 'caption text',
      attachments: [image('https://example.com/a.png')],
    }) as { method: string; chat_id: string; photo: string; caption: string };
    expect(payload.method).toBe('sendPhoto');
    expect(payload.photo).toBe('https://example.com/a.png');
    expect(payload.caption).toBe('caption text');
  });

  it('3 images → sendMediaGroup with photos[]', () => {
    const payload = telegramChannel.buildOutboundMessage?.('chat-1', {
      text: 'gallery',
      attachments: [
        image('https://example.com/1.png'),
        image('https://example.com/2.png'),
        image('https://example.com/3.png'),
      ],
    }) as { method: string; chat_id: string; media: Array<{ type: string; media: string; caption?: string }> };
    expect(payload.method).toBe('sendMediaGroup');
    expect(payload.chat_id).toBe('chat-1');
    expect(payload.media).toHaveLength(3);
    expect(payload.media[0]?.type).toBe('photo');
    expect(payload.media[0]?.media).toBe('https://example.com/1.png');
    expect(payload.media[0]?.caption).toBe('gallery');
    // Caption only on first item per Telegram convention
    expect(payload.media[1]?.caption).toBeUndefined();
  });

  it('caps mediaGroup at 10 images and reports overflow', () => {
    const attachments = Array.from({ length: 12 }, (_, i) =>
      image(`https://example.com/${i}.png`),
    );
    const payload = telegramChannel.buildOutboundMessage?.('chat-1', {
      text: 'big gallery',
      attachments,
    }) as { method: string; media: unknown[]; _overflow?: number };
    expect(payload.method).toBe('sendMediaGroup');
    expect(payload.media).toHaveLength(10);
    expect(payload._overflow).toBe(2);
  });

  it('no attachments → plain sendMessage (backward compat)', () => {
    const payload = telegramChannel.buildOutboundMessage?.('chat-1', {
      text: 'plain hello',
    }) as { method: string; text: string };
    expect(payload.method).toBe('sendMessage');
    expect(payload.text).toBe('plain hello');
  });
});

describe('Discord multi-image (#328)', () => {
  it('multi-image becomes content + embeds[]', () => {
    const payload = discordChannel.buildOutboundMessage?.('chan-1', {
      text: 'gallery',
      attachments: [
        image('https://example.com/1.png'),
        image('https://example.com/2.png'),
        image('https://example.com/3.png'),
      ],
    }) as { content: string; embeds: Array<{ image: { url: string } }> };
    expect(payload.content).toBe('gallery');
    expect(payload.embeds).toHaveLength(3);
    expect(payload.embeds[0]?.image.url).toBe('https://example.com/1.png');
  });

  it('caps embeds at 10 (Discord max) and reports overflow', () => {
    const attachments = Array.from({ length: 13 }, (_, i) =>
      image(`https://example.com/${i}.png`),
    );
    const payload = discordChannel.buildOutboundMessage?.('chan-1', {
      text: 'big gallery',
      attachments,
    }) as { embeds: unknown[]; _overflow?: number };
    expect(payload.embeds).toHaveLength(10);
    expect(payload._overflow).toBe(3);
  });

  it('text-only collapses to {content}', () => {
    const payload = discordChannel.buildOutboundMessage?.('chan-1', { text: 'hello' }) as { content: string };
    expect(payload.content).toBe('hello');
  });
});

describe('Slack multi-image (#328)', () => {
  it('attachments produce multi-step descriptor with thread-key intent', () => {
    const payload = slackChannel.buildOutboundMessage?.('C-1', {
      text: 'gallery',
      attachments: [
        image('https://example.com/1.png'),
        image('https://example.com/2.png'),
      ],
      options: { threadTs: '1234.5678' },
    }) as { kind: string; channel: string; text: string; thread_ts: string; files: Array<{ url: string }> };
    expect(payload.kind).toBe('multi-step');
    expect(payload.channel).toBe('C-1');
    expect(payload.thread_ts).toBe('1234.5678');
    expect(payload.files).toHaveLength(2);
    expect(payload.files[0]?.url).toBe('https://example.com/1.png');
  });

  it('no attachments → legacy single-payload shape (no kind: multi-step)', () => {
    const payload = slackChannel.buildOutboundMessage?.('C-1', { text: 'plain' }) as Record<string, unknown>;
    expect(payload.kind).toBeUndefined();
    expect(payload.channel).toBe('C-1');
    expect(payload.text).toBe('plain');
  });
});

describe('WhatsApp multi-image (#328)', () => {
  it('attachments produce a multi-step descriptor with per-image entries', () => {
    const payload = whatsappChannel.buildOutboundMessage?.('+1555', {
      text: 'gallery',
      attachments: [
        image('https://example.com/1.png', 'first'),
        image('https://example.com/2.png'),
      ],
    }) as { kind: string; to: string; attachments: Array<{ type: string; image?: { link: string; caption?: string } }> };
    expect(payload.kind).toBe('multi-step');
    expect(payload.to).toBe('+1555');
    expect(payload.attachments).toHaveLength(2);
    expect(payload.attachments[0]?.type).toBe('image');
    expect(payload.attachments[0]?.image?.link).toBe('https://example.com/1.png');
    expect(payload.attachments[0]?.image?.caption).toBe('first');
  });

  it('no attachments → legacy text payload', () => {
    const payload = whatsappChannel.buildOutboundMessage?.('+1555', { text: 'plain' }) as { type: string; text: { body: string } };
    expect(payload.type).toBe('text');
    expect(payload.text.body).toBe('plain');
  });
});

describe('Signal multi-image (#328)', () => {
  it('returns array of attachment URLs alongside message body', () => {
    const payload = signalChannel.buildOutboundMessage?.('+15550001', {
      text: 'gallery',
      attachments: [image('https://example.com/1.png'), image('https://example.com/2.png')],
    }) as { recipient: string; message: string; attachments: string[] };
    expect(payload.recipient).toBe('+15550001');
    expect(payload.message).toBe('gallery');
    expect(payload.attachments).toEqual([
      'https://example.com/1.png',
      'https://example.com/2.png',
    ]);
  });
});

describe('Generic destination adapters (#328)', () => {
  const adapters = [
    { name: 'matrix', adapter: matrixChannel },
    { name: 'mattermost', adapter: mattermostChannel },
    { name: 'dingtalk', adapter: dingtalkChannel },
    { name: 'email', adapter: emailChannel },
  ];

  for (const { name, adapter } of adapters) {
    it(`${name} returns text+attachments structure for multi-image sends`, () => {
      const payload = adapter.buildOutboundMessage?.('dest-1', {
        text: 'gallery',
        attachments: [
          image('https://example.com/1.png'),
          { type: 'audio', url: 'https://example.com/a.mp3', mimeType: 'audio/mpeg' },
        ],
      }) as { channelId: string; text: string; attachments: Array<{ url: string; mimeType?: string }> };
      expect(payload.channelId).toBe('dest-1');
      expect(payload.attachments).toHaveLength(2);
      expect(payload.attachments[1]?.mimeType).toBe('audio/mpeg');
    });
  }
});

describe('Backward compatibility', () => {
  it('legacy buildOutbound continues to work alongside buildOutboundMessage', () => {
    // Existing callers using channels.buildOutbound('telegram', '1', 'hi') still work.
    const legacy = channels.buildOutbound('telegram', 'chat-1', 'hi') as { text: string };
    expect(legacy.text).toBe('hi');
  });

  it('channels.buildOutboundMessage falls back to buildOutbound for adapters without buildOutboundMessage', () => {
    // Generic channel adapter does not implement buildOutboundMessage —
    // ensure the fallback still works for callers using the registry helper.
    const payload = channels.buildOutboundMessage('generic', 'any-id', {
      text: 'fallback',
    }) as { text: string };
    expect(payload.text).toBe('fallback');
  });
});

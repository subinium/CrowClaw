import { describe, expect, it } from 'vitest';
import { buildDiscordEditPayload, buildDiscordSendPayload } from '@crowclaw/gateway';

describe('discord outbound payload shaping', () => {
  it('builds a Discord send payload', () => {
    expect(buildDiscordSendPayload({ content: 'hello discord' })).toEqual({
      content: 'hello discord'
    });
  });

  it('builds a Discord edit payload', () => {
    expect(buildDiscordEditPayload({ messageId: '123', content: 'edited discord' })).toEqual({
      messageId: '123',
      content: 'edited discord'
    });
  });
});

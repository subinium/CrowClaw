import { describe, expect, it } from 'vitest';
import {
  buildSlackSignature,
  buildSlackDispatch,
  buildSlackEditPayload,
  buildSlackEditUrl,
  buildSlackSendPayload,
  buildSlackSendUrl,
  normalizeSlackWebhook,
  verifySlackSignature
} from '@crowclaw/gateway';

describe('slack gateway semantics', () => {
  it('normalizes slack event payloads', () => {
    const message = normalizeSlackWebhook({
      type: 'event_callback',
      event: { channel: 'C123', user: 'U123', text: 'deploy crowclaw' }
    });

    expect(message).not.toBeNull();
    expect(message?.platform).toBe('slack');
    expect(message?.channelId).toBe('C123');
    expect(message?.userId).toBe('U123');
  });

  it('builds slack dispatch payloads', () => {
    expect(buildSlackDispatch({
      type: 'event_callback',
      event: { channel: 'C999', user: 'U999', text: 'ship it' }
    })).toEqual({
      sessionId: 'slack:C999',
      payload: {
        userMessage: 'ship it',
        userId: 'U999',
        workspaceId: 'C999'
      }
    });
  });

  it('builds slack outbound payloads and urls', () => {
    expect(buildSlackSendPayload({ channel: 'C1', text: 'hello slack', threadTs: '1700.2' })).toEqual({
      channel: 'C1',
      text: 'hello slack',
      thread_ts: '1700.2'
    });
    expect(buildSlackEditPayload({ channel: 'C1', text: 'edited', ts: '1700.1', threadTs: '1700.2' })).toEqual({
      channel: 'C1',
      text: 'edited',
      ts: '1700.1',
      thread_ts: '1700.2'
    });
    expect(buildSlackSendUrl()).toBe('https://slack.com/api/chat.postMessage');
    expect(buildSlackEditUrl()).toBe('https://slack.com/api/chat.update');
  });

  it('ignores slack url verification payloads at normalization level', () => {
    expect(normalizeSlackWebhook({ type: 'url_verification', challenge: 'abc' })).toBeNull();
  });

  it('builds and verifies slack webhook signatures', async () => {
    const body = JSON.stringify({
      type: 'event_callback',
      event: { channel: 'C123', user: 'U123', text: 'deploy crowclaw' }
    });

    const signature = await buildSlackSignature('secret-1', '1700000000', body);
    await expect(verifySlackSignature({
      signingSecret: 'secret-1',
      timestamp: '1700000000',
      body,
      signature
    })).resolves.toBe(true);

    await expect(verifySlackSignature({
      signingSecret: 'secret-2',
      timestamp: '1700000000',
      body,
      signature
    })).resolves.toBe(false);
  });
});

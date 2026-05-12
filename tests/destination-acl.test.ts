/**
 * Tests for #318 — cross-platform destination allowlist primitive.
 *
 * Covers the shared `DestinationAcl` primitive plus the per-channel
 * `checkAccess` wiring on Slack, Telegram, Matrix, Mattermost, DingTalk,
 * Email, and Signal.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  channels,
  checkDestinationAcl,
  buildAclDeniedEvent,
  emitAclDenied,
  setAclEventSink,
  slackChannel,
  telegramChannel,
  signalChannel,
  matrixChannel,
  mattermostChannel,
  dingtalkChannel,
  emailChannel,
  type AclDeniedEvent,
} from '../packages/gateway/src/index.js';

describe('checkDestinationAcl', () => {
  it('empty allowlist allows all (backward compat)', () => {
    const result = checkDestinationAcl('C0123', { allowedDestinations: [] });
    expect(result).toEqual({ allowed: true, reason: 'open-policy' });
  });

  it('non-empty allowlist requires exact membership', () => {
    const cfg = { allowedDestinations: ['C0123', 'C0999'] };
    expect(checkDestinationAcl('C0123', cfg)).toEqual({ allowed: true, reason: 'allowlisted' });
    expect(checkDestinationAcl('C9999', cfg)).toEqual({ allowed: false, reason: 'not-in-allowlist' });
  });

  it('wildcard entry allows any destination', () => {
    const cfg = { allowedDestinations: ['*'] };
    expect(checkDestinationAcl('any-id', cfg)).toEqual({ allowed: true, reason: 'allowed' });
  });

  it('missing destination with non-empty allowlist is rejected', () => {
    const cfg = { allowedDestinations: ['C0123'] };
    expect(checkDestinationAcl(undefined, cfg)).toEqual({ allowed: false, reason: 'missing-destination' });
  });
});

describe('buildAclDeniedEvent', () => {
  it('emits canonical gateway:acl_denied shape', () => {
    const event = buildAclDeniedEvent({
      platform: 'slack',
      reason: 'not-in-allowlist',
      destinationId: 'C9999',
      senderId: 'U-9',
    });
    expect(event.event).toBe('gateway:acl_denied');
    expect(event.platform).toBe('slack');
    expect(event.reason).toBe('not-in-allowlist');
    expect(event.destinationId).toBe('C9999');
    expect(event.senderId).toBe('U-9');
    expect(event.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('omits undefined optional fields', () => {
    const event = buildAclDeniedEvent({ platform: 'telegram', reason: 'no-guild-id' });
    expect(event.destinationId).toBeUndefined();
    expect(event.senderId).toBeUndefined();
    expect(event.guildId).toBeUndefined();
  });
});

describe('ACL event sink', () => {
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => {
      setAclEventSink(previous);
    };
  });

  it('forwards emitAclDenied calls to the installed sink', () => {
    emitAclDenied(buildAclDeniedEvent({ platform: 'matrix', reason: 'not-in-allowlist' }));
    expect(captured).toHaveLength(1);
    expect(captured[0]?.platform).toBe('matrix');
    restoreSink();
  });

  it('swallows sink errors so inbound dispatch never breaks', () => {
    setAclEventSink(() => { throw new Error('sink boom'); });
    expect(() => emitAclDenied(buildAclDeniedEvent({ platform: 'x', reason: 'y' }))).not.toThrow();
    restoreSink();
  });
});

describe('Slack checkAccess (#318)', () => {
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => {
      setAclEventSink(previous);
    };
  });

  const buildPayload = (channel: string) => ({
    event: { type: 'message', channel, user: 'U-1', text: 'hi', ts: '1.0' },
  });

  it('allows when allowedDestinations is empty', () => {
    const payload = buildPayload('C0123');
    const normalized = slackChannel.normalizeInbound(payload);
    expect(normalized).not.toBeNull();
    const decision = slackChannel.checkAccess?.(payload, normalized!, { allowedDestinations: [] });
    expect(decision?.allowed).toBe(true);
    expect(captured).toHaveLength(0);
    restoreSink();
  });

  it('rejects non-allowlisted Slack channels and emits audit event', () => {
    const payload = buildPayload('C9999');
    const normalized = slackChannel.normalizeInbound(payload);
    const decision = slackChannel.checkAccess?.(payload, normalized!, { allowedDestinations: ['C0123'] });
    expect(decision?.allowed).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.platform).toBe('slack');
    expect(captured[0]?.destinationId).toBe('C9999');
    restoreSink();
  });

  it('allows when channel is in allowlist', () => {
    const payload = buildPayload('C0123');
    const normalized = slackChannel.normalizeInbound(payload);
    const decision = slackChannel.checkAccess?.(payload, normalized!, { allowedDestinations: ['C0123'] });
    expect(decision?.allowed).toBe(true);
    expect(captured).toHaveLength(0);
    restoreSink();
  });
});

describe('Telegram destination ACL (#318)', () => {
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => {
      setAclEventSink(previous);
    };
  });

  it('rejects non-allowlisted Telegram chat and audits event', () => {
    const payload = { message: { chat: { id: 9999 }, from: { id: 1 }, text: 'hi' } };
    const normalized = telegramChannel.normalizeInbound(payload);
    expect(normalized?.channelId).toBe('9999');
    const decision = telegramChannel.checkAccess?.(payload, normalized!, { allowedDestinations: ['123'] });
    expect(decision?.allowed).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.platform).toBe('telegram');
    restoreSink();
  });
});

describe('All destination-ACL channels (#318) reject foreign IDs uniformly', () => {
  const adapters = [
    { name: 'matrix', adapter: matrixChannel },
    { name: 'mattermost', adapter: mattermostChannel },
    { name: 'dingtalk', adapter: dingtalkChannel },
    { name: 'email', adapter: emailChannel },
    { name: 'signal', adapter: signalChannel },
  ];
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => setAclEventSink(previous);
  });

  for (const { name, adapter } of adapters) {
    it(`${name} rejects non-allowlisted destination and emits audit event`, () => {
      const decision = adapter.checkAccess?.(
        {},
        { platform: name, channelId: 'foreign-id', senderId: 'unknown', text: '', raw: {} },
        { allowedDestinations: ['known-id'] },
      );
      expect(decision?.allowed).toBe(false);
      expect(captured.find((e) => e.platform === name)).toBeTruthy();
      restoreSink();
    });

    it(`${name} allow-list passes when destination is permitted`, () => {
      const decision = adapter.checkAccess?.(
        {},
        { platform: name, channelId: 'known-id', senderId: 'who', text: '', raw: {} },
        { allowedDestinations: ['known-id'] },
      );
      expect(decision?.allowed).toBe(true);
      expect(captured.filter((e) => e.platform === name)).toHaveLength(0);
    });
  }
});

describe('channels registry exposes new adapters', () => {
  it('matrix, mattermost, dingtalk, email are registered', () => {
    const names = channels.names();
    expect(names).toContain('matrix');
    expect(names).toContain('mattermost');
    expect(names).toContain('dingtalk');
    expect(names).toContain('email');
  });
});

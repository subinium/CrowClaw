/**
 * v0.9.1 "Sentinel" (#342 / #295): WhatsApp channel ACL enforcement.
 *
 * Proves the adapter-level checkAccess that the webhook ingress now invokes:
 *   - self-chat (echo loop) is always dropped silently when botWaId is known;
 *   - stranger-gating is OPT-IN — an unconfigured channel stays open so a fresh
 *     install is not silently bricked;
 *   - once an allowlist (or explicit allowStrangers) is configured, strangers
 *     are denied and allowlisted contacts pass.
 */

import { describe, expect, it } from 'vitest';
import { whatsappChannel, type NormalizedChannelMessage } from '@crowclaw/gateway';

const msg = (senderId: string): NormalizedChannelMessage => ({
  platform: 'whatsapp',
  channelId: 'wa-phone-1',
  senderId,
  text: 'hello',
  raw: {},
});

const check = (config: unknown, senderId: string) =>
  whatsappChannel.checkAccess!({}, msg(senderId), config);

describe('whatsappChannel.checkAccess — ACL enforcement (#342)', () => {
  it('leaves an UNCONFIGURED channel open (no allowlist, no allowStrangers)', () => {
    const decision = check({}, 'stranger-1');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('unconfigured-open');
  });

  it('denies a stranger once an allowlist is configured', () => {
    const decision = check({ allowedContacts: ['111'] }, '999');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('stranger');
    expect(decision.silentDrop).toBeFalsy();
  });

  it('allows an allowlisted contact', () => {
    const decision = check({ allowedContacts: ['111', '222'] }, '222');
    expect(decision.allowed).toBe(true);
  });

  it('honours a wildcard allowlist', () => {
    expect(check({ allowedContacts: ['*'] }, 'anyone').allowed).toBe(true);
  });

  it('allows everyone when allowStrangers is explicitly true', () => {
    expect(check({ allowStrangers: true }, 'stranger-2').allowed).toBe(true);
  });

  it('engages gating when allowStrangers is explicitly false (denies strangers)', () => {
    const decision = check({ allowStrangers: false }, 'stranger-3');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('stranger');
  });

  it('silently drops self-chat (echo loop) when botWaId matches the sender', () => {
    const decision = check({ botWaId: 'bot-555', allowedContacts: ['111'] }, 'bot-555');
    expect(decision.allowed).toBe(false);
    expect(decision.silentDrop).toBe(true);
    expect(decision.reason).toBe('self-chat');
  });
});

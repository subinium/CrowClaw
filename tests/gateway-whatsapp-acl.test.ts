/**
 * Tests for #295 — WhatsApp stranger + self-chat ban (Hermes v0.13 parity).
 *
 * Stranger DMs and self-chat (echo loop) are now rejected by default; the
 * legacy "respond to anyone" behavior is recovered only via the explicit
 * `allowStrangers: true` knob, which also emits an audit warning.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  checkWhatsAppAcl,
  loadWhatsAppAclConfig,
  whatsappChannel,
  setAclEventSink,
  type AclDeniedEvent,
} from '../packages/gateway/src/index.js';

describe('checkWhatsAppAcl', () => {
  it('rejects strangers by default', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: 'unknown' },
      { allowedContacts: ['friend'], allowStrangers: false },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('stranger');
    expect(decision.silentDrop).toBeFalsy();
  });

  it('allows known contacts', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: 'friend' },
      { allowedContacts: ['friend'], allowStrangers: false },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowlisted');
  });

  it('silently drops self-chat (bot wa_id == sender wa_id)', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: 'bot-wa-id' },
      { allowedContacts: [], allowStrangers: true, botWaId: 'bot-wa-id' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('self-chat');
    expect(decision.silentDrop).toBe(true);
  });

  it('self-chat detection wins over allowStrangers', () => {
    // allowStrangers=true should NOT enable the bot to respond to itself.
    const decision = checkWhatsAppAcl(
      { senderWaId: 'bot' },
      { allowedContacts: [], allowStrangers: true, botWaId: 'bot' },
    );
    expect(decision.silentDrop).toBe(true);
  });

  it('allowStrangers reverts to open-policy', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: 'anyone' },
      { allowedContacts: [], allowStrangers: true },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('open-policy');
  });

  it('missing senderWaId is rejected', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: undefined },
      { allowedContacts: ['friend'] },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('missing-sender');
  });

  it('wildcard in allowedContacts lets anyone through (still drops self-chat)', () => {
    const decision = checkWhatsAppAcl(
      { senderWaId: 'random' },
      { allowedContacts: ['*'], allowStrangers: false, botWaId: 'bot' },
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowlisted');
  });
});

describe('loadWhatsAppAclConfig', () => {
  it('warns when botWaId is missing', () => {
    const warnings: string[] = [];
    const cfg = loadWhatsAppAclConfig({ allowedContacts: ['a'] }, (m) => warnings.push(m));
    expect(cfg.botWaId).toBeUndefined();
    expect(warnings.some((w) => w.includes('botWaId'))).toBe(true);
  });

  it('warns audit-only when allowStrangers is true', () => {
    const warnings: string[] = [];
    const cfg = loadWhatsAppAclConfig(
      { botWaId: 'bot', allowStrangers: true, allowedContacts: [] },
      (m) => warnings.push(m),
    );
    expect(cfg.allowStrangers).toBe(true);
    expect(warnings.some((w) => w.includes('allowStrangers'))).toBe(true);
  });

  it('filters non-string allowedContacts entries', () => {
    const cfg = loadWhatsAppAclConfig({ allowedContacts: ['ok', 42, null, 'also'], botWaId: 'bot' });
    expect(cfg.allowedContacts).toEqual(['ok', 'also']);
  });

  it('returns deny-stranger defaults when raw is missing', () => {
    const cfg = loadWhatsAppAclConfig(undefined);
    expect(cfg.allowedContacts).toEqual([]);
    expect(cfg.allowStrangers).toBe(false);
  });
});

describe('whatsappChannel.checkAccess integration', () => {
  let captured: AclDeniedEvent[] = [];
  let restoreSink: () => void = () => {};

  beforeEach(() => {
    captured = [];
    const previous = setAclEventSink((event) => captured.push(event));
    restoreSink = () => setAclEventSink(previous);
  });

  const buildPayload = (from: string) => ({
    entry: [{
      changes: [{
        value: {
          metadata: { phone_number_id: 'bot-pn' },
          messages: [{ id: 'wa-1', from, timestamp: '1700000000', text: { body: 'hi' } }],
        },
      }],
    }],
  });

  it('rejects strangers and emits gateway:acl_denied', () => {
    const payload = buildPayload('stranger');
    const normalized = whatsappChannel.normalizeInbound(payload);
    const decision = whatsappChannel.checkAccess?.(payload, normalized!, {
      allowedContacts: ['friend'],
      allowStrangers: false,
    });
    expect(decision?.allowed).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.platform).toBe('whatsapp');
    expect(captured[0]?.reason).toBe('stranger');
    restoreSink();
  });

  it('silent-drops self-chat and never audits', () => {
    const payload = buildPayload('bot-wa-id');
    const normalized = whatsappChannel.normalizeInbound(payload);
    const decision = whatsappChannel.checkAccess?.(payload, normalized!, {
      allowedContacts: [],
      allowStrangers: true,
      botWaId: 'bot-wa-id',
    });
    expect(decision?.allowed).toBe(false);
    expect(decision?.silentDrop).toBe(true);
    // No audit event for silent-drop self-chat
    expect(captured).toHaveLength(0);
    restoreSink();
  });

  it('allows known contacts without emitting events', () => {
    const payload = buildPayload('friend');
    const normalized = whatsappChannel.normalizeInbound(payload);
    const decision = whatsappChannel.checkAccess?.(payload, normalized!, {
      allowedContacts: ['friend'],
    });
    expect(decision?.allowed).toBe(true);
    expect(captured).toHaveLength(0);
    restoreSink();
  });
});

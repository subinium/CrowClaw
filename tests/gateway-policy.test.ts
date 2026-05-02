import { describe, it, expect } from 'vitest';
import {
  evaluateAccess,
  createDefaultAccessPolicy,
  generatePairingCode,
  approvePairing,
  canMutateToken,
  createDefaultEndpointPolicy,
  evaluateGatewayEndpointPolicy,
  type NormalizedInboundMessage,
  type ChannelAccessPolicy,
  type PairingChallenge,
} from '../packages/gateway/src/index.js';

function mockMessage(overrides?: Partial<NormalizedInboundMessage>): NormalizedInboundMessage {
  return {
    platform: 'telegram',
    channelId: 'chat-123',
    userId: 'user-456',
    text: 'hello',
    raw: {},
    receivedAt: new Date().toISOString(),
    externalChatId: 'chat-123',
    externalUserId: 'user-456',
    ...overrides,
  };
}

describe('Gateway Access Policy', () => {
  it('generatePairingCode should return 8 character code', () => {
    const code = generatePairingCode();
    expect(code.length).toBe(8);
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]+$/); // No O/0/I/1
  });

  it('createDefaultAccessPolicy should return pairing DM + open group', () => {
    const policy = createDefaultAccessPolicy();
    expect(policy.dmPolicy).toBe('pairing');
    expect(policy.groupPolicy).toBe('open');
    expect(policy.allowlist).toEqual([]);
  });

  describe('DM Policy', () => {
    it('open policy should allow all', () => {
      const policy = createDefaultAccessPolicy();
      policy.dmPolicy = 'open';
      const result = evaluateAccess(mockMessage(), policy, false, new Map());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('open-policy');
    });

    it('disabled policy should deny all', () => {
      const policy = createDefaultAccessPolicy();
      policy.dmPolicy = 'disabled';
      const result = evaluateAccess(mockMessage(), policy, false, new Map());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('disabled');
    });

    it('allowlist policy should deny unknown senders', () => {
      const policy = createDefaultAccessPolicy();
      policy.dmPolicy = 'allowlist';
      policy.allowlist = ['other-user'];
      const result = evaluateAccess(mockMessage(), policy, false, new Map());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('not-in-allowlist');
    });

    it('allowlist policy should allow listed senders', () => {
      const policy = createDefaultAccessPolicy();
      policy.dmPolicy = 'allowlist';
      policy.allowlist = ['user-456'];
      const result = evaluateAccess(mockMessage(), policy, false, new Map());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('allowlisted');
    });

    it('pairing policy should generate code for unknown senders', () => {
      const policy = createDefaultAccessPolicy();
      const pending = new Map<string, PairingChallenge>();
      const result = evaluateAccess(mockMessage(), policy, false, pending);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('pairing-required');
      expect(result.pairingCode).toBeTruthy();
      expect(result.pairingCode!.length).toBe(8);
    });

    it('pairing policy should allow already-listed senders', () => {
      const policy = createDefaultAccessPolicy();
      policy.allowlist = ['user-456'];
      const result = evaluateAccess(mockMessage(), policy, false, new Map());
      expect(result.allowed).toBe(true);
      expect(result.reason).toBe('allowlisted');
    });
  });

  describe('Group Policy', () => {
    it('open group policy should allow all', () => {
      const policy = createDefaultAccessPolicy();
      const result = evaluateAccess(mockMessage(), policy, true, new Map());
      expect(result.allowed).toBe(true);
    });

    it('disabled group policy should deny all', () => {
      const policy = createDefaultAccessPolicy();
      policy.groupPolicy = 'disabled';
      const result = evaluateAccess(mockMessage(), policy, true, new Map());
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('group-disabled');
    });

    it('allowlist group policy should check group ID', () => {
      const policy = createDefaultAccessPolicy();
      policy.groupPolicy = 'allowlist';
      policy.groupAllowlist = ['chat-123'];
      const result = evaluateAccess(mockMessage(), policy, true, new Map());
      expect(result.allowed).toBe(true);
    });
  });

  describe('Pairing Approval', () => {
    it('should approve valid code and add to allowlist', () => {
      const policy = createDefaultAccessPolicy();
      const pending = new Map<string, PairingChallenge>();
      // Generate a pairing first
      const accessResult = evaluateAccess(mockMessage(), policy, false, pending);
      expect(accessResult.pairingCode).toBeTruthy();

      const approveResult = approvePairing(pending, accessResult.pairingCode!, policy);
      expect(approveResult.approved).toBe(true);
      expect(approveResult.senderId).toBe('user-456');
      expect(policy.allowlist).toContain('user-456');
    });

    it('should reject invalid code', () => {
      const policy = createDefaultAccessPolicy();
      const pending = new Map<string, PairingChallenge>();
      const result = approvePairing(pending, 'INVALIDCODE', policy);
      expect(result.approved).toBe(false);
    });
  });
});

describe('Gateway Endpoint Policy', () => {
  it('balanced default allows safe http/https POST endpoints', () => {
    const decision = evaluateGatewayEndpointPolicy(
      { url: 'https://discord.com/api/webhooks/123/token', method: 'POST' },
      createDefaultEndpointPolicy('balanced'),
    );
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('allowed');
    expect(decision.observability).toMatchObject({
      event: 'gateway:endpoint_policy',
      reason: 'allowed',
      method: 'POST',
      policyTier: 'balanced',
    });
  });

  it('restricted tier refuses protocol or method violations with an event reason', () => {
    const httpDecision = evaluateGatewayEndpointPolicy(
      { url: 'http://discord.com/api/webhooks/123/token', method: 'POST' },
      { policyTier: 'restricted' },
    );
    expect(httpDecision.allowed).toBe(false);
    expect(httpDecision.reason).toBe('disallowed-protocol');
    expect(httpDecision.observability.reason).toBe('disallowed-protocol');

    const deleteDecision = evaluateGatewayEndpointPolicy(
      { url: 'https://discord.com/api/webhooks/123/token', method: 'DELETE' },
      { policyTier: 'restricted' },
    );
    expect(deleteDecision.allowed).toBe(false);
    expect(deleteDecision.reason).toBe('disallowed-method');
  });

  it('optional paths narrow endpoint access', () => {
    const allowed = evaluateGatewayEndpointPolicy(
      { url: 'https://example.com/webhooks/telegram', method: 'POST' },
      { policyTier: 'balanced', paths: ['/webhooks/*'] },
    );
    expect(allowed.allowed).toBe(true);

    const denied = evaluateGatewayEndpointPolicy(
      { url: 'https://example.com/admin/token', method: 'POST' },
      { policyTier: 'balanced', paths: ['/webhooks/*'] },
    );
    expect(denied.allowed).toBe(false);
    expect(denied.reason).toBe('disallowed-path');
  });

  it('keeps SSRF blocking observable through endpoint policy', () => {
    const decision = evaluateGatewayEndpointPolicy(
      { url: 'https://127.0.0.1/webhook', method: 'POST' },
      { policyTier: 'open' },
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe('unsafe-url');
  });
});

describe('Gateway Token Scope Containment', () => {
  it('does not allow pairing-only callers to mutate owner-scoped tokens', () => {
    expect(canMutateToken('pairing', 'owner')).toBe(false);
    expect(canMutateToken('pairing', 'operator')).toBe(false);
  });

  it('allows callers to mutate only same-or-lower token scopes', () => {
    expect(canMutateToken('owner', 'operator')).toBe(true);
    expect(canMutateToken('operator', 'pairing')).toBe(true);
    expect(canMutateToken('operator', 'owner')).toBe(false);
  });
});

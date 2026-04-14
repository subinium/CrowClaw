import { describe, it, expect } from 'vitest';
import { sanitizeConfigMutation } from '../packages/runtime-node/src/index.js';

describe('sanitizeConfigMutation', () => {
  describe('allows safe config fields', () => {
    it('allows name field', () => {
      expect(sanitizeConfigMutation({ name: 'my-agent' })).toBeNull();
    });

    it('allows model field', () => {
      expect(sanitizeConfigMutation({ model: 'claude-3-opus' })).toBeNull();
    });

    it('allows systemPrompt field', () => {
      expect(sanitizeConfigMutation({ systemPrompt: 'You are helpful' })).toBeNull();
    });

    it('allows multiple safe fields at once', () => {
      expect(sanitizeConfigMutation({
        name: 'my-agent',
        model: 'claude-3-opus',
        systemPrompt: 'You are helpful',
      })).toBeNull();
    });
  });

  describe('blocks sensitive top-level fields', () => {
    it('blocks apiKey mutation', () => {
      const result = sanitizeConfigMutation({ apiKey: 'sk-secret' });
      expect(result).toBe('apiKey');
    });

    it('blocks dashboardToken mutation', () => {
      const result = sanitizeConfigMutation({ dashboardToken: 'tok-secret' });
      expect(result).toBe('dashboardToken');
    });
  });

  describe('blocks nested securityPolicy fields', () => {
    it('blocks securityPolicy.blockDangerousCommands', () => {
      const result = sanitizeConfigMutation({
        securityPolicy: { blockDangerousCommands: false },
      });
      expect(result).toBe('securityPolicy.blockDangerousCommands');
    });

    it('blocks securityPolicy.redactCredentials', () => {
      const result = sanitizeConfigMutation({
        securityPolicy: { redactCredentials: false },
      });
      expect(result).toBe('securityPolicy.redactCredentials');
    });
  });

  describe('returns the blocked field name', () => {
    it('returns apiKey when apiKey is in the body', () => {
      expect(sanitizeConfigMutation({ apiKey: 'x', name: 'ok' })).toBe('apiKey');
    });

    it('returns the first blocked field encountered', () => {
      const result = sanitizeConfigMutation({
        name: 'safe',
        dashboardToken: 'blocked',
      });
      expect(result).toBe('dashboardToken');
    });

    it('returns null when no blocked fields are present', () => {
      expect(sanitizeConfigMutation({ description: 'A helpful agent' })).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('handles empty body', () => {
      expect(sanitizeConfigMutation({})).toBeNull();
    });

    it('does not block safe nested objects that are not securityPolicy', () => {
      expect(sanitizeConfigMutation({
        settings: { theme: 'dark', language: 'en' },
      })).toBeNull();
    });
  });
});

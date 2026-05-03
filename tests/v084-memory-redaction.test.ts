/**
 * v0.8.4 (#184) — Memory delete UX coverage.
 *
 * Confirms the redaction-confidence helper used by the dashboard's Memory
 * tab returns the right level for known patterns, including:
 *
 *   - backend-attested redactions (`metadata.redactedTypes`) take priority
 *   - placeholder strings (e.g. `[API_KEY_REDACTED]`) flag the row even
 *     when the metadata is empty
 *   - client-side regexes catch credentials/PII the backend missed
 *   - clean text returns 'low' so the indicator shows green
 *
 * The bulk-multi-select wiring is exercised at the DOM level by the build
 * (Lit template + checkbox state) and at runtime by the dashboard; the
 * helper-level test here is the load-bearing piece because the indicator
 * is the new contract this issue introduces.
 */
import { describe, expect, it } from 'vitest';
import { assessRedaction } from '../packages/web/ui/src/views/settings-view.js';

describe('v0.8.4 #184 — memory redaction confidence', () => {
  it('returns low for clean recall text with no metadata', () => {
    const r = assessRedaction({ value: 'User likes dark mode and prefers vim keybindings.' });
    expect(r.level).toBe('low');
    expect(r.reasons).toEqual([]);
    expect(r.backendRedacted).toBe(false);
  });

  it('returns medium when backend reports an email redaction', () => {
    const r = assessRedaction({
      value: 'Contact preference: [EMAIL_REDACTED]',
      metadata: { redactedTypes: ['email'], redactedCount: 1 },
    });
    expect(r.level).toBe('medium');
    expect(r.reasons).toContain('email');
    expect(r.backendRedacted).toBe(true);
  });

  it('returns high when backend reports a credential redaction (api_key)', () => {
    const r = assessRedaction({
      value: 'Stored token: [API_KEY_REDACTED]',
      metadata: { redactedTypes: ['api_key'], redactedCount: 1 },
    });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('api_key');
    expect(r.backendRedacted).toBe(true);
  });

  it('returns high when raw API key text is present (client-side regex catch)', () => {
    const r = assessRedaction({
      value: 'sk-abcd1234567890ABCDEF1234567890abcd is the key',
    });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('api_key');
  });

  it('returns high when raw AWS key text is present', () => {
    const r = assessRedaction({ value: 'AKIAABCDEFGHIJKLMNOP rotated yesterday' });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('aws_key');
  });

  it('returns high when private-key block is present', () => {
    const r = assessRedaction({
      value: '-----BEGIN RSA PRIVATE KEY-----\nMIIE...\n-----END RSA PRIVATE KEY-----',
    });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('private_key');
  });

  it('returns medium when only an email is detected client-side', () => {
    const r = assessRedaction({ value: 'Reachable at jane.doe@example.com on Tuesdays' });
    expect(r.level).toBe('medium');
    expect(r.reasons).toContain('email');
    expect(r.backendRedacted).toBe(false);
  });

  it('returns medium when a phone number is detected client-side', () => {
    const r = assessRedaction({ value: 'Backup contact: 415-555-0123 — voicemail ok' });
    expect(r.level).toBe('medium');
    expect(r.reasons).toContain('phone_us');
  });

  it('elevates to high if both an email and a credential are present', () => {
    const r = assessRedaction({
      value: 'Email jane@example.com and token sk-abcd1234567890ABCDEF1234567890abcd',
    });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('email');
    expect(r.reasons).toContain('api_key');
  });

  it('treats placeholder-only text as medium even with empty metadata', () => {
    const r = assessRedaction({ value: 'Last seen: [EMAIL_REDACTED]' });
    expect(r.level).toBe('medium');
    expect(r.backendRedacted).toBe(true);
  });

  it('does not falsely flag short numeric strings as credit cards', () => {
    const r = assessRedaction({ value: 'Run id 1234, ticket 5678' });
    expect(r.level).toBe('low');
  });

  it('treats password assignment as a high-severity reason', () => {
    const r = assessRedaction({ value: 'config.password=hunter2' });
    expect(r.level).toBe('high');
    expect(r.reasons).toContain('password_assignment');
  });

  it('returns medium when backend reports an unknown redaction type', () => {
    const r = assessRedaction({
      value: 'Stored note: [REDACTED]',
      metadata: { redactedTypes: ['custom_org_id'], redactedCount: 1 },
    });
    // unknown type falls into the "medium" bucket (not in HIGH_TYPES)
    expect(r.level).toBe('medium');
    expect(r.reasons).toContain('custom_org_id');
    expect(r.backendRedacted).toBe(true);
  });
});

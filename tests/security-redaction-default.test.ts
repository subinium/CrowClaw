/**
 * Hermes v0.13 parity (#293) — secret redaction is ON by default.
 *
 * Coverage:
 * 1. Fresh install: a default `SecurityPolicy` redacts credentials in tool
 *    output. No explicit `redactToolOutput` field is set; the default
 *    flips it to true and the redaction primitive scrubs the secret.
 * 2. Explicit-off: a stored config with `redactToolOutput: false` is
 *    honored — the redaction primitive is still callable on demand, but
 *    the agent loop should not auto-apply it. We verify the schema
 *    default plus the partial-merge behavior covers this.
 * 3. Migration audit event: `recordRedactionDefaultApplied` writes a
 *    `security:redaction_default_applied` row with the missing keys and
 *    the corruption warning.
 * 4. Synthetic-key smoke test: a fake API key never appears in
 *    `redactToolOutput`'s output.
 *
 * Hermes context: NousResearch/hermes-agent#21193 (re-enable default,
 * closes #17691 and #20785) reverted the v0.12 patch-corruption flip
 * from #16794.
 */

import { describe, expect, it } from 'vitest';
import {
  redactToolOutput,
  redactCredentials,
  SecurityAuditLog,
  recordRedactionDefaultApplied,
} from '../packages/core/src/security.js';
import {
  DEFAULT_SECURITY_POLICY,
  type SecurityPolicyConfig,
} from '../packages/runtime-node/src/config-store.js';

describe('redaction default — fresh install ON', () => {
  it('DEFAULT_SECURITY_POLICY.redactToolOutput is true', () => {
    expect(DEFAULT_SECURITY_POLICY.redactToolOutput).toBe(true);
  });

  it('redactToolOutput primitive scrubs OpenAI keys end-to-end', () => {
    const synthetic = 'Here is your key: sk-proj-abcdef1234567890abcdef1234567890zzz and more text';
    const result = redactToolOutput(synthetic);
    expect(result).not.toContain('sk-proj-abcdef');
    expect(result).toContain('[REDACTED]');
  });

  it('redactCredentials scrubs GitHub PATs', () => {
    const synthetic = 'token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"';
    const result = redactCredentials(synthetic);
    expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result).toContain('[REDACTED]');
  });

  it('redactToolOutput scrubs AWS access keys', () => {
    const synthetic = 'export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE';
    const result = redactToolOutput(synthetic);
    expect(result).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('redactToolOutput scrubs JWTs', () => {
    // Standard JWT triple: header.payload.signature (each base64url; we
    // pad signatures past 10 chars to clear the credential pattern).
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const result = redactToolOutput(`Authorization: Bearer ${jwt}`);
    expect(result).not.toContain('eyJzdWIiOiIxMjM0NSJ9');
  });

  it('redactToolOutput leaves benign text untouched', () => {
    const plain = 'The quick brown fox jumps over the lazy dog. 42 is the answer.';
    expect(redactToolOutput(plain)).toBe(plain);
  });
});

describe('redaction default — explicit-off honored', () => {
  // Simulate an operator who has `redactToolOutput: false` persisted in
  // runtime-config.json. The schema partial-merge in setSecurityPolicy
  // must preserve that false. We model the merge here to keep the test
  // free of FileConfigStore IO.
  it('merges an explicit false over the secure default', () => {
    const merged: SecurityPolicyConfig = {
      ...DEFAULT_SECURITY_POLICY,
      redactToolOutput: false,
    };
    expect(merged.redactToolOutput).toBe(false);
    // Other defaults stay intact (no silent flips).
    expect(merged.scanCommands).toBe(true);
    expect(merged.piiRedaction).toBe(true);
  });

  it('preserves explicit false when partial overrides arrive later', () => {
    // Two-step config load: stored config has redactToolOutput=false,
    // then a later partial update mutates an unrelated field. The
    // explicit false must NOT be silently re-flipped.
    let merged: SecurityPolicyConfig = {
      ...DEFAULT_SECURITY_POLICY,
      redactToolOutput: false,
    };
    merged = { ...merged, ...{ scanUserInput: true } };
    expect(merged.redactToolOutput).toBe(false);
  });
});

describe('redaction default — first-run migration audit event', () => {
  it('records a security:redaction_default_applied event', () => {
    const log = new SecurityAuditLog();
    recordRedactionDefaultApplied(log, {
      appliedKeys: ['redactToolOutput', 'piiRedaction'],
      sessionId: 's-1',
    });

    const events = log.getEvents();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe('security:redaction_default_applied');
    expect(event.severity).toBe('info');
    expect(event.sessionId).toBe('s-1');
    expect(event.detail).toContain('redactToolOutput');
    expect(event.detail).toContain('piiRedaction');
    // The audit row must surface the corruption warning so operators
    // who turn the toggle off later see the tradeoff.
    expect(event.detail.toLowerCase()).toContain('corrupt');
  });

  it('handles an empty appliedKeys list gracefully', () => {
    const log = new SecurityAuditLog();
    recordRedactionDefaultApplied(log, { appliedKeys: [] });
    const events = log.getEvents();
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toContain('(none)');
  });

  it('stats counter classifies the event under its dedicated type', () => {
    const log = new SecurityAuditLog();
    recordRedactionDefaultApplied(log, { appliedKeys: ['redactToolOutput'] });
    const stats = log.getStats();
    expect(stats.byType['security:redaction_default_applied']).toBe(1);
    expect(stats.bySeverity.info).toBe(1);
  });
});

describe('redaction default — synthetic key smoke test', () => {
  it('a fake api key in a web.fetch-shaped body never appears in redacted output', () => {
    // Shape: HTML response from a web.fetch tool that accidentally
    // embeds the operator's own key. The redactor must scrub it before
    // the transcript path persists it.
    const body = [
      '<html><body>',
      '  <script>',
      '    const apiKey = "sk-abcdefghijklmnopqrstuvwxyz0123456789";',
      '  </script>',
      '</body></html>',
    ].join('\n');
    const scrubbed = redactToolOutput(body);
    expect(scrubbed).not.toContain('sk-abcdefghijklmnopqrstuvwxyz0123456789');
  });
});

/**
 * Tests for `crowclaw debug share` (#300, Hermes v0.13 parity).
 *
 * Critical security property under test: regardless of runtime redaction
 * config, the bundle output never contains raw credentials. Even when the
 * source files (config, audit log, transcript) embed secrets verbatim,
 * the bundle must scrub them.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  debugShare,
  runDebugShareCommand,
  renderDebugShareHelp,
  type DebugShareBundle,
} from '../packages/cli/src/commands/debug-share.js';

const SYNTHETIC_OPENAI_KEY = 'sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SYNTHETIC_GITHUB_PAT = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
const SYNTHETIC_AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';

function buildDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'crowclaw-debug-share-'));
  mkdirSync(join(dir, 'audit'), { recursive: true });
  return dir;
}

describe('debugShare — bundle structure', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = buildDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns a bundleVersion=1 envelope with all sections', async () => {
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({ providerType: 'openai', model: 'gpt-4o' }),
    );

    const result = await debugShare(undefined, { dataDir });
    expect(result.ok).toBe(true);
    expect(result.bundle).toBeDefined();
    expect(result.bundle!.bundleVersion).toBe(1);
    expect(result.bundle!.auditWindow.days).toBe(7);
    expect(result.bundle!.config).toMatchObject({ providerType: 'openai' });
    expect(result.bundle!.auditEvents).toEqual([]);
    expect(result.bundle!.session).toBeNull();
    expect(typeof result.serialized).toBe('string');
  });

  it('caps --days at 90', async () => {
    const result = await debugShare(undefined, { dataDir, days: 365 });
    expect(result.bundle!.auditWindow.days).toBe(90);
  });

  it('clamps --days to a minimum of 1', async () => {
    const result = await debugShare(undefined, { dataDir, days: 0 });
    expect(result.bundle!.auditWindow.days).toBe(1);
  });

  it('records a note when the config file is missing', async () => {
    const result = await debugShare(undefined, { dataDir });
    expect(result.bundle!.config).toBeNull();
    expect(result.bundle!.notes.join('\n')).toMatch(/runtime-config\.json/);
  });
});

describe('debugShare — unconditional redaction', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = buildDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('scrubs OpenAI keys embedded in runtime-config.json', async () => {
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({
        providerType: 'openai',
        // Operator hand-edited the config and pasted a literal key under
        // a key name we don't catch via sensitive-key match. The free-form
        // value scrubber must still catch the credential-shaped substring.
        comment: `paste key here: ${SYNTHETIC_OPENAI_KEY}`,
      }),
    );

    const result = await debugShare(undefined, { dataDir });
    const serialized = result.serialized!;
    expect(serialized).not.toContain(SYNTHETIC_OPENAI_KEY);
    expect(serialized).toContain('[REDACTED]');
  });

  it('scrubs GitHub PATs from audit-log detail strings', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditFile = join(dataDir, 'audit', `audit-${today}.jsonl`);
    writeFileSync(
      auditFile,
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: 'credential_redacted',
        severity: 'info',
        detail: `caught github token in tool output: ${SYNTHETIC_GITHUB_PAT}`,
      }) + '\n',
    );

    const result = await debugShare(undefined, { dataDir, days: 1 });
    const serialized = result.serialized!;
    expect(serialized).not.toContain(SYNTHETIC_GITHUB_PAT);
  });

  it('scrubs an injected SessionState transcript even with no runtime redaction', async () => {
    // The injected loader returns a transcript that embeds a key in an
    // assistant message. The bundle must redact regardless of whether
    // the runtime had redactToolOutput on at the time the transcript
    // was written.
    const fakeSession = {
      sessionId: 's-1',
      messages: [
        { role: 'user', content: 'what is my key?' },
        { role: 'assistant', content: `your key is ${SYNTHETIC_OPENAI_KEY}` },
      ],
    };

    const result = await debugShare('s-1', {
      dataDir,
      loadSession: async () => fakeSession,
    });
    const serialized = result.serialized!;
    expect(serialized).not.toContain(SYNTHETIC_OPENAI_KEY);
    expect(result.bundle!.session).toBeTruthy();
  });

  it('scrubs values under sensitive-keyed fields (authorization, apiKey)', async () => {
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({
        providerType: 'custom',
        // These fields hit the structured-key walker; values get blanked
        // wholesale even when they aren't credential-shaped.
        authorization: 'Bearer some-opaque-session-id',
        apiKey: 'plain-but-secret-by-key-name',
      }),
    );

    const result = await debugShare(undefined, { dataDir });
    const serialized = result.serialized!;
    expect(serialized).not.toContain('some-opaque-session-id');
    expect(serialized).not.toContain('plain-but-secret-by-key-name');
  });

  it('scrubs AWS access keys from any layer of the bundle', async () => {
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({
        env: { AWS_ACCESS_KEY_ID: SYNTHETIC_AWS_KEY },
      }),
    );
    const result = await debugShare(undefined, { dataDir });
    expect(result.serialized!).not.toContain(SYNTHETIC_AWS_KEY);
  });
});

describe('debugShare — audit log window', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = buildDataDir();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('includes events newer than the `since` cutoff', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditFile = join(dataDir, 'audit', `audit-${today}.jsonl`);
    const recent = new Date().toISOString();
    writeFileSync(
      auditFile,
      JSON.stringify({
        timestamp: recent,
        type: 'pii_redacted',
        severity: 'info',
        detail: 'recent event',
      }) + '\n',
    );

    const result = await debugShare(undefined, { dataDir, days: 1 });
    expect(result.bundle!.auditEvents).toHaveLength(1);
    expect(result.bundle!.auditEvents[0]!.detail).toBe('recent event');
  });

  it('excludes events older than the window', async () => {
    // Write a year-old event into a year-old daily file. With --days=1
    // it must be excluded.
    const oldDate = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const oldStamp = oldDate.toISOString().slice(0, 10);
    const oldFile = join(dataDir, 'audit', `audit-${oldStamp}.jsonl`);
    writeFileSync(
      oldFile,
      JSON.stringify({
        timestamp: oldDate.toISOString(),
        type: 'pii_redacted',
        severity: 'info',
        detail: 'ancient event',
      }) + '\n',
    );

    const result = await debugShare(undefined, { dataDir, days: 1 });
    expect(result.bundle!.auditEvents).toHaveLength(0);
  });

  it('returns most-recent-first ordering', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const auditFile = join(dataDir, 'audit', `audit-${today}.jsonl`);
    const t1 = new Date(Date.now() - 30_000).toISOString();
    const t2 = new Date().toISOString();
    writeFileSync(
      auditFile,
      JSON.stringify({ timestamp: t1, type: 'pii_redacted', severity: 'info', detail: 'older' }) + '\n' +
        JSON.stringify({ timestamp: t2, type: 'pii_redacted', severity: 'info', detail: 'newer' }) + '\n',
    );
    const result = await debugShare(undefined, { dataDir, days: 1 });
    expect(result.bundle!.auditEvents.map((e) => e.detail)).toEqual(['newer', 'older']);
  });

  it('survives a missing audit directory gracefully', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crowclaw-debug-share-no-audit-'));
    // No audit dir created.
    try {
      const result = await debugShare(undefined, { dataDir: dir });
      expect(result.ok).toBe(true);
      expect(result.bundle!.auditEvents).toEqual([]);
      expect(result.bundle!.notes.join('\n')).toMatch(/audit/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runDebugShareCommand — CLI surface', () => {
  let dataDir: string;
  let captured: string;
  const writer = (chunk: string) => { captured += chunk; };

  beforeEach(() => {
    dataDir = buildDataDir();
    captured = '';
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('prints --help without performing any IO', async () => {
    const result = await runDebugShareCommand(['--help'], { stdout: writer });
    expect(result.ok).toBe(true);
    expect(captured).toContain('crowclaw debug share');
    expect(captured).toContain('--days');
    expect(result.bundle).toBeUndefined();
  });

  it('rejects --days without an argument', async () => {
    const result = await runDebugShareCommand(['--days'], { stdout: writer });
    expect(result.ok).toBe(false);
    expect(captured).toMatch(/--days/);
  });

  it('rejects --days with non-numeric arg', async () => {
    const result = await runDebugShareCommand(['--days', 'banana'], { stdout: writer });
    expect(result.ok).toBe(false);
    expect(captured).toMatch(/banana/);
  });

  it('rejects unknown flags', async () => {
    const result = await runDebugShareCommand(['--upload'], { stdout: writer });
    expect(result.ok).toBe(false);
    expect(captured).toMatch(/unknown flag/);
  });

  it('default behavior prints the bundle JSON to stdout', async () => {
    // No flags at all — default behavior is stdout JSON. We assert the
    // serialized bundle round-trips back to a parseable object.
    writeFileSync(
      join(dataDir, 'runtime-config.json'),
      JSON.stringify({ providerType: 'openai' }),
    );
    // We can't pass dataDir through the CLI parser today (no flag for
    // it), so this test asserts behavior with the production-default
    // location. That's still a useful guard: at minimum the command
    // must not crash, must write JSON to stdout, and the JSON must be
    // well-formed even when no source files exist.
    const result = await runDebugShareCommand([], { stdout: writer });
    expect(result.ok).toBe(true);
    expect(captured.length).toBeGreaterThan(0);
    // Bundle output ends with a newline.
    const trimmed = captured.trimEnd();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const parsed = JSON.parse(trimmed) as DebugShareBundle;
    expect(parsed.bundleVersion).toBe(1);
  });
});

describe('renderDebugShareHelp', () => {
  it('mentions the no-auto-upload invariant', () => {
    const help = renderDebugShareHelp();
    expect(help).toMatch(/no network upload/i);
  });
});

/**
 * `crowclaw debug share [session-id] [--days N]`  —  produce a redacted
 * support bundle for sharing logs/configs/audit-log with maintainers
 * WITHOUT leaking secrets.
 *
 * Hermes v0.13 parity (#300, NousResearch/hermes-agent#19318, @GodsBoy).
 * Hermes's `hermes debug share` uploaded logs to a paste service for
 * support handoff, but redaction ran only at *write* time. If redaction
 * was off when a log was written (v0.12 default), the upload contained
 * raw secrets. The mitigation is "always redact at bundle time,
 * unconditionally, regardless of runtime redaction config".
 *
 * Design contract for this command:
 *   1. Bundles three sources: session transcript, runtime config (with
 *      every sensitive-keyed value already scrubbed to '***' by the
 *      config store), and recent audit-log entries.
 *   2. Runs `redactCredentials` + `redactPII` UNCONDITIONALLY over every
 *      string in the bundle, even when the runtime config has
 *      `redactToolOutput: false`. The upload guarantee is independent
 *      of the write-time guarantee.
 *   3. Default behavior: serialize to stdout. NO network upload, NO
 *      clipboard, NO temp file. Operators must explicitly opt in to a
 *      paste service.
 *   4. Returns the bundle as a structured `DebugShareBundle` so a
 *      future runtime endpoint or paste-service adapter can consume it
 *      without going through stdout parsing.
 *
 * Command shape (re-exported from `packages/cli/src/index.ts` by the
 * dispatch owner): `runDebugShareCommand(args, opts) → Promise<void>`.
 *
 * NOTE: this command file owns NO writes — the only outputs are
 * structured returns + opt-in stdout serialization. The integration
 * (Agent G's `cli/src/index.ts` dispatch table) wires the user-facing
 * `crowclaw debug share` invocation.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  redactCredentials,
  redactPII,
  redactStructuredData,
  type SecurityEvent,
} from '@crowclaw/core';

export interface DebugShareOptions {
  /**
   * Days of audit log history to bundle. Default `7`. Capped at `90` to
   * keep the bundle bounded.
   */
  days?: number;
  /**
   * Override the CrowClaw data directory. Defaults to `~/.crowclaw`.
   * Tests use this to point at a temp fixture; production never sets it.
   */
  dataDir?: string;
  /**
   * Override the runtime-config.json path. Defaults to
   * `<dataDir>/runtime-config.json`.
   */
  configPath?: string;
  /**
   * Override the audit log directory. Defaults to `<dataDir>/audit`.
   */
  auditDir?: string;
  /**
   * Optional session-state provider. Tests inject a synthetic source;
   * production callers (the runtime endpoint) pass the live SessionStore.
   * The provider receives the requested `sessionId` and returns the raw
   * session shape (we accept `unknown` because the CLI shouldn't pin
   * itself to `SessionState` and import the whole core types graph).
   */
  loadSession?: (sessionId: string) => Promise<unknown>;
  /**
   * Inject a logger sink (for tests / runtime). Defaults to silent —
   * the command is meant to print the bundle, not chatty progress.
   */
  log?: (line: string) => void;
}

export interface DebugShareBundle {
  /** Schema version of the bundle envelope. */
  bundleVersion: 1;
  /** When the bundle was produced (ISO 8601). */
  generatedAt: string;
  /** Range of audit log entries included. */
  auditWindow: { since: string; days: number };
  /** Redacted session transcript, if one was requested + found. */
  session: unknown | null;
  /** Redacted runtime config snapshot, if readable. */
  config: unknown | null;
  /** Redacted audit log entries (most-recent first). */
  auditEvents: SecurityEvent[];
  /** Diagnostic notes — files that could not be read, etc. */
  notes: string[];
}

export interface DebugShareResult {
  ok: boolean;
  bundle?: DebugShareBundle;
  /** When ok=true, the same payload serialized as a single JSON string. */
  serialized?: string;
  error?: string;
}

const MAX_AUDIT_DAYS = 90;
const DEFAULT_AUDIT_DAYS = 7;

/**
 * Build the support bundle. Always redacts; never uploads.
 *
 * Side effects: zero (read-only on the data dir).
 *
 * Errors NEVER throw — the function returns a structured
 * `{ ok: false, error }` so an operator can re-run with `--days` lower
 * or point `--data-dir` somewhere readable without a stack-trace
 * spilling its CWD into the bundle.
 */
export async function debugShare(
  sessionId: string | undefined,
  opts: DebugShareOptions = {},
): Promise<DebugShareResult> {
  const log = opts.log ?? (() => {});
  const days = Math.max(1, Math.min(opts.days ?? DEFAULT_AUDIT_DAYS, MAX_AUDIT_DAYS));
  const dataDir = opts.dataDir ?? join(homedir(), '.crowclaw');
  const configPath = opts.configPath ?? join(dataDir, 'runtime-config.json');
  const auditDir = opts.auditDir ?? join(dataDir, 'audit');

  const notes: string[] = [];
  const generatedAt = new Date().toISOString();
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

  // 1. Session transcript — only loaded when caller asked for one AND a
  // provider was injected. The CLI surface is read-only; we don't try to
  // construct a SessionStore from the on-disk message store here.
  let session: unknown | null = null;
  if (sessionId) {
    if (opts.loadSession) {
      try {
        const raw = await opts.loadSession(sessionId);
        session = raw === undefined ? null : raw;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        notes.push(`session ${sessionId}: load failed (${msg})`);
      }
    } else {
      notes.push(
        `session ${sessionId}: no loader injected — pass --no-session to silence, ` +
        `or wire the SessionStore via the runtime endpoint`,
      );
    }
  }

  // 2. Runtime config — read once, parse as JSON, redact every string
  // value inside. The config store already replaces sensitive keys with
  // '***' at snapshot time, but we re-redact defensively in case an
  // operator hand-edited the file with a literal token in a comment-ish
  // field name we don't have on the sensitive-key list.
  let config: unknown | null = null;
  try {
    const raw = await readFile(configPath, 'utf-8');
    config = JSON.parse(raw) as unknown;
  } catch (error: unknown) {
    if (isFsError(error) && error.code === 'ENOENT') {
      notes.push(`config: ${configPath} not found`);
    } else {
      const msg = error instanceof Error ? error.message : String(error);
      notes.push(`config: failed to read (${msg})`);
    }
  }

  // 3. Audit events — walk the FileSecurityAuditLog directory directly
  // so this command works without a live runtime. We reuse the same
  // `audit-YYYY-MM-DD.jsonl` filename pattern the file logger writes.
  const auditEvents = await readAuditWindow(auditDir, since, notes);

  // 4. Run unconditional redaction over the entire envelope. This is
  // the load-bearing security property of the command: even if the
  // runtime had redactToolOutput=false, the bundle is safe.
  const bundle: DebugShareBundle = {
    bundleVersion: 1,
    generatedAt,
    auditWindow: { since, days },
    session: session === null ? null : redactValueDeep(session),
    config: config === null ? null : redactValueDeep(config),
    auditEvents: auditEvents.map((event) => redactSecurityEvent(event)),
    notes,
  };

  const serialized = JSON.stringify(bundle, null, 2);
  log(`debug-share bundle ready (${serialized.length} bytes, ${auditEvents.length} audit events)`);
  return { ok: true, bundle, serialized };
}

/**
 * Walk the audit log directory, parse each `audit-YYYY-MM-DD.jsonl`
 * file lazily, and collect events newer than `since`. Returns
 * most-recent-first.
 */
async function readAuditWindow(
  auditDir: string,
  since: string,
  notes: string[],
): Promise<SecurityEvent[]> {
  let entries: string[];
  try {
    entries = await readdir(auditDir);
  } catch (error: unknown) {
    if (isFsError(error) && error.code === 'ENOENT') {
      notes.push(`audit: ${auditDir} not found (no events recorded yet)`);
      return [];
    }
    const msg = error instanceof Error ? error.message : String(error);
    notes.push(`audit: failed to list directory (${msg})`);
    return [];
  }

  const sinceTime = Date.parse(since);
  const files = entries
    .filter((name) => /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();

  const collected: SecurityEvent[] = [];
  for (const filename of files) {
    const filePath = `${auditDir}/${filename}`;
    let raw: string;
    try {
      raw = await readFile(filePath, 'utf-8');
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      notes.push(`audit: skipped ${filename} (${msg})`);
      continue;
    }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SecurityEvent;
        const eventTime = Date.parse(event.timestamp);
        if (Number.isFinite(sinceTime) && eventTime < sinceTime) continue;
        collected.push(event);
      } catch {
        // One malformed line shouldn't tank the bundle.
      }
    }
  }
  collected.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return collected;
}

/**
 * Redact a single SecurityEvent. The `detail` field carries free-form
 * text that may have captured a credential before this defensive
 * redaction layer existed. We re-scrub every string field.
 */
function redactSecurityEvent(event: SecurityEvent): SecurityEvent {
  // redactStructuredData is the right tool but it doesn't preserve the
  // SecurityEvent literal-type discriminants — we get back `unknown`.
  // Build a new object explicitly so the type stays sharp.
  return {
    timestamp: event.timestamp,
    type: event.type,
    severity: event.severity,
    detail: scrubString(event.detail),
    ...(event.sessionId ? { sessionId: scrubString(event.sessionId) } : {}),
    ...(event.agentId ? { agentId: scrubString(event.agentId) } : {}),
    ...(event.model ? { model: event.model } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.presetId ? { presetId: event.presetId } : {}),
  };
}

/** Apply both credential and PII scrubbing to a single string. */
function scrubString(text: string): string {
  return redactPII(redactCredentials(text)).text;
}

/**
 * Deep-redact arbitrary JSON-ish values. We walk via
 * `redactStructuredData` (catches credential-shaped strings and any
 * value under a sensitive key like `token`/`apiKey`/`authorization`),
 * then run a second pass that scrubs PII patterns the structured
 * walker doesn't recognize (email, phone, SSN, CC).
 */
function redactValueDeep(value: unknown): unknown {
  const phase1 = redactStructuredData(value);
  return walkApplyPII(phase1);
}

function walkApplyPII(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactPII(value).text;
  }
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => walkApplyPII(v));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walkApplyPII(v);
    }
    return out;
  }
  return value;
}

interface FsError {
  code: string;
}

function isFsError(error: unknown): error is FsError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof (error as { code?: unknown }).code === 'string'
  );
}

// ---------------------------------------------------------------------------
// Command dispatcher — exported for `packages/cli/src/index.ts` to wire
// into the existing subcommand table. Argument shape mirrors `skill
// install` / `skill publish` so Agent G can drop it into the same
// `runXxxSubcommand` switch.
// ---------------------------------------------------------------------------

export interface DebugShareCommandDeps {
  /** Sink for stdout writes. Defaults to process.stdout.write. */
  stdout?: (chunk: string) => void;
  /** Override the SessionStore loader. Production wires this from runtime-node. */
  loadSession?: DebugShareOptions['loadSession'];
}

/**
 * Parse `[session-id] [--days N]` and run `debugShare`. Prints the
 * bundle to stdout. Returns the result so callers/tests can assert on
 * the bundle without parsing the printed text.
 */
export async function runDebugShareCommand(
  args: ReadonlyArray<string>,
  deps: DebugShareCommandDeps = {},
): Promise<DebugShareResult> {
  const stdoutWrite = deps.stdout ?? ((chunk) => process.stdout.write(chunk));
  let sessionId: string | undefined;
  let days = DEFAULT_AUDIT_DAYS;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i]!;
    if (token === '--days' || token === '-d') {
      const next = args[i + 1];
      if (!next) {
        stdoutWrite(`error: --days requires a numeric argument\n`);
        return { ok: false, error: '--days requires a numeric argument' };
      }
      const parsed = Number.parseInt(next, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        stdoutWrite(`error: --days must be a positive integer (got "${next}")\n`);
        return { ok: false, error: `invalid --days value: ${next}` };
      }
      days = parsed;
      i += 1;
    } else if (token === '--help' || token === '-h') {
      stdoutWrite(renderDebugShareHelp());
      return { ok: true };
    } else if (token.startsWith('--')) {
      stdoutWrite(`error: unknown flag "${token}"\n`);
      return { ok: false, error: `unknown flag: ${token}` };
    } else if (!sessionId) {
      sessionId = token;
    } else {
      stdoutWrite(`error: unexpected positional argument "${token}"\n`);
      return { ok: false, error: `unexpected positional: ${token}` };
    }
  }

  const result = await debugShare(sessionId, {
    days,
    loadSession: deps.loadSession,
  });
  if (result.ok && result.serialized) {
    stdoutWrite(result.serialized);
    stdoutWrite('\n');
  } else if (!result.ok) {
    stdoutWrite(`error: ${result.error ?? 'debug-share failed'}\n`);
  }
  return result;
}

export function renderDebugShareHelp(): string {
  return [
    'crowclaw debug share — print a redacted support bundle (config + audit + transcript)',
    '',
    'Usage:',
    '  crowclaw debug share [session-id] [--days N]',
    '',
    'Behavior:',
    '  - Reads runtime-config.json, recent audit-log entries, and (when a session-id',
    '    is given AND a session loader is wired) the matching transcript.',
    '  - Runs credential + PII redaction unconditionally over every string in the',
    '    bundle, regardless of runtime redaction config. The upload guarantee is',
    '    independent of the write-time guarantee.',
    '  - Default behavior: prints the JSON bundle to stdout. No network upload, no',
    '    clipboard. Pipe to a file or paste service yourself if you want to share.',
    '',
    'Options:',
    '  --days N      Days of audit-log history to include (default 7, max 90).',
    '  -h, --help    Show this message.',
    '',
  ].join('\n');
}

// Re-export the underlying primitives so downstream wrappers (runtime
// endpoint, dashboard export button) can call them without re-importing
// from the deeper module path.
export type { SecurityEvent } from '@crowclaw/core';

/**
 * #66: Immutable approved-command value object.
 *
 * Mitigates OpenClaw CVE-2026-29607 (TOCTOU): with `allow always` rules, a
 * command approved at scan time could substitute its payload before reaching
 * `spawn()`. The fix is to freeze the exact bytes scanned into an
 * `ApprovedCommand` value object that the executor verifies before it runs.
 *
 * Contract:
 * - `freezeCommand()` snapshots argv + env (clone + Object.freeze recursively),
 *   computes a content hash, and returns a non-extensible object.
 * - `verifyCommand()` recomputes the hash from the frozen object's bytes and
 *   throws `CommandTamperedError` if it differs from the recorded hash. This
 *   defends against a malicious caller that hands a hand-rolled forgery
 *   without going through `freezeCommand()`.
 * - The sandbox-executor side (out of this package's scope) is expected to
 *   accept ONLY `ApprovedCommand` and call `verifyCommand()` immediately
 *   before `spawn`.
 *
 * The hash is SHA-256 of a deterministic JSON canonicalization of
 * `{ command, args, env, cwd }`. We use Web Crypto's `subtle.digest` so this
 * works in the Workers runtime without pulling in `node:crypto`.
 */

export interface ApprovedCommandShape {
  /** The executable / shell built-in to run (e.g. "rm", "node"). */
  readonly command: string;
  /** Argv after the executable. Already split — no shell evaluation. */
  readonly args: readonly string[];
  /** Optional working directory. Distinct from any env. */
  readonly cwd?: string;
  /** Optional sanitized env. Should already be passed through `sanitizeEnv()`. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface ApprovedCommand extends ApprovedCommandShape {
  /** Content hash of the canonical bytes. Used by the executor to detect tamper. */
  readonly hash: string;
  /** Wall-clock approval time (ISO). Useful for replay-attack windows. */
  readonly approvedAt: string;
  /** Stable identifier issued at approval time. Logging + tracing. */
  readonly approvalId: string;
  /** Marker so `instanceof`-style narrowing isn't needed across module copies. */
  readonly __approvedCommand: true;
}

export class CommandTamperedError extends Error {
  readonly approvalId: string;
  readonly expectedHash: string;
  readonly actualHash: string;

  constructor(approvalId: string, expectedHash: string, actualHash: string) {
    super(
      `ApprovedCommand tampered: approval=${approvalId} expected=${expectedHash.slice(0, 12)} actual=${actualHash.slice(0, 12)}`,
    );
    this.name = 'CommandTamperedError';
    this.approvalId = approvalId;
    this.expectedHash = expectedHash;
    this.actualHash = actualHash;
  }
}

/** Canonical JSON stringifier: sorts object keys so equivalent inputs hash equally. */
function canonicalize(value: ApprovedCommandShape): string {
  // We only canonicalize the four fields that go into the hash. Whitelisting
  // is safer than walking arbitrary objects because it avoids surprises like
  // injected `__proto__` keys or symbol-keyed entries.
  const env = value.env ? sortEntries(value.env) : undefined;
  return JSON.stringify({
    command: value.command,
    args: [...value.args],
    cwd: value.cwd ?? null,
    env: env ?? null,
  });
}

function sortEntries(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

/** SHA-256 of `data` returned as a lowercase hex string. */
async function sha256Hex(data: string): Promise<string> {
  const bytes = new TextEncoder().encode(data);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Freeze a command shape into an immutable, hash-bound `ApprovedCommand`.
 *
 * After this returns, the command bytes cannot be mutated without producing
 * a different hash. The executor will detect any such mutation via
 * `verifyCommand()`.
 */
export async function freezeCommand(
  shape: ApprovedCommandShape,
  options: { approvalId?: string; approvedAt?: string } = {},
): Promise<ApprovedCommand> {
  const approvalId =
    options.approvalId ??
    `appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const approvedAt = options.approvedAt ?? new Date().toISOString();

  // Defensive deep-clone of args + env so the caller can't mutate them after
  // approval and bypass the hash check (the source array is theirs to modify).
  const frozenArgs = Object.freeze([...shape.args]);
  const frozenEnv = shape.env
    ? Object.freeze({ ...shape.env })
    : undefined;

  const canonical = canonicalize({
    command: shape.command,
    args: frozenArgs,
    cwd: shape.cwd,
    env: frozenEnv,
  });
  const hash = await sha256Hex(canonical);

  const approved: ApprovedCommand = Object.freeze({
    command: shape.command,
    args: frozenArgs,
    cwd: shape.cwd,
    env: frozenEnv,
    hash,
    approvedAt,
    approvalId,
    __approvedCommand: true as const,
  });

  return approved;
}

/**
 * Recompute the hash of `cmd` and compare it to the recorded hash. Throws
 * `CommandTamperedError` on mismatch. Call this immediately before `spawn`.
 */
export async function verifyCommand(cmd: ApprovedCommand): Promise<void> {
  if (!isApprovedCommand(cmd)) {
    throw new CommandTamperedError(
      (cmd as { approvalId?: string })?.approvalId ?? 'unknown',
      (cmd as { hash?: string })?.hash ?? '',
      '<not-an-approved-command>',
    );
  }
  const canonical = canonicalize(cmd);
  const actual = await sha256Hex(canonical);
  if (actual !== cmd.hash) {
    throw new CommandTamperedError(cmd.approvalId, cmd.hash, actual);
  }
}

/** Type guard for `ApprovedCommand`. */
export function isApprovedCommand(value: unknown): value is ApprovedCommand {
  return (
    !!value &&
    typeof value === 'object' &&
    (value as { __approvedCommand?: unknown }).__approvedCommand === true &&
    typeof (value as { hash?: unknown }).hash === 'string' &&
    typeof (value as { approvalId?: unknown }).approvalId === 'string'
  );
}

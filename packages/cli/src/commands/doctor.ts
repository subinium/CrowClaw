/**
 * `crowclaw doctor fix-perms` — Hermes v0.13 parity (#297)
 *
 * Walks `~/.crowclaw/` and chmods every secret-bearing file to 0600. This
 * is the remediation hint shown by the startup permission check when an
 * existing `auth.json` / `config.json` / `runtime-config.json` is found
 * with mode `& 0o077 !== 0` (i.e. world- or group-readable).
 *
 * We do NOT recursively chmod every file in the data dir — that would
 * stomp on attachments, exports, etc. We target only the credential-bearing
 * files we know about by name. Adding more names is safe; it just means
 * more files get locked down.
 */

import { stat, chmod, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * Files we always force to 0600 when seen in the data dir or its top-level
 * subdirs. Extend this set if new credential surfaces appear.
 */
export const SECRET_FILE_BASENAMES = new Set([
  'auth.json',
  'config.json',
  'runtime-config.json',
]);

export interface FixPermsOptions {
  /** Override data dir for tests. Defaults to ~/.crowclaw. */
  dataDir?: string;
  /** Secret-file basenames. Defaults to SECRET_FILE_BASENAMES. */
  secretBasenames?: Set<string>;
}

export interface FixPermsResult {
  ok: boolean;
  /** Absolute paths that were chmod-fixed (mode previously had 077 bits set). */
  fixed: string[];
  /** Files inspected (regardless of whether they needed fixing). */
  inspected: string[];
  /** Files that should have been fixed but errored. */
  failed: Array<{ path: string; error: string }>;
}

/**
 * Walk `dir` looking for known secret-bearing basenames and chmod them to
 * 0600 if their current mode has any of `077` bits set. Returns the list of
 * fixed and inspected paths.
 */
export async function runFixPerms(opts: FixPermsOptions = {}): Promise<FixPermsResult> {
  const dataDir = opts.dataDir ?? join(homedir(), '.crowclaw');
  const secrets = opts.secretBasenames ?? SECRET_FILE_BASENAMES;
  const fixed: string[] = [];
  const inspected: string[] = [];
  const failed: Array<{ path: string; error: string }> = [];

  // Walk only the top-level dir and one level deep. We intentionally do NOT
  // recurse arbitrarily — secrets live in known locations and we don't want
  // to surprise users by chmod-ing files inside skills/, attachments/, etc.
  let topEntries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    topEntries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    // No data dir → nothing to do.
    return { ok: true, fixed, inspected, failed };
  }

  for (const entry of topEntries) {
    const abs = join(dataDir, entry.name);
    if (entry.isFile() && secrets.has(entry.name)) {
      await tryFix(abs, fixed, inspected, failed);
    }
  }

  return { ok: failed.length === 0, fixed, inspected, failed };
}

async function tryFix(
  path: string,
  fixed: string[],
  inspected: string[],
  failed: Array<{ path: string; error: string }>,
): Promise<void> {
  try {
    const s = await stat(path);
    inspected.push(path);
    // (s.mode & 0o077) !== 0 means group or other has read/write/execute.
    if ((s.mode & 0o077) !== 0) {
      await chmod(path, 0o600);
      fixed.push(path);
    }
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    failed.push({ path, error: msg });
  }
}

export function formatFixPermsResult(result: FixPermsResult): string {
  const lines: string[] = [];
  lines.push('crowclaw doctor fix-perms');
  lines.push('');
  if (result.inspected.length === 0) {
    lines.push('No credential files found in ~/.crowclaw — nothing to fix.');
    return lines.join('\n');
  }
  if (result.fixed.length === 0) {
    lines.push(`Inspected ${result.inspected.length} file(s); all already locked to 0600.`);
  } else {
    lines.push(`Fixed ${result.fixed.length}/${result.inspected.length} file(s) → mode 0600:`);
    for (const path of result.fixed) {
      lines.push(`  - ${path}`);
    }
  }
  if (result.failed.length > 0) {
    lines.push('');
    lines.push(`Failures (${result.failed.length}):`);
    for (const f of result.failed) {
      lines.push(`  - ${f.path}: ${f.error}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Startup permission check (called from main()).
// Logs a warning if any known credential file is world/group-readable.
// ---------------------------------------------------------------------------

export interface CheckSecretPermsOptions {
  dataDir?: string;
  secretBasenames?: Set<string>;
  /** Sink for warnings (defaults to process.stderr). */
  warn?: (line: string) => void;
}

export interface CheckSecretPermsResult {
  /** Files with mode & 0o077 !== 0. */
  insecure: string[];
}

export async function checkSecretPerms(
  opts: CheckSecretPermsOptions = {},
): Promise<CheckSecretPermsResult> {
  const dataDir = opts.dataDir ?? join(homedir(), '.crowclaw');
  const secrets = opts.secretBasenames ?? SECRET_FILE_BASENAMES;
  const warn = opts.warn ?? ((line: string) => process.stderr.write(line + '\n'));
  const insecure: string[] = [];

  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }> = [];
  try {
    entries = await readdir(dataDir, { withFileTypes: true });
  } catch {
    return { insecure };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !secrets.has(entry.name)) continue;
    const abs = join(dataDir, entry.name);
    try {
      const s = await stat(abs);
      if ((s.mode & 0o077) !== 0) {
        insecure.push(abs);
      }
    } catch {
      // Skip unreadable entries — they'll surface in actual use.
    }
  }

  if (insecure.length > 0) {
    warn(`[security] ${insecure.length} credential file(s) in ~/.crowclaw are world/group-readable:`);
    for (const path of insecure) warn(`  - ${path}`);
    warn('Run `crowclaw doctor fix-perms` to lock them down to 0600.');
  }

  return { insecure };
}

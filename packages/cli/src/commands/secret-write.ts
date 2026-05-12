/**
 * `writeSecretAtomic` — close TOCTOU window in credential file writers
 * (Hermes v0.13 parity #297).
 *
 * Local CLI implementation. The canonical helper lives in `@crowclaw/shared`
 * (added by the MCP OAuth sibling issue) — once that branch merges, this
 * file should re-export from `@crowclaw/shared` instead. Keeping a local
 * copy lets the CLI ship the fix without coupling to the merge order of
 * sibling agent branches.
 *
 * TOCTOU semantics:
 *   1. Write to `<path>.tmp.<rand>` with `O_CREAT|O_EXCL|O_NOFOLLOW` so an
 *      attacker can't pre-create a symlink that we'd then chmod.
 *   2. fchmod the file descriptor (NOT the path) to 0600 — using path here
 *      would race with `mv`/symlink swaps.
 *   3. `rename()` atomically replaces the destination. The kernel guarantees
 *      either-or atomicity within a filesystem; a reader sees either the
 *      old or new contents, never a torn write.
 *
 * Why not just `writeFile(path, data, { mode: 0o600 })`?
 *   - `writeFile` opens with `O_CREAT|O_TRUNC` (no `O_EXCL`/`O_NOFOLLOW`).
 *     If the path exists and is a symlink to a victim file the attacker
 *     controls, the write follows it.
 *   - `mode: 0o600` is only applied when the file is CREATED. Pre-existing
 *     files keep their old (possibly world-readable) mode.
 *
 * The fix below applies both pieces: O_EXCL on a randomized temp name, then
 * fchmod, then atomic rename over the real path.
 */

import { open } from 'node:fs/promises';
import { rename, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, basename, join } from 'node:path';

export interface WriteSecretAtomicOptions {
  /** File mode for the destination. Defaults to 0o600. */
  mode?: number;
}

/**
 * Write `data` to `path` atomically with `mode` (default 0o600) and no
 * symlink-follow. Throws on failure — caller MUST handle.
 *
 * Contract: after a successful return, `path` is a regular file owned by
 * the current process user with the exact mode requested. Concurrent readers
 * see either the previous contents or the new contents (never partial).
 */
export async function writeSecretAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteSecretAtomicOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const dir = dirname(path);
  const base = basename(path);
  const suffix = randomBytes(8).toString('hex');
  const tmpPath = join(dir, `.${base}.tmp.${suffix}`);

  // O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW
  // - O_EXCL: fail if tmpPath exists (refuses to follow attacker pre-create).
  // - O_NOFOLLOW: if tmpPath is a symlink, fail rather than follow.
  // Node maps these via numeric flags from `node:constants`. The string
  // 'wx' is equivalent to O_CREAT|O_EXCL|O_WRONLY but does NOT add
  // O_NOFOLLOW, so we have to use the numeric form.
  const constants = await import('node:constants');
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    constants.O_NOFOLLOW;

  let handle;
  try {
    handle = await open(tmpPath, flags, mode);
    await handle.writeFile(data);
    // Belt-and-braces: fchmod the open fd in case umask masked our mode.
    await handle.chmod(mode);
    await handle.close();
  } catch (error) {
    if (handle) {
      try {
        await handle.close();
      } catch {
        /* already closed or never opened */
      }
    }
    try {
      await unlink(tmpPath);
    } catch {
      /* tmpPath may not exist */
    }
    throw error;
  }

  // Atomic rename over the destination. If `path` is itself a symlink,
  // `rename` replaces the symlink with our new file — which is what we want
  // for a TOCTOU-safe credential write. If you need stricter behavior
  // (refuse if `path` is a symlink), stat it first and bail.
  try {
    await rename(tmpPath, path);
  } catch (error) {
    try {
      await unlink(tmpPath);
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}

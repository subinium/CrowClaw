/**
 * Atomic secret-write helper (Hermes v0.13 parity — issue #296).
 *
 * Replaces ad-hoc `fs.writeFile` calls that persist secrets (MCP OAuth
 * tokens, `auth.json`, runtime token caches). Closes a TOCTOU window
 * where an attacker can plant a symlink at the destination path between
 * `existsSync` / `stat` and the write, redirecting the secret to an
 * attacker-controlled location.
 *
 * Strategy:
 *   1. Open the destination directly with O_WRONLY | O_CREAT | O_EXCL |
 *      O_NOFOLLOW and `0o600` perms in one syscall. EEXIST or ELOOP from
 *      a planted symlink short-circuits the write — we fall back to the
 *      atomic temp-then-rename path that itself never follows symlinks.
 *   2. After writing, fsync + chmod 0o600 (umask can mask the create
 *      mode on some platforms, so re-apply explicitly).
 *   3. For overwrites: write to `<path>.tmp.<rand>` with the same
 *      O_NOFOLLOW guarantees, fsync, then atomic `rename` onto the
 *      destination. This keeps the file's inode stable even if a
 *      reader holds it open during rotation.
 *
 * Hermes parity: NousResearch/hermes-agent#21176, #21194.
 */

import { constants, type Mode } from 'node:fs';
import { lstat, open, rename, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WriteSecretAtomicOptions {
  /** File mode applied to the destination. Default `0o600`. */
  mode?: Mode;
  /**
   * Reject writes when the parent directory is world-writable (mode bit
   * `o+w`). Default `true`. Set `false` to ship intentional world-readable
   * caches — never appropriate for credential material.
   */
  rejectWorldWritableParent?: boolean;
}

/**
 * Write `data` to `path` atomically with `O_NOFOLLOW` semantics and a
 * caller-specified file mode (default `0o600`).
 *
 * Semantics:
 * - If `path` does not exist: created via O_CREAT|O_EXCL|O_NOFOLLOW.
 * - If `path` exists as a regular file: replaced atomically via
 *   tmp-file + rename. A pre-existing symlink at `path` triggers
 *   ELOOP/EMLINK (rejected — never followed).
 * - On success, mode is enforced to `options.mode` regardless of umask.
 * - Concurrent writes to the same path serialize via the rename step;
 *   the last writer wins atomically (no partial-file readers).
 *
 * Throws:
 * - `ENOENT` — parent directory does not exist.
 * - `EACCES` — parent dir not writable, or world-writable parent
 *   rejected by guard.
 * - `ELOOP` / `EMLINK` — symlink planted at destination.
 */
export async function writeSecretAtomic(
  path: string,
  data: string | Uint8Array,
  options: WriteSecretAtomicOptions = {},
): Promise<void> {
  const mode = options.mode ?? 0o600;
  const rejectWorldWritableParent = options.rejectWorldWritableParent ?? true;

  if (rejectWorldWritableParent) {
    await assertParentNotWorldWritable(path);
  }

  // Buffer once so the create-then-write path and the tmp-rename path
  // share the same payload — avoids encoding the string twice.
  const payload = typeof data === 'string'
    ? new TextEncoder().encode(data)
    : data;

  // Path 1: fast path — create new file with O_EXCL|O_NOFOLLOW. If
  // anything (regular file OR symlink) already exists at `path`, this
  // throws EEXIST or ELOOP and we fall through to either the symlink
  // rejection or the atomic-rename overwrite path.
  try {
    const handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
    try {
      await handle.writeFile(payload);
      // Re-apply mode in case the platform honored umask over the
      // O_CREAT mode argument (observed on some BSD variants).
      await handle.chmod(mode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    return;
  } catch (error: unknown) {
    if (!isFsError(error)) throw error;
    // ELOOP / EMLINK: kernel rejected the open because the target is a
    // symlink — reject the write entirely.
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw symlinkRejection(path, error);
    }
    if (error.code !== 'EEXIST') throw error;
  }

  // EEXIST: something exists at the path. On Linux and macOS the
  // O_EXCL|O_NOFOLLOW combo prefers EEXIST over ELOOP when a symlink is
  // planted, so we cannot rely on the error code alone to distinguish
  // "regular file we want to overwrite" from "symlink we must refuse".
  // lstat (does not follow symlinks) classifies the target.
  const targetType = await lstat(path);
  if (targetType.isSymbolicLink()) {
    throw symlinkRejection(path);
  }
  if (!targetType.isFile()) {
    // Refuse to overwrite directories, sockets, device nodes, etc. The
    // caller asked to write a secret — only regular-file replacement is
    // a safe outcome here.
    const err = new Error(
      `Refusing to overwrite non-regular file at ${path}: ${describeFileType(targetType)}`,
    ) as NodeJS.ErrnoException;
    err.code = 'EINVAL';
    err.path = path;
    throw err;
  }

  // Path 2: destination exists as a regular file (we rejected symlinks
  // above). Write to a temp sibling with the same O_NOFOLLOW guarantees,
  // fsync, then atomic-rename onto the destination.
  const tmpPath = `${path}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  let tmpHandle;
  try {
    tmpHandle = await open(
      tmpPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      mode,
    );
  } catch (error: unknown) {
    if (!isFsError(error)) throw error;
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw error;
    }
    // EEXIST on the temp path is statistically unlikely (pid + 8-char
    // random) but if it happens, surface to the caller — they should
    // retry rather than silently overwrite an unknown temp.
    throw error;
  }

  try {
    try {
      await tmpHandle.writeFile(payload);
      await tmpHandle.chmod(mode);
      await tmpHandle.sync();
    } finally {
      await tmpHandle.close();
    }
    await rename(tmpPath, path);
    // The renamed file inherits perms from the temp file, which we just
    // chmod'd to `mode`. Re-applying chmod on `path` would race with
    // another writer; the inode-stable rename already guarantees the
    // bits we want.
  } catch (error) {
    // Best-effort temp cleanup on failure so we don't leak a sensitive
    // tmp file. The temp file may already be gone if rename succeeded
    // and the failure was downstream.
    try {
      await unlink(tmpPath);
    } catch {
      /* tmp may have been moved by rename or never existed */
    }
    throw error;
  }
}

function symlinkRejection(path: string, cause?: { code: string }): NodeJS.ErrnoException {
  const err = new Error(
    `Refusing to write secret: target ${path} is a symbolic link${cause ? ` (${cause.code})` : ''}. O_NOFOLLOW prevented symlink traversal.`,
  ) as NodeJS.ErrnoException;
  err.code = 'ELOOP';
  err.path = path;
  return err;
}

function describeFileType(stats: { isDirectory(): boolean; isBlockDevice(): boolean; isCharacterDevice(): boolean; isFIFO(): boolean; isSocket(): boolean }): string {
  if (stats.isDirectory()) return 'directory';
  if (stats.isBlockDevice()) return 'block device';
  if (stats.isCharacterDevice()) return 'character device';
  if (stats.isFIFO()) return 'fifo';
  if (stats.isSocket()) return 'socket';
  return 'unknown type';
}

async function assertParentNotWorldWritable(path: string): Promise<void> {
  const parent = dirname(path);
  let parentStat;
  try {
    parentStat = await stat(parent);
  } catch (error: unknown) {
    if (isFsError(error) && error.code === 'ENOENT') {
      // Parent missing — let the open() call surface the real ENOENT
      // with the destination path attached, instead of pre-empting it
      // with a guard error that hides the actual cause.
      return;
    }
    throw error;
  }
  // `o+w` = 0o002. If the world-writable bit is set, refuse the write —
  // a co-tenant could plant a symlink we haven't checked for.
  if ((parentStat.mode & 0o002) !== 0) {
    const err = new Error(
      `Refusing to write secret: parent directory ${parent} is world-writable (mode ${(parentStat.mode & 0o777).toString(8)})`,
    ) as NodeJS.ErrnoException;
    err.code = 'EACCES';
    err.path = parent;
    throw err;
  }
}

interface FsError {
  code: string;
}

function isFsError(value: unknown): value is FsError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}

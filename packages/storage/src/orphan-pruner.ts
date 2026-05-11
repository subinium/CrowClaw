/**
 * #338 (v0.9.0 Hermes parity): auto-prune orphan + stale shadow checkpoint
 * repos at startup.
 *
 * The checkpoint subsystem accumulates one shadow directory per session
 * (`<baseDir>/<sessionId>/cp-*.json`). When sessions are deleted from the
 * session store without a follow-up `deleteBySession`, those shadow dirs
 * leak and grow forever. v0.8.x had no sweeper; this module walks the
 * checkpoint root at startup and:
 *
 *   1. Identifies "orphans" — sessionId no longer in the session index.
 *   2. Identifies "stale" — last-touched > `staleAfterDays` (default 60).
 *   3. Moves them into `<baseDir>/.trash/` for one cycle (RECOVERABLE).
 *   4. On the NEXT startup, anything still inside `.trash/` older than
 *      `trashRetentionDays` (default 7) is permanently deleted.
 *
 * The two-phase design is the v0.12 Hermes pattern: the first sweep is
 * reversible (`mv` not `rm -r`) so a misconfigured session-index doesn't
 * vaporize valid data. Operators get a startup-log message with the
 * counts; if the numbers look wrong they have one process-restart cycle
 * to dig the data out of `.trash/`.
 *
 * Sibling rewrite "Checkpoints v2" replaces this with a relational store
 * that prevents the leak structurally. This module is the interim fix.
 */

import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface OrphanPrunerOptions {
  /** Root directory of the checkpoint store (matches `FileCheckpointStore.baseDir`). */
  baseDir: string;
  /** Async function returning the set of known sessionIds — typically
   *  `(await sessionStore.list()).map(s => s.sessionId)`. */
  knownSessionIds: () => Promise<Set<string>>;
  /** Sessions whose checkpoints were last touched longer ago than this
   *  are considered stale even if the session still exists in the index.
   *  Default 60 days. */
  staleAfterDays?: number;
  /** How long entries in `.trash/` live before being permanently deleted
   *  on the next prune cycle. Default 7 days. */
  trashRetentionDays?: number;
  /** Set to true to skip the destructive permanent-delete phase. Useful
   *  in tests and on the very first prune cycle where there are no
   *  prior-cycle entries yet. */
  dryRunTrashDelete?: boolean;
}

export interface OrphanPruneResult {
  /** Count of sessionId directories moved to `.trash/` because the
   *  sessionId no longer exists in the session index. */
  orphansTrashed: number;
  /** Count of sessionId directories moved to `.trash/` because they
   *  hadn't been touched in `staleAfterDays`. */
  staleTrashed: number;
  /** Count of entries permanently removed from `.trash/` (older than
   *  `trashRetentionDays`). */
  trashEvicted: number;
  /** Set of session ids that were moved to trash in this cycle. Surface
   *  for tests and the startup log. */
  trashed: string[];
}

const TRASH_DIRNAME = '.trash';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * #338: single entry point called from `runtime-startup.ts`. Idempotent —
 * a baseDir that doesn't exist returns zeros without throwing so the host
 * can call this on every cold start unconditionally.
 */
export async function pruneOrphanCheckpoints(options: OrphanPrunerOptions): Promise<OrphanPruneResult> {
  const staleAfterDays = options.staleAfterDays ?? 60;
  const trashRetentionDays = options.trashRetentionDays ?? 7;
  const baseDir = options.baseDir;
  const trashDir = join(baseDir, TRASH_DIRNAME);
  const result: OrphanPruneResult = { orphansTrashed: 0, staleTrashed: 0, trashEvicted: 0, trashed: [] };

  // Phase 1: evict prior-cycle trash entries that are older than the
  // retention window. We do this BEFORE walking new candidates so a
  // single prune cycle is enough to recover disk space after the
  // operator chose not to restore.
  if (!options.dryRunTrashDelete) {
    result.trashEvicted = await evictExpiredTrash(trashDir, trashRetentionDays);
  }

  // Phase 2: walk live shadow dirs and move orphans/stale ones to trash.
  let entries: { name: string; isDirectory: boolean }[];
  try {
    const dirents = await readdir(baseDir, { withFileTypes: true });
    entries = dirents.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    // baseDir doesn't exist yet — nothing to prune.
    return result;
  }

  const knownIds = await options.knownSessionIds();
  const now = Date.now();
  const staleCutoff = now - staleAfterDays * DAY_MS;

  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    // Skip the trash itself and the FileCheckpointStore index dir.
    if (entry.name === TRASH_DIRNAME || entry.name === '_index') continue;

    const sessionId = entry.name;
    const sessionDir = join(baseDir, sessionId);

    const isOrphan = !knownIds.has(sessionId);
    let isStale = false;
    if (!isOrphan) {
      // Cheap-ish: stat the directory itself, not its children. mtime is
      // updated when files inside are written, so for shadow dirs this
      // is a good proxy for "last touched". A more precise measurement
      // would walk every checkpoint file — overkill for the use case.
      try {
        const dirStat = await stat(sessionDir);
        if (dirStat.mtimeMs < staleCutoff) isStale = true;
      } catch { /* unreadable → skip */ }
    }

    if (!isOrphan && !isStale) continue;

    await mkdir(trashDir, { recursive: true });
    // Suffix with timestamp so two prunes of the same sessionId (across
    // restarts) don't collide.
    const trashPath = join(trashDir, `${sessionId}.${now.toString(36)}`);
    try {
      await rename(sessionDir, trashPath);
      result.trashed.push(sessionId);
      if (isOrphan) result.orphansTrashed += 1;
      else result.staleTrashed += 1;
    } catch {
      // Cross-device rename, permission denied, etc. — leave it where it
      // is; next cycle will retry.
    }
  }

  return result;
}

/**
 * Evict trash entries whose mtime is older than the retention window.
 * Best-effort: per-entry errors are swallowed so a single permission
 * issue doesn't abort the entire pass.
 */
async function evictExpiredTrash(trashDir: string, retentionDays: number): Promise<number> {
  let evicted = 0;
  let entries: string[];
  try {
    entries = await readdir(trashDir);
  } catch {
    return 0;
  }

  const cutoff = Date.now() - retentionDays * DAY_MS;
  for (const name of entries) {
    const path = join(trashDir, name);
    try {
      const s = await stat(path);
      if (s.mtimeMs < cutoff) {
        await rm(path, { recursive: true, force: true });
        evicted += 1;
      }
    } catch {
      // Stat or remove failed — skip and let next cycle retry.
    }
  }
  return evicted;
}

/**
 * Format a prune result for the startup log. Kept here so the log shape
 * stays consistent across runtimes (node, cloudflare, etc.) — runtimes
 * only need to call `pruneOrphanCheckpoints` + `formatPruneSummary`.
 */
export function formatPruneSummary(result: OrphanPruneResult): string {
  return `pruned ${result.orphansTrashed} orphan${result.orphansTrashed === 1 ? '' : 's'}, ${result.staleTrashed} stale; trashed ${result.trashEvicted} from previous run`;
}

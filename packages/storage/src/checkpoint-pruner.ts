/**
 * #307 (v0.9.1 Sentinel / Hermes v0.13 parity): Checkpoints v2 pruner with
 * real retention enforcement and a disk guardrail.
 *
 * Background: the v0.8.x checkpoint store keeps one file per iteration and
 * never reclaims space. The lighter `#338` orphan-pruner removes whole
 * session directories whose sessionId is gone or stale, but it cannot bound
 * a single long-lived session that auto-checkpoints forever, and it has no
 * disk budget. This module is the content-level sweep that bounds the store
 * by three independent retention axes:
 *
 *   1. Age   — evict checkpoints older than `maxAgeDays`.
 *   2. Count — keep only the newest `maxCount`; evict the rest.
 *   3. Disk  — if the total serialized size exceeds `maxDiskMB`, evict
 *              oldest-first until under budget.
 *
 * Pinned checkpoints (passed explicitly via `pinnedIds`, or carrying a
 * truthy `pinned` flag on the record or its `metadata`) are NEVER evicted by
 * any axis — they are the operator's "keep this one forever" marker.
 *
 * Crash-safety (two-cycle sweep): mirroring the `#338` orphan-pruner's
 * `.trash/` pattern, eviction is reversible for one cycle. The first cycle
 * moves a doomed checkpoint into a trash area (RECOVERABLE); a later cycle
 * permanently removes trash entries older than `trashRetentionDays`. When no
 * trash adapter is supplied the pruner falls back to a hard delete (the
 * `FileCheckpointStore` directory layout has its own `.trash/` via the
 * orphan-pruner, so the disk-budget path there is already one-cycle
 * recoverable at the session-dir granularity).
 *
 * This module is intentionally PURE and options-taking: it reads NO runtime
 * config. The integrator passes `retention` from the runtime config-schema
 * (`checkpoints.retention.{maxAgeDays,maxCount,maxDiskMB}`) and emits a
 * `checkpoint:pruned` event per eviction using the reasons surfaced in the
 * returned `PruneResult.evictions`.
 */

import type { SessionCheckpoint } from '@crowclaw/core';

// -- v0.9.1 checkpoints-v2 pruner BEGIN --

/** Why a particular checkpoint was evicted. Surfaced per-eviction so the
 *  integrator can emit `checkpoint:pruned` with a precise reason. */
export type CheckpointPruneReason = 'age' | 'count' | 'disk';

/**
 * Minimal read/list/delete surface the pruner needs. `CheckpointStore`
 * (`@crowclaw/core`) and `FileCheckpointStore` (`@crowclaw/storage`) both
 * satisfy this once they can enumerate every checkpoint — see
 * `listAllCheckpoints` for the default enumerator the integrator can build
 * from `SessionListStore.list()` + `store.listBySession()`.
 */
export interface CheckpointPruneStore {
  /** Enumerate every checkpoint in the store across all sessions. */
  listAll(): Promise<SessionCheckpoint[]>;
  /** Permanently remove a checkpoint by id. Returns whether it existed. */
  delete(id: string): Promise<boolean>;
}

/**
 * Optional recoverable trash area for the two-cycle sweep. When provided, the
 * pruner soft-deletes (moves to trash) on the first cycle and the host (or a
 * later cycle via `sweepTrash`) reclaims the space. Kept as an injectable
 * adapter so the pruner stays backend-agnostic (filesystem, D1, in-memory).
 */
export interface CheckpointTrash {
  /** Move a checkpoint into the trash for recovery. Implementations should be
   *  idempotent for the same id. */
  trash(checkpoint: SessionCheckpoint): Promise<void>;
  /** Permanently remove trash entries last touched longer ago than
   *  `retentionDays`. Returns the count removed. */
  sweep(retentionDays: number): Promise<number>;
}

export interface CheckpointRetention {
  /** Evict checkpoints whose `createdAt` is older than this many days. */
  maxAgeDays?: number;
  /** Keep at most this many checkpoints (newest-first); evict the overflow. */
  maxCount?: number;
  /** Total serialized-size budget in megabytes. When exceeded, evict
   *  oldest-first until under budget. */
  maxDiskMB?: number;
  /** Checkpoint ids that must survive every eviction axis. */
  pinnedIds?: string[];
  /** How long trash entries live before `sweepTrash` reclaims them.
   *  Default 7 days. Only used when a `CheckpointTrash` adapter is supplied. */
  trashRetentionDays?: number;
}

export interface CheckpointPruneOptions {
  /** Optional recoverable trash adapter for the two-cycle sweep. When omitted
   *  the pruner hard-deletes. */
  trash?: CheckpointTrash;
  /** Override the wall clock — used by tests for deterministic age math. */
  now?: () => number;
  /** Override per-checkpoint size estimation (bytes). Defaults to the
   *  serialized JSON byte length. The integrator can pass a filesystem-`stat`
   *  based sizer for the `FileCheckpointStore` so the disk budget reflects
   *  actual on-disk bytes rather than the in-memory JSON estimate. */
  sizeOf?: (checkpoint: SessionCheckpoint) => number;
}

export interface CheckpointEviction {
  id: string;
  sessionId: string;
  reason: CheckpointPruneReason;
  /** Estimated serialized size in bytes at eviction time. */
  bytes: number;
  /** True when the checkpoint was moved to trash (recoverable) rather than
   *  hard-deleted. */
  trashed: boolean;
}

export interface PruneResult {
  /** Total checkpoints examined this cycle. */
  scanned: number;
  /** Checkpoints evicted because they exceeded `maxAgeDays`. */
  agedOut: number;
  /** Checkpoints evicted because they overflowed `maxCount`. */
  countEvicted: number;
  /** Checkpoints evicted to bring total size under `maxDiskMB`. */
  diskEvicted: number;
  /** Pinned checkpoints skipped across all axes. */
  pinnedSkipped: number;
  /** Trash entries permanently reclaimed this cycle (two-cycle sweep). */
  trashReclaimed: number;
  /** Total bytes (estimated) freed by eviction this cycle. */
  bytesFreed: number;
  /** True when the disk budget could NOT be met because only pinned
   *  checkpoints remained over budget. The host should warn. */
  diskBudgetUnmet: boolean;
  /** Per-eviction detail for `checkpoint:pruned` emission. */
  evictions: CheckpointEviction[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_TRASH_RETENTION_DAYS = 7;

const emptyResult = (): PruneResult => ({
  scanned: 0,
  agedOut: 0,
  countEvicted: 0,
  diskEvicted: 0,
  pinnedSkipped: 0,
  trashReclaimed: 0,
  bytesFreed: 0,
  diskBudgetUnmet: false,
  evictions: [],
});

/** Default size estimator: serialized JSON byte length. Stable across
 *  backends and good enough to bound a runaway store; the integrator may
 *  override with a `stat`-based sizer for byte-accurate disk accounting. */
const defaultSizeOf = (checkpoint: SessionCheckpoint): number => {
  try {
    return Buffer.byteLength(JSON.stringify(checkpoint), 'utf-8');
  } catch {
    // Unserializable (e.g. a cycle) — treat as zero so a single bad record
    // never aborts the whole sweep. The orphan-pruner / GC handles truly
    // corrupt files separately.
    return 0;
  }
};

/** Read the timestamp axis. `createdAt` is an ISO string; fall back to 0
 *  (treated as ancient → evictable) when missing or malformed so a corrupt
 *  record doesn't pin the store open. */
const createdAtMs = (checkpoint: SessionCheckpoint): number => {
  const parsed = Date.parse(checkpoint.createdAt);
  return Number.isNaN(parsed) ? 0 : parsed;
};

/** A checkpoint is pinned when its id is in `pinnedIds`, or it carries a
 *  truthy `pinned` flag at the top level or under `metadata`. The flag forms
 *  let the store mark a checkpoint as kept without the pruner having to be
 *  told the id list out-of-band. Read defensively (optional chaining /
 *  index access) because `pinned` is not yet on the core interface — the
 *  integrator adds it later and this code typechecks standalone today. */
const isPinned = (checkpoint: SessionCheckpoint, pinnedIdSet: Set<string>): boolean => {
  if (pinnedIdSet.has(checkpoint.id)) return true;
  const record = checkpoint as SessionCheckpoint & { pinned?: unknown };
  if (record.pinned === true) return true;
  const metadata = checkpoint.metadata as (SessionCheckpoint['metadata'] & { pinned?: unknown }) | undefined;
  return metadata?.pinned === true;
};

interface SizedCheckpoint {
  checkpoint: SessionCheckpoint;
  bytes: number;
  createdMs: number;
  pinned: boolean;
}

/**
 * #307: prune a checkpoint store against a retention policy. Pure and
 * options-taking — reads no runtime config. Idempotent: a second call with an
 * already-compliant store evicts nothing. An empty / missing store is a
 * no-op returning zeros (never throws).
 *
 * Eviction order across axes is age → count → disk, and within an axis the
 * oldest checkpoint goes first. Pinned checkpoints survive every axis but
 * still count toward the disk total (you cannot reclaim space a pinned
 * checkpoint occupies; the host is warned via `diskBudgetUnmet`).
 */
export async function pruneCheckpoints(
  store: CheckpointPruneStore,
  retention: CheckpointRetention,
  options: CheckpointPruneOptions = {},
): Promise<PruneResult> {
  const result = emptyResult();
  const now = (options.now ?? Date.now)();
  const sizeOf = options.sizeOf ?? defaultSizeOf;
  const trashRetentionDays = retention.trashRetentionDays ?? DEFAULT_TRASH_RETENTION_DAYS;
  const pinnedIdSet = new Set(retention.pinnedIds ?? []);

  // Phase 0: reclaim prior-cycle trash BEFORE evicting new candidates so a
  // single cycle is enough to free space after the operator declined to
  // restore. Mirrors the orphan-pruner's trash-first ordering.
  if (options.trash) {
    try {
      result.trashReclaimed = await options.trash.sweep(trashRetentionDays);
    } catch {
      // Best-effort: a trash sweep failure must not abort the live sweep.
    }
  }

  let all: SessionCheckpoint[];
  try {
    all = await store.listAll();
  } catch {
    // Store unreadable (baseDir absent, etc.) — nothing to prune.
    return result;
  }
  if (all.length === 0) return result;

  result.scanned = all.length;

  // Annotate once: size, age, pinned. Sort oldest-first so every axis evicts
  // the oldest survivors first. Tie-break on iteration then id for a stable,
  // deterministic order across runs.
  const sized: SizedCheckpoint[] = all.map((checkpoint) => ({
    checkpoint,
    bytes: sizeOf(checkpoint),
    createdMs: createdAtMs(checkpoint),
    pinned: isPinned(checkpoint, pinnedIdSet),
  }));
  sized.sort(
    (a, b) =>
      a.createdMs - b.createdMs ||
      a.checkpoint.iteration - b.checkpoint.iteration ||
      a.checkpoint.id.localeCompare(b.checkpoint.id),
  );

  result.pinnedSkipped = sized.filter((entry) => entry.pinned).length;

  const evicted = new Set<string>();

  const evict = async (entry: SizedCheckpoint, reason: CheckpointPruneReason): Promise<boolean> => {
    if (entry.pinned || evicted.has(entry.checkpoint.id)) return false;
    let trashed = false;
    try {
      if (options.trash) {
        await options.trash.trash(entry.checkpoint);
        trashed = true;
      }
      await store.delete(entry.checkpoint.id);
    } catch {
      // Per-entry failure (permission, race) — skip it; the next cycle
      // retries. Never abort the whole sweep on one bad record.
      return false;
    }
    evicted.add(entry.checkpoint.id);
    result.bytesFreed += entry.bytes;
    result.evictions.push({
      id: entry.checkpoint.id,
      sessionId: entry.checkpoint.sessionId,
      reason,
      bytes: entry.bytes,
      trashed,
    });
    return true;
  };

  // Axis 1: age. Evict anything older than the cutoff (pinned survive).
  if (typeof retention.maxAgeDays === 'number' && retention.maxAgeDays >= 0) {
    const ageCutoff = now - retention.maxAgeDays * DAY_MS;
    for (const entry of sized) {
      if (entry.createdMs < ageCutoff && (await evict(entry, 'age'))) {
        result.agedOut += 1;
      }
    }
  }

  // Axis 2: count. Keep the newest `maxCount` SURVIVORS (non-pinned,
  // not-already-evicted); evict the oldest overflow. Pinned checkpoints do
  // not consume budget slots — they are always kept on top of the cap.
  if (typeof retention.maxCount === 'number' && retention.maxCount >= 0) {
    const survivors = sized.filter((entry) => !entry.pinned && !evicted.has(entry.checkpoint.id));
    const overflow = survivors.length - retention.maxCount;
    if (overflow > 0) {
      // `sized` is oldest-first, so `survivors` is too — evict from the front.
      for (let i = 0; i < overflow; i += 1) {
        if (await evict(survivors[i]!, 'count')) {
          result.countEvicted += 1;
        }
      }
    }
  }

  // Axis 3: disk budget. Evict oldest non-pinned survivors until total size
  // is under budget. Pinned bytes are immovable — if survivors are all
  // pinned and we're still over budget, flag `diskBudgetUnmet` so the host
  // warns instead of silently leaking.
  if (typeof retention.maxDiskMB === 'number' && retention.maxDiskMB >= 0) {
    const budgetBytes = retention.maxDiskMB * BYTES_PER_MB;
    let totalBytes = 0;
    for (const entry of sized) {
      if (!evicted.has(entry.checkpoint.id)) totalBytes += entry.bytes;
    }
    if (totalBytes > budgetBytes) {
      // Oldest-first survivors eligible for disk eviction.
      for (const entry of sized) {
        if (totalBytes <= budgetBytes) break;
        if (entry.pinned || evicted.has(entry.checkpoint.id)) continue;
        if (await evict(entry, 'disk')) {
          result.diskEvicted += 1;
          totalBytes -= entry.bytes;
        }
      }
      if (totalBytes > budgetBytes) {
        // Remaining over-budget bytes are held by pinned checkpoints we
        // refused to evict.
        result.diskBudgetUnmet = true;
      }
    }
  }

  return result;
}

/**
 * Format a prune result for the startup / periodic-sweep log. Kept here so
 * the log shape stays consistent across runtimes — runtimes only call
 * `pruneCheckpoints` + `formatCheckpointPruneSummary`. No emojis (project
 * rule).
 */
export function formatCheckpointPruneSummary(result: PruneResult): string {
  const mbFreed = (result.bytesFreed / BYTES_PER_MB).toFixed(2);
  const parts = [
    `scanned ${result.scanned}`,
    `evicted ${result.agedOut} by age`,
    `${result.countEvicted} by count`,
    `${result.diskEvicted} by disk`,
    `freed ${mbFreed} MB`,
    `kept ${result.pinnedSkipped} pinned`,
    `reclaimed ${result.trashReclaimed} from trash`,
  ];
  let summary = parts.join(', ');
  if (result.diskBudgetUnmet) {
    summary += '; WARNING disk budget unmet (only pinned checkpoints remain over budget)';
  }
  return summary;
}

// -- v0.9.1 checkpoints-v2 pruner END --

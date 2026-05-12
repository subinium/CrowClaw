/**
 * #338 (v0.9.0 Hermes parity): auto-prune orphan + stale shadow checkpoint
 * repos at startup.
 *
 * Acceptance criteria from the issue, all verified below:
 *   - Orphan detection — synthetic orphan in test fixture is pruned.
 *   - Stale-by-age detection works.
 *   - `.trash/` gives one cycle of recovery.
 *   - Startup log clear on counts.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, readdir, rm, utimes, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pruneOrphanCheckpoints, formatPruneSummary } from '@crowclaw/storage';

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = join(tmpdir(), `crowclaw-prune-${Math.random().toString(36).slice(2)}`);
  await mkdir(tmpRoot, { recursive: true });
});

afterEach(async () => {
  try { await rm(tmpRoot, { recursive: true, force: true }); } catch { /* swallow */ }
});

async function seedCheckpoint(sessionId: string, payload?: string, mtimeAgoDays?: number) {
  const dir = join(tmpRoot, sessionId);
  await mkdir(dir, { recursive: true });
  const file = join(dir, `cp-${sessionId}-fake.json`);
  await writeFile(file, payload ?? `{"id":"cp-${sessionId}","sessionId":"${sessionId}"}`, 'utf-8');
  if (mtimeAgoDays !== undefined) {
    const past = new Date(Date.now() - mtimeAgoDays * 24 * 60 * 60 * 1000);
    await utimes(dir, past, past);
    await utimes(file, past, past);
  }
}

describe('pruneOrphanCheckpoints (#338)', () => {
  it('moves orphan session directories to .trash/', async () => {
    await seedCheckpoint('sess-known');
    await seedCheckpoint('sess-orphan-1');
    await seedCheckpoint('sess-orphan-2');

    const result = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(['sess-known']),
    });

    expect(result.orphansTrashed).toBe(2);
    expect(result.staleTrashed).toBe(0);
    expect(result.trashed.sort()).toEqual(['sess-orphan-1', 'sess-orphan-2']);

    // Live session is untouched.
    const known = await stat(join(tmpRoot, 'sess-known'));
    expect(known.isDirectory()).toBe(true);

    // Orphans moved into .trash/<sessionId>.<timestamp>
    const trashEntries = await readdir(join(tmpRoot, '.trash'));
    expect(trashEntries.length).toBe(2);
    expect(trashEntries.every((e) => e.startsWith('sess-orphan-'))).toBe(true);
  });

  it('moves stale session directories (mtime > staleAfterDays) to .trash/', async () => {
    await seedCheckpoint('sess-fresh');
    await seedCheckpoint('sess-stale', undefined, 90); // 90 days old

    const result = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(['sess-fresh', 'sess-stale']),
      staleAfterDays: 60,
    });

    expect(result.orphansTrashed).toBe(0);
    expect(result.staleTrashed).toBe(1);
    expect(result.trashed).toEqual(['sess-stale']);
  });

  it('skips the _index dir and .trash itself when walking', async () => {
    await mkdir(join(tmpRoot, '_index'), { recursive: true });
    await writeFile(join(tmpRoot, '_index', 'something.json'), '{}', 'utf-8');
    await mkdir(join(tmpRoot, '.trash'), { recursive: true });

    const result = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(),
    });

    // Neither special dir is counted; they don't get nested under .trash.
    expect(result.orphansTrashed).toBe(0);
    expect(result.staleTrashed).toBe(0);
  });

  it('returns zeros (no throw) when baseDir does not exist', async () => {
    const missing = join(tmpRoot, 'nope-not-here');
    const result = await pruneOrphanCheckpoints({
      baseDir: missing,
      knownSessionIds: async () => new Set(),
    });
    expect(result.orphansTrashed).toBe(0);
    expect(result.staleTrashed).toBe(0);
    expect(result.trashEvicted).toBe(0);
  });

  it('evicts prior-cycle .trash/ entries older than trashRetentionDays', async () => {
    // Seed a stale trash entry from a previous prune cycle.
    const trashDir = join(tmpRoot, '.trash');
    await mkdir(trashDir, { recursive: true });
    const oldTrash = join(trashDir, 'sess-old.abc123');
    await mkdir(oldTrash, { recursive: true });
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    await utimes(oldTrash, oldTime, oldTime);

    // And a recent one that should be preserved.
    const recentTrash = join(trashDir, 'sess-recent.def456');
    await mkdir(recentTrash, { recursive: true });

    const result = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(),
      trashRetentionDays: 7,
    });

    expect(result.trashEvicted).toBe(1);
    const remaining = await readdir(trashDir);
    expect(remaining).toEqual(['sess-recent.def456']);
  });

  it('two-cycle recovery: first run trashes, second run evicts after retention', async () => {
    await seedCheckpoint('sess-orphan');

    // First run: orphan goes to .trash/ (recoverable cycle).
    const first = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(),
      trashRetentionDays: 7,
    });
    expect(first.orphansTrashed).toBe(1);
    expect(first.trashEvicted).toBe(0);

    // The recovery file still exists — operator could move it back.
    const trashEntries = await readdir(join(tmpRoot, '.trash'));
    expect(trashEntries.length).toBe(1);

    // Backdate the trash entry to simulate "8 days later".
    const past = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(join(tmpRoot, '.trash', trashEntries[0]!), past, past);

    // Second run: same conditions but now the .trash entry is older than
    // the retention cap.
    const second = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(),
      trashRetentionDays: 7,
    });
    expect(second.trashEvicted).toBe(1);
  });

  it('dryRunTrashDelete=true skips destructive eviction', async () => {
    const trashDir = join(tmpRoot, '.trash');
    await mkdir(trashDir, { recursive: true });
    const oldTrash = join(trashDir, 'stale.entry');
    await mkdir(oldTrash, { recursive: true });
    const oldTime = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await utimes(oldTrash, oldTime, oldTime);

    const result = await pruneOrphanCheckpoints({
      baseDir: tmpRoot,
      knownSessionIds: async () => new Set(),
      trashRetentionDays: 7,
      dryRunTrashDelete: true,
    });

    expect(result.trashEvicted).toBe(0);
    const remaining = await readdir(trashDir);
    expect(remaining).toEqual(['stale.entry']);
  });

  it('formatPruneSummary produces a stable log string', () => {
    const summary = formatPruneSummary({
      orphansTrashed: 17,
      staleTrashed: 3,
      trashEvicted: 12,
      trashed: [],
    });
    expect(summary).toContain('17 orphan');
    expect(summary).toContain('3 stale');
    expect(summary).toContain('12 from previous run');
  });

  it('handles singular wording for one orphan', () => {
    expect(formatPruneSummary({
      orphansTrashed: 1, staleTrashed: 0, trashEvicted: 0, trashed: [],
    })).toContain('1 orphan,'); // singular "orphan" not "orphans"
  });
});

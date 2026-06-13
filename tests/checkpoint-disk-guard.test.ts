/**
 * #307 (v0.9.1 Sentinel): Checkpoints v2 disk guardrail.
 *
 * Focused on the `maxDiskMB` axis: eviction order (oldest-first), enforcement
 * even when age + count would allow more, pinned bytes being immovable, the
 * `diskBudgetUnmet` warning flag, and the default JSON-byte sizer.
 */

import { describe, expect, it } from 'vitest';
import type { SessionCheckpoint } from '@crowclaw/core';
import { pruneCheckpoints, type CheckpointPruneStore } from '@crowclaw/storage';

const DAY_MS = 24 * 60 * 60 * 1000;
const BYTES_PER_MB = 1024 * 1024;
const FIXED_NOW = Date.parse('2026-06-13T00:00:00.000Z');
const now = () => FIXED_NOW;

function makeCheckpoint(id: string, daysOld: number, iteration: number): SessionCheckpoint {
  return {
    id,
    sessionId: 'sess-1',
    iteration,
    createdAt: new Date(FIXED_NOW - daysOld * DAY_MS).toISOString(),
    messages: [],
    messageCursor: 0,
    toolResults: [],
    metadata: {
      agentId: 'agent-1',
      messageCount: 0,
      toolCallCount: 0,
      trigger: 'iteration',
    },
  };
}

class FakeStore implements CheckpointPruneStore {
  private readonly map = new Map<string, SessionCheckpoint>();
  constructor(checkpoints: SessionCheckpoint[]) {
    for (const cp of checkpoints) this.map.set(cp.id, cp);
  }
  async listAll(): Promise<SessionCheckpoint[]> {
    return [...this.map.values()];
  }
  async delete(id: string): Promise<boolean> {
    return this.map.delete(id);
  }
  has(id: string): boolean {
    return this.map.has(id);
  }
  get size(): number {
    return this.map.size;
  }
}

/** Fixed-size sizer: every checkpoint is exactly `mb` megabytes. */
const fixedSizer =
  (mb: number) =>
  (): number =>
    mb * BYTES_PER_MB;

describe('pruneCheckpoints (#307) — disk guardrail', () => {
  it('evicts oldest-first until total size is under maxDiskMB', async () => {
    // 5 checkpoints x 1 MB each = 5 MB; budget 3 MB → evict 2 oldest.
    const store = new FakeStore([
      makeCheckpoint('cp-1', 5, 1),
      makeCheckpoint('cp-2', 4, 2),
      makeCheckpoint('cp-3', 3, 3),
      makeCheckpoint('cp-4', 2, 4),
      makeCheckpoint('cp-5', 1, 5),
    ]);

    const result = await pruneCheckpoints(store, { maxDiskMB: 3 }, { now, sizeOf: fixedSizer(1) });

    expect(result.diskEvicted).toBe(2);
    expect(store.has('cp-1')).toBe(false);
    expect(store.has('cp-2')).toBe(false);
    expect(store.has('cp-3')).toBe(true);
    expect(store.has('cp-4')).toBe(true);
    expect(store.has('cp-5')).toBe(true);
    // Oldest first.
    expect(result.evictions.map((e) => e.id)).toEqual(['cp-1', 'cp-2']);
    expect(result.evictions.every((e) => e.reason === 'disk')).toBe(true);
    expect(result.bytesFreed).toBe(2 * BYTES_PER_MB);
  });

  it('enforces maxDiskMB even when count + age would allow more', async () => {
    // All fresh (1 day old), only 3 checkpoints → maxAgeDays:30 and
    // maxCount:100 both permit all 3. But 3 x 2 MB = 6 MB > 4 MB budget.
    const store = new FakeStore([
      makeCheckpoint('cp-1', 1, 1),
      makeCheckpoint('cp-2', 1, 2),
      makeCheckpoint('cp-3', 1, 3),
    ]);

    const result = await pruneCheckpoints(
      store,
      { maxAgeDays: 30, maxCount: 100, maxDiskMB: 4 },
      { now, sizeOf: fixedSizer(2) },
    );

    expect(result.agedOut).toBe(0);
    expect(result.countEvicted).toBe(0);
    expect(result.diskEvicted).toBe(1); // evict 1 oldest → 4 MB == budget.
    expect(store.has('cp-1')).toBe(false);
    expect(store.size).toBe(2);
    expect(result.diskBudgetUnmet).toBe(false);
  });

  it('does nothing when total size is already under budget', async () => {
    const store = new FakeStore([makeCheckpoint('cp-1', 1, 1), makeCheckpoint('cp-2', 1, 2)]);
    const result = await pruneCheckpoints(store, { maxDiskMB: 10 }, { now, sizeOf: fixedSizer(1) });
    expect(result.diskEvicted).toBe(0);
    expect(store.size).toBe(2);
  });

  it('skips pinned checkpoints and flags diskBudgetUnmet when only pinned remain over budget', async () => {
    // 3 pinned x 2 MB = 6 MB, all pinned, budget 2 MB. Nothing evictable.
    const store = new FakeStore([
      makeCheckpoint('cp-1', 3, 1),
      makeCheckpoint('cp-2', 2, 2),
      makeCheckpoint('cp-3', 1, 3),
    ]);

    const result = await pruneCheckpoints(
      store,
      { maxDiskMB: 2, pinnedIds: ['cp-1', 'cp-2', 'cp-3'] },
      { now, sizeOf: fixedSizer(2) },
    );

    expect(result.diskEvicted).toBe(0);
    expect(result.pinnedSkipped).toBe(3);
    expect(result.diskBudgetUnmet).toBe(true);
    expect(store.size).toBe(3);
  });

  it('evicts only non-pinned to meet budget; pinned bytes count toward total', async () => {
    // cp-pin (pinned, 3 MB, oldest), cp-a 1 MB, cp-b 1 MB, cp-c 1 MB.
    // Total 6 MB, budget 4 MB. Pinned cannot move → must evict 2 of the
    // non-pinned MBs. Oldest non-pinned first: cp-a, then cp-b.
    const store = new FakeStore([
      makeCheckpoint('cp-pin', 10, 1),
      makeCheckpoint('cp-a', 3, 2),
      makeCheckpoint('cp-b', 2, 3),
      makeCheckpoint('cp-c', 1, 4),
    ]);

    const sizeOf = (cp: SessionCheckpoint): number => (cp.id === 'cp-pin' ? 3 * BYTES_PER_MB : 1 * BYTES_PER_MB);

    const result = await pruneCheckpoints(store, { maxDiskMB: 4, pinnedIds: ['cp-pin'] }, { now, sizeOf });

    expect(store.has('cp-pin')).toBe(true);
    expect(result.diskEvicted).toBe(2);
    expect(result.evictions.map((e) => e.id)).toEqual(['cp-a', 'cp-b']);
    expect(store.has('cp-c')).toBe(true);
    expect(result.diskBudgetUnmet).toBe(false);
  });

  it('maxDiskMB:0 evicts every non-pinned checkpoint', async () => {
    const store = new FakeStore([makeCheckpoint('cp-1', 1, 1), makeCheckpoint('cp-2', 1, 2)]);
    const result = await pruneCheckpoints(store, { maxDiskMB: 0 }, { now, sizeOf: fixedSizer(1) });
    expect(result.diskEvicted).toBe(2);
    expect(store.size).toBe(0);
    expect(result.diskBudgetUnmet).toBe(false);
  });

  it('default JSON-byte sizer reports a non-zero bytesFreed', async () => {
    // No sizeOf override → uses Buffer.byteLength(JSON.stringify(cp)). Each
    // checkpoint is a few hundred bytes, so a 0 MB budget evicts both and
    // frees > 0 bytes.
    const store = new FakeStore([makeCheckpoint('cp-1', 1, 1), makeCheckpoint('cp-2', 1, 2)]);
    const result = await pruneCheckpoints(store, { maxDiskMB: 0 }, { now });
    expect(result.diskEvicted).toBe(2);
    expect(result.bytesFreed).toBeGreaterThan(0);
  });

  it('age + disk compose: age evicts first, disk evicts the remaining overflow', async () => {
    // cp-old is 40 days old (age-evicted at maxAgeDays:30). Remaining 3 fresh
    // x 2 MB = 6 MB > 4 MB → disk evicts 1 more (oldest remaining).
    const store = new FakeStore([
      makeCheckpoint('cp-old', 40, 1),
      makeCheckpoint('cp-a', 3, 2),
      makeCheckpoint('cp-b', 2, 3),
      makeCheckpoint('cp-c', 1, 4),
    ]);

    const result = await pruneCheckpoints(
      store,
      { maxAgeDays: 30, maxDiskMB: 4 },
      { now, sizeOf: fixedSizer(2) },
    );

    expect(result.agedOut).toBe(1);
    expect(result.diskEvicted).toBe(1);
    expect(store.has('cp-old')).toBe(false);
    expect(store.has('cp-a')).toBe(false); // oldest remaining after age sweep
    expect(store.has('cp-b')).toBe(true);
    expect(store.has('cp-c')).toBe(true);
    // age-evicted bytes do NOT re-count toward the disk total (excluded via
    // the `evicted` set), so disk only had to free the real overflow.
    expect(result.bytesFreed).toBe(2 * 2 * BYTES_PER_MB);
  });
});

/**
 * #307 (v0.9.1 Sentinel): Checkpoints v2 pruner — age + count eviction,
 * pinned-skip, idempotency, empty-store no-op, two-cycle trash recovery.
 *
 * Disk-budget eviction has its own focused suite in
 * `checkpoint-disk-guard.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import type { SessionCheckpoint } from '@crowclaw/core';
import {
  pruneCheckpoints,
  formatCheckpointPruneSummary,
  type CheckpointPruneStore,
  type CheckpointTrash,
} from '@crowclaw/storage';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = Date.parse('2026-06-13T00:00:00.000Z');

function makeCheckpoint(overrides: Partial<SessionCheckpoint> & { id: string }): SessionCheckpoint {
  return {
    id: overrides.id,
    sessionId: overrides.sessionId ?? 'sess-1',
    iteration: overrides.iteration ?? 0,
    createdAt: overrides.createdAt ?? new Date(FIXED_NOW).toISOString(),
    messages: overrides.messages ?? [],
    messageCursor: overrides.messageCursor ?? 0,
    toolResults: overrides.toolResults ?? [],
    metadata: overrides.metadata ?? {
      agentId: 'agent-1',
      messageCount: 0,
      toolCallCount: 0,
      trigger: 'iteration',
    },
    loopState: overrides.loopState,
  };
}

/** Days-ago ISO timestamp relative to the fixed test clock. */
function daysAgo(days: number): string {
  return new Date(FIXED_NOW - days * DAY_MS).toISOString();
}

/** Minimal in-memory store satisfying CheckpointPruneStore for the pruner. */
class FakeStore implements CheckpointPruneStore {
  private readonly map = new Map<string, SessionCheckpoint>();

  constructor(checkpoints: SessionCheckpoint[] = []) {
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

const now = () => FIXED_NOW;

describe('pruneCheckpoints (#307) — age eviction', () => {
  it('evicts a 31-day-old checkpoint with maxAgeDays:30', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(31), iteration: 1 }),
      makeCheckpoint({ id: 'cp-fresh', createdAt: daysAgo(1), iteration: 2 }),
    ]);

    const result = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now });

    expect(result.agedOut).toBe(1);
    expect(result.evictions).toHaveLength(1);
    expect(result.evictions[0]!.id).toBe('cp-old');
    expect(result.evictions[0]!.reason).toBe('age');
    expect(store.has('cp-old')).toBe(false);
    expect(store.has('cp-fresh')).toBe(true);
  });

  it('keeps a checkpoint exactly at the age boundary (not strictly older)', async () => {
    const store = new FakeStore([
      // Exactly 30 days old → cutoff is `now - 30d`; createdMs === cutoff is
      // NOT strictly less than cutoff, so it survives.
      makeCheckpoint({ id: 'cp-boundary', createdAt: daysAgo(30) }),
    ]);

    const result = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now });

    expect(result.agedOut).toBe(0);
    expect(store.has('cp-boundary')).toBe(true);
  });

  it('does nothing when maxAgeDays is undefined', async () => {
    const store = new FakeStore([makeCheckpoint({ id: 'cp-ancient', createdAt: daysAgo(9999) })]);
    const result = await pruneCheckpoints(store, {}, { now });
    expect(result.agedOut).toBe(0);
    expect(store.has('cp-ancient')).toBe(true);
  });
});

describe('pruneCheckpoints (#307) — count cap', () => {
  it('keeps the newest maxCount and evicts the oldest overflow', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-1', createdAt: daysAgo(5), iteration: 1 }),
      makeCheckpoint({ id: 'cp-2', createdAt: daysAgo(4), iteration: 2 }),
      makeCheckpoint({ id: 'cp-3', createdAt: daysAgo(3), iteration: 3 }),
      makeCheckpoint({ id: 'cp-4', createdAt: daysAgo(2), iteration: 4 }),
      makeCheckpoint({ id: 'cp-5', createdAt: daysAgo(1), iteration: 5 }),
    ]);

    const result = await pruneCheckpoints(store, { maxCount: 2 }, { now });

    expect(result.countEvicted).toBe(3);
    // Oldest three evicted, newest two kept.
    expect(store.has('cp-1')).toBe(false);
    expect(store.has('cp-2')).toBe(false);
    expect(store.has('cp-3')).toBe(false);
    expect(store.has('cp-4')).toBe(true);
    expect(store.has('cp-5')).toBe(true);
    expect(result.evictions.map((e) => e.id).sort()).toEqual(['cp-1', 'cp-2', 'cp-3']);
    expect(result.evictions.every((e) => e.reason === 'count')).toBe(true);
  });

  it('does nothing when count is already under the cap', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-1', iteration: 1 }),
      makeCheckpoint({ id: 'cp-2', iteration: 2 }),
    ]);
    const result = await pruneCheckpoints(store, { maxCount: 10 }, { now });
    expect(result.countEvicted).toBe(0);
    expect(store.size).toBe(2);
  });

  it('maxCount:0 evicts every non-pinned checkpoint', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-1' }),
      makeCheckpoint({ id: 'cp-2' }),
    ]);
    const result = await pruneCheckpoints(store, { maxCount: 0 }, { now });
    expect(result.countEvicted).toBe(2);
    expect(store.size).toBe(0);
  });
});

describe('pruneCheckpoints (#307) — pinned skip', () => {
  it('pinned ids survive age eviction', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-pinned', createdAt: daysAgo(99) }),
      makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(99) }),
    ]);

    const result = await pruneCheckpoints(store, { maxAgeDays: 30, pinnedIds: ['cp-pinned'] }, { now });

    expect(result.agedOut).toBe(1);
    expect(result.pinnedSkipped).toBe(1);
    expect(store.has('cp-pinned')).toBe(true);
    expect(store.has('cp-old')).toBe(false);
  });

  it('pinned ids survive count eviction even when they are the oldest', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-pinned-oldest', createdAt: daysAgo(10), iteration: 1 }),
      makeCheckpoint({ id: 'cp-a', createdAt: daysAgo(3), iteration: 2 }),
      makeCheckpoint({ id: 'cp-b', createdAt: daysAgo(2), iteration: 3 }),
      makeCheckpoint({ id: 'cp-c', createdAt: daysAgo(1), iteration: 4 }),
    ]);

    // maxCount applies to SURVIVORS only — pinned is kept on top of the cap.
    const result = await pruneCheckpoints(store, { maxCount: 1, pinnedIds: ['cp-pinned-oldest'] }, { now });

    expect(store.has('cp-pinned-oldest')).toBe(true);
    // 3 non-pinned survivors, cap 1 → evict 2 oldest non-pinned (cp-a, cp-b).
    expect(result.countEvicted).toBe(2);
    expect(store.has('cp-a')).toBe(false);
    expect(store.has('cp-b')).toBe(false);
    expect(store.has('cp-c')).toBe(true);
  });

  it('honors a top-level `pinned: true` flag on the record', async () => {
    const flagged = makeCheckpoint({ id: 'cp-flag', createdAt: daysAgo(99) });
    (flagged as SessionCheckpoint & { pinned?: boolean }).pinned = true;
    const store = new FakeStore([flagged]);

    const result = await pruneCheckpoints(store, { maxAgeDays: 1 }, { now });

    expect(result.agedOut).toBe(0);
    expect(result.pinnedSkipped).toBe(1);
    expect(store.has('cp-flag')).toBe(true);
  });

  it('honors a `metadata.pinned: true` flag', async () => {
    const flagged = makeCheckpoint({
      id: 'cp-meta-flag',
      createdAt: daysAgo(99),
      metadata: {
        agentId: 'agent-1',
        messageCount: 0,
        toolCallCount: 0,
        trigger: 'manual',
        ...({ pinned: true } as Record<string, unknown>),
      } as SessionCheckpoint['metadata'],
    });
    const store = new FakeStore([flagged]);

    const result = await pruneCheckpoints(store, { maxAgeDays: 1, maxCount: 0 }, { now });

    expect(result.agedOut).toBe(0);
    expect(result.countEvicted).toBe(0);
    expect(store.has('cp-meta-flag')).toBe(true);
  });
});

describe('pruneCheckpoints (#307) — idempotency & no-op', () => {
  it('is idempotent — a second run on a compliant store evicts nothing', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(40), iteration: 1 }),
      makeCheckpoint({ id: 'cp-fresh', createdAt: daysAgo(1), iteration: 2 }),
    ]);

    const first = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now });
    expect(first.agedOut).toBe(1);

    const second = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now });
    expect(second.agedOut).toBe(0);
    expect(second.countEvicted).toBe(0);
    expect(second.diskEvicted).toBe(0);
    expect(second.evictions).toHaveLength(0);
  });

  it('empty store is a no-op returning zeros', async () => {
    const store = new FakeStore([]);
    const result = await pruneCheckpoints(store, { maxAgeDays: 30, maxCount: 10, maxDiskMB: 1 }, { now });
    expect(result.scanned).toBe(0);
    expect(result.agedOut).toBe(0);
    expect(result.countEvicted).toBe(0);
    expect(result.diskEvicted).toBe(0);
    expect(result.bytesFreed).toBe(0);
    expect(result.evictions).toHaveLength(0);
  });

  it('does not throw when listAll rejects (unreadable store)', async () => {
    const broken: CheckpointPruneStore = {
      listAll: async () => {
        throw new Error('ENOENT');
      },
      delete: async () => false,
    };
    const result = await pruneCheckpoints(broken, { maxAgeDays: 30 }, { now });
    expect(result.scanned).toBe(0);
    expect(result.evictions).toHaveLength(0);
  });

  it('a per-entry delete failure does not abort the sweep', async () => {
    const store = new FakeStore([
      makeCheckpoint({ id: 'cp-bad', createdAt: daysAgo(40), iteration: 1 }),
      makeCheckpoint({ id: 'cp-good', createdAt: daysAgo(40), iteration: 2 }),
    ]);
    const guarded: CheckpointPruneStore = {
      listAll: () => store.listAll(),
      delete: async (id) => {
        if (id === 'cp-bad') throw new Error('EACCES');
        return store.delete(id);
      },
    };

    const result = await pruneCheckpoints(guarded, { maxAgeDays: 30 }, { now });

    // cp-bad's delete threw → not counted; cp-good still evicted.
    expect(result.agedOut).toBe(1);
    expect(result.evictions[0]!.id).toBe('cp-good');
    expect(store.has('cp-bad')).toBe(true);
    expect(store.has('cp-good')).toBe(false);
  });
});

describe('pruneCheckpoints (#307) — two-cycle trash recovery', () => {
  it('soft-deletes to trash (recoverable) when a trash adapter is supplied', async () => {
    const store = new FakeStore([makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(40) })]);
    const trashed: SessionCheckpoint[] = [];
    const trash: CheckpointTrash = {
      trash: async (cp) => {
        trashed.push(cp);
      },
      sweep: async () => 0,
    };

    const result = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now, trash });

    expect(result.agedOut).toBe(1);
    expect(result.evictions[0]!.trashed).toBe(true);
    expect(trashed.map((c) => c.id)).toEqual(['cp-old']);
    // Still removed from the live store this cycle.
    expect(store.has('cp-old')).toBe(false);
  });

  it('reclaims prior-cycle trash before evicting new candidates', async () => {
    const store = new FakeStore([makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(40) })]);
    let sweptWith: number | null = null;
    const trash: CheckpointTrash = {
      trash: async () => {},
      sweep: async (retentionDays) => {
        sweptWith = retentionDays;
        return 3;
      },
    };

    const result = await pruneCheckpoints(store, { maxAgeDays: 30, trashRetentionDays: 5 }, { now, trash });

    expect(result.trashReclaimed).toBe(3);
    expect(sweptWith).toBe(5);
  });

  it('a trash.sweep failure does not abort the live sweep', async () => {
    const store = new FakeStore([makeCheckpoint({ id: 'cp-old', createdAt: daysAgo(40) })]);
    const trash: CheckpointTrash = {
      trash: async () => {},
      sweep: async () => {
        throw new Error('trash dir locked');
      },
    };

    const result = await pruneCheckpoints(store, { maxAgeDays: 30 }, { now, trash });

    expect(result.trashReclaimed).toBe(0);
    expect(result.agedOut).toBe(1);
    expect(store.has('cp-old')).toBe(false);
  });
});

describe('formatCheckpointPruneSummary (#307)', () => {
  it('produces a stable, emoji-free log string', () => {
    const summary = formatCheckpointPruneSummary({
      scanned: 100,
      agedOut: 5,
      countEvicted: 3,
      diskEvicted: 2,
      pinnedSkipped: 1,
      trashReclaimed: 4,
      bytesFreed: 2 * 1024 * 1024,
      diskBudgetUnmet: false,
      evictions: [],
    });
    expect(summary).toContain('scanned 100');
    expect(summary).toContain('5 by age');
    expect(summary).toContain('3 by count');
    expect(summary).toContain('2 by disk');
    expect(summary).toContain('2.00 MB');
    expect(summary).toContain('1 pinned');
    expect(summary).toContain('4 from trash');
    // No emoji bytes.
    // eslint-disable-next-line no-control-regex
    expect(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(summary)).toBe(false);
  });

  it('appends a warning when the disk budget could not be met', () => {
    const summary = formatCheckpointPruneSummary({
      scanned: 1,
      agedOut: 0,
      countEvicted: 0,
      diskEvicted: 0,
      pinnedSkipped: 1,
      trashReclaimed: 0,
      bytesFreed: 0,
      diskBudgetUnmet: true,
      evictions: [],
    });
    expect(summary).toContain('WARNING disk budget unmet');
  });
});

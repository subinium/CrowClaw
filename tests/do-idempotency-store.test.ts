/**
 * Issue #159 — focused unit tests for `DurableObjectIdempotencyStore`.
 *
 * The leak-fix sweep in `v06-leak-fixes.test.ts` already pins #117 (maxEntries
 * cap) and #153 (concurrent hydrate serialization). This file is the dedicated
 * unit suite called out in #159 and exercises four orthogonal contracts of the
 * store so future regressions surface here directly:
 *
 *   (a) Concurrent `markIfAbsent` calls for the SAME key resolve to exactly one
 *       `true` and the rest `false` — the store must not race-double-mark.
 *   (b) TTL expiry + eviction — keys past `expiresAt` are dropped on the next
 *       access path that runs `evict()` (`markIfAbsent` / `has`).
 *   (c) Storage round-trip on hydrate — entries persisted to DO storage are
 *       restored after a fresh instance is constructed against the same backing
 *       storage; expired entries in the snapshot are filtered on load.
 *   (d) maxEntries cap eviction path — when the cap is exceeded, eviction
 *       removes oldest-inserted keys first AND the persisted snapshot reflects
 *       the post-eviction set (no stale evicted keys leak back via hydrate).
 *
 * The DO storage interface is mocked with an in-memory `Map` matching the
 * `DurableObjectStateLite['storage']` subset used by the store (get/put/delete).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DurableObjectIdempotencyStore } from '../packages/runtime-cloudflare/src/agent-do.js';

// ---------------------------------------------------------------------------
// Storage mock — minimal shape matching DurableObjectStateLite['storage'].
// Backing data lives in a plain Map so multiple stores can share it (used in
// the hydrate round-trip test).
// ---------------------------------------------------------------------------

interface StorageMock {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  /** Direct access for assertions about persisted state. */
  data: Map<string, unknown>;
}

function makeStorage(initial: Record<string, unknown> = {}): StorageMock {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    data,
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
  };
}

const STORAGE_KEY = 'gateway:idempotency-keys';

// ---------------------------------------------------------------------------
// (a) Concurrent markIfAbsent with the SAME key
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#159a) — concurrent same-key markIfAbsent', () => {
  it('returns true for exactly one caller when many race the same key', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 100 });

    // Fire 10 concurrent attempts on the same key without awaiting.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.markIfAbsent('dup-key')),
    );

    const trues = results.filter((r) => r === true).length;
    const falses = results.filter((r) => r === false).length;
    expect(trues).toBe(1);
    expect(falses).toBe(9);
    expect(store.size).toBe(1);
    expect(await store.has('dup-key')).toBe(true);
  });

  it('serializes hydration so storage.get is called once across racing calls', async () => {
    // Defer storage.get so all racers stack on the same in-flight hydrate.
    let resolveGet: ((value: Record<string, number> | undefined) => void) | null = null;
    const storage = {
      get: vi.fn(
        () =>
          new Promise<Record<string, number> | undefined>((resolve) => {
            resolveGet = resolve;
          }),
      ),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    };
    const store = new DurableObjectIdempotencyStore(storage as never, 60_000, { maxEntries: 100 });

    const p1 = store.markIfAbsent('same');
    const p2 = store.markIfAbsent('same');
    const p3 = store.markIfAbsent('same');

    // All three are blocked on a single in-flight hydrate.
    expect(storage.get).toHaveBeenCalledTimes(1);

    resolveGet!(undefined);
    const results = await Promise.all([p1, p2, p3]);

    expect(results.filter((r) => r === true).length).toBe(1);
    expect(results.filter((r) => r === false).length).toBe(2);
    // Hydrate is memoized — still exactly one storage.get even after resolve.
    expect(storage.get).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (b) TTL expiry + eviction
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#159b) — TTL expiry + eviction', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops keys whose expiresAt is in the past on the next access', async () => {
    const storage = makeStorage();
    const ttlMs = 1_000;
    const store = new DurableObjectIdempotencyStore(storage, ttlMs, { maxEntries: 100 });

    expect(await store.markIfAbsent('short-lived')).toBe(true);
    expect(store.size).toBe(1);
    expect(await store.has('short-lived')).toBe(true);

    // Advance well past TTL. Next access path runs evict() → key is gone.
    vi.advanceTimersByTime(ttlMs + 1);

    expect(await store.has('short-lived')).toBe(false);
    expect(store.size).toBe(0);

    // Re-marking the same key after expiry succeeds (returns true) — the slot
    // is treated as free.
    expect(await store.markIfAbsent('short-lived')).toBe(true);
    expect(store.size).toBe(1);
  });

  it('honors per-call ttlMs override for markIfAbsent', async () => {
    const storage = makeStorage();
    // Default TTL is 1h; per-call override sets a 100ms expiry.
    const store = new DurableObjectIdempotencyStore(storage, 60 * 60 * 1000, { maxEntries: 100 });

    expect(await store.markIfAbsent('per-call', 100)).toBe(true);
    expect(await store.has('per-call')).toBe(true);

    vi.advanceTimersByTime(101);
    expect(await store.has('per-call')).toBe(false);
  });

  it('expires only the entries past TTL, leaving fresh ones intact', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 1_000, { maxEntries: 100 });

    await store.markIfAbsent('old');
    vi.advanceTimersByTime(900);
    await store.markIfAbsent('young');

    // 'old' expires at +1000, 'young' at +1900. Jump to +1100.
    vi.advanceTimersByTime(200);

    expect(await store.has('old')).toBe(false);
    expect(await store.has('young')).toBe(true);
    expect(store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (c) Storage round-trip on hydrate
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#159c) — storage round-trip on hydrate', () => {
  it('persists entries on mark and restores them in a fresh instance', async () => {
    const storage = makeStorage();

    // First store: write three keys.
    const writer = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 100 });
    await writer.markIfAbsent('alpha');
    await writer.markIfAbsent('beta');
    await writer.markIfAbsent('gamma');

    // Storage should now hold the snapshot under the canonical key.
    const persisted = storage.data.get(STORAGE_KEY) as Record<string, number> | undefined;
    expect(persisted).toBeTruthy();
    expect(Object.keys(persisted!).sort()).toEqual(['alpha', 'beta', 'gamma']);

    // Reset the call counter so reader-only behavior is observable.
    storage.get.mockClear();

    // Second store, same backing storage — simulates a DO restart.
    const reader = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 100 });

    // Hydrate is lazy — storage.get is not called until the first await path.
    expect(storage.get).toHaveBeenCalledTimes(0);

    expect(await reader.has('alpha')).toBe(true);
    expect(await reader.has('beta')).toBe(true);
    expect(await reader.has('gamma')).toBe(true);
    expect(await reader.markIfAbsent('alpha')).toBe(false);

    // Reader hydrates exactly once for its lifetime, regardless of access count.
    expect(storage.get).toHaveBeenCalledTimes(1);
  });

  it('filters expired entries from the persisted snapshot at hydrate time', async () => {
    // Pre-seed storage with a snapshot containing one fresh and one expired key.
    const now = Date.now();
    const storage = makeStorage({
      [STORAGE_KEY]: {
        fresh: now + 60_000,
        stale: now - 1, // already expired
      },
    });

    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 100 });

    expect(await store.has('fresh')).toBe(true);
    expect(await store.has('stale')).toBe(false);
    // Only the fresh entry survived hydration → size is 1.
    expect(store.size).toBe(1);
  });

  it('unmark deletes from in-memory map and re-persists the snapshot', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 100 });

    await store.markIfAbsent('keep');
    await store.markIfAbsent('drop');
    storage.put.mockClear();

    await store.unmark('drop');

    // unmark must persist the post-deletion snapshot.
    expect(storage.put).toHaveBeenCalledTimes(1);
    const snapshot = storage.data.get(STORAGE_KEY) as Record<string, number>;
    expect(Object.keys(snapshot).sort()).toEqual(['keep']);
    expect(await store.has('drop')).toBe(false);
    expect(await store.has('keep')).toBe(true);
  });

  it('continues with an empty map when storage.get rejects', async () => {
    const storage = {
      get: vi.fn(async () => {
        throw new Error('storage broken');
      }),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    };
    const store = new DurableObjectIdempotencyStore(storage as never, 60_000, { maxEntries: 100 });

    // Hydrate must swallow the error; markIfAbsent still works.
    expect(await store.markIfAbsent('post-failure')).toBe(true);
    expect(store.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// (d) maxEntries cap eviction path
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#159d) — maxEntries cap eviction', () => {
  it('evicts the oldest-inserted key when the cap is exceeded', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 3 });

    await store.markIfAbsent('k1');
    await store.markIfAbsent('k2');
    await store.markIfAbsent('k3');
    expect(store.size).toBe(3);

    await store.markIfAbsent('k4');
    expect(store.size).toBe(3);
    expect(await store.has('k1')).toBe(false);
    expect(await store.has('k2')).toBe(true);
    expect(await store.has('k3')).toBe(true);
    expect(await store.has('k4')).toBe(true);
  });

  it('persists the post-eviction snapshot — evicted keys do not leak via hydrate', async () => {
    const storage = makeStorage();

    // Phase 1: write past the cap so eviction runs.
    const writer = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 2 });
    await writer.markIfAbsent('a');
    await writer.markIfAbsent('b');
    await writer.markIfAbsent('c'); // evicts 'a'

    // The persisted snapshot must reflect the eviction — only 'b' and 'c'.
    const snapshot = storage.data.get(STORAGE_KEY) as Record<string, number>;
    expect(Object.keys(snapshot).sort()).toEqual(['b', 'c']);
    expect(snapshot).not.toHaveProperty('a');

    // Phase 2: a fresh store reading the same backing storage must NOT see 'a'.
    const reader = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 2 });
    expect(await reader.has('a')).toBe(false);
    expect(await reader.has('b')).toBe(true);
    expect(await reader.has('c')).toBe(true);
  });

  it('keeps evicting as the cap stays saturated across many inserts', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 5 });

    for (let i = 0; i < 20; i++) {
      await store.markIfAbsent(`k${i}`);
    }

    expect(store.size).toBe(5);
    // Only the last 5 (k15..k19) should remain.
    for (let i = 0; i < 15; i++) {
      expect(await store.has(`k${i}`)).toBe(false);
    }
    for (let i = 15; i < 20; i++) {
      expect(await store.has(`k${i}`)).toBe(true);
    }
  });
});

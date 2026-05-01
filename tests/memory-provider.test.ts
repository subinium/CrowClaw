/**
 * v0.8.0 Hermes parity (#233) — pluggable MemoryProvider ABC.
 *
 * These tests cover the new provider interface: parity with the legacy
 * MemoryService recall path, prefetch precedence over recall in the runtime,
 * fire-and-forget sync_turn semantics, and the documented 10s shutdown cap.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryMemoryProvider,
  MemoryService,
  type MemoryProvider,
  type MemoryScope,
  type ProviderMemoryRecord,
} from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';

// ---------------------------------------------------------------------------
// InMemoryMemoryProvider — parity with the legacy MemoryService cases
// ---------------------------------------------------------------------------

describe('InMemoryMemoryProvider', () => {
  it('captures and recalls session summaries (parity with MemoryService)', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.captureSessionSummary!('session-1', [
      { role: 'user', content: 'Need help deploying crowclaw to cloudflare workers with sandbox', createdAt: new Date().toISOString() },
    ]);

    const results = await provider.recall('session-1', 'cloudflare', 5);
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain('cloudflare');
  });

  it('store() persists and returns a record with id+createdAt populated', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    const saved = await provider.store({
      sessionId: 'session-1',
      scope: 'session',
      summary: 'remember this important fact',
      tags: ['Important', 'fact', 'IMPORTANT'],
    });

    expect(saved.id).toBeTruthy();
    expect(saved.createdAt).toBeTruthy();
    // uniqueTags lowercases + dedupes
    expect(saved.tags).toEqual(['important', 'fact']);

    const listed = await provider.list('session-1');
    expect(listed.some((r) => r.id === saved.id)).toBe(true);
  });

  it('list() filters by scope when provided', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.store({ sessionId: 's1', scope: 'session', summary: 'session note', tags: [] });
    await provider.store({ sessionId: 's1', scope: 'user', summary: 'user note', tags: [], scopeKey: 'user-a' });

    const sessionRecords = await provider.list('s1');
    expect(sessionRecords.some((r) => r.summary === 'session note')).toBe(true);

    const userRecords = await provider.list('s1', 'user' as MemoryScope, 50);
    expect(userRecords.every((r) => r.scope === 'user')).toBe(true);
  });

  it('listByScope() narrows by scopeKey', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.store({ sessionId: 's1', scope: 'user', scopeKey: 'user-alpha', summary: 'alpha note', tags: [] });
    await provider.store({ sessionId: 's2', scope: 'user', scopeKey: 'user-beta', summary: 'beta note', tags: [] });

    const alpha = await provider.listByScope!('user', 50, 'user-alpha');
    expect(alpha).toHaveLength(1);
    expect(alpha[0]?.scopeKey).toBe('user-alpha');
    expect(alpha[0]?.summary).toContain('alpha');
  });

  it('default prefetch delegates to recall', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    await provider.captureSessionSummary!('session-1', [
      { role: 'user', content: 'remember the cloudflare deployment trick', createdAt: new Date().toISOString() },
    ]);

    const prefetched = await provider.prefetch('session-1', 'cloudflare', 5);
    const recalled = await provider.recall('session-1', 'cloudflare', 5);
    expect(prefetched.map((r) => r.id)).toEqual(recalled.map((r) => r.id));
  });

  it('shutdown() resolves immediately when no sync_turn is in flight', async () => {
    const store = new InMemoryMemoryStore();
    const provider = new InMemoryMemoryProvider(store);

    const start = Date.now();
    await provider.shutdown!();
    expect(Date.now() - start).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// MemoryService facade — backwards compatibility
// ---------------------------------------------------------------------------

describe('MemoryService facade with injected provider', () => {
  it('delegates recall to the injected provider', async () => {
    const calls: Array<{ sessionId: string; query: string; limit: number }> = [];
    const fakeProvider: MemoryProvider = {
      async recall(sessionId, query, limit) {
        calls.push({ sessionId, query, limit });
        return [];
      },
      async store() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, fakeProvider);

    await service.recall('session-x', 'hello', 3);
    expect(calls).toEqual([{ sessionId: 'session-x', query: 'hello', limit: 3 }]);
  });

  it('captureSessionSummary fires sync_turn fire-and-forget on the provider', async () => {
    let syncCalls = 0;
    let syncResolve!: () => void;
    const blocked = new Promise<void>((resolve) => {
      syncResolve = resolve;
    });

    const fakeProvider: MemoryProvider = {
      async recall() {
        return [];
      },
      async store() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
      async sync_turn() {
        syncCalls++;
        // Block to prove the caller doesn't await us.
        await blocked;
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, fakeProvider);

    const before = Date.now();
    await service.captureSessionSummary('session-1', [
      { role: 'user', content: 'something to remember', createdAt: new Date().toISOString() },
    ]);
    const elapsed = Date.now() - before;

    // captureSessionSummary returned without awaiting the still-blocked sync_turn.
    expect(elapsed).toBeLessThan(100);
    expect(syncCalls).toBe(1);

    // Unblock so the test cleans up.
    syncResolve();
    await blocked;
  });

  it('prefetch on the facade prefers provider.prefetch when defined', async () => {
    let prefetchCalls = 0;
    let recallCalls = 0;
    const fakeProvider: MemoryProvider = {
      async prefetch() {
        prefetchCalls++;
        return [];
      },
      async recall() {
        recallCalls++;
        return [];
      },
      async store() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, fakeProvider);

    await service.prefetch('session-1', 'q', 5);
    expect(prefetchCalls).toBe(1);
    expect(recallCalls).toBe(0);
  });

  it('prefetch on the facade falls back to recall when provider has no prefetch', async () => {
    let recallCalls = 0;
    const fakeProvider: MemoryProvider = {
      async recall() {
        recallCalls++;
        return [];
      },
      async store() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, fakeProvider);

    await service.prefetch('session-1', 'q', 5);
    expect(recallCalls).toBe(1);
  });

  it('shutdown() forwards to the provider when defined', async () => {
    let shutdownCalls = 0;
    const fakeProvider: MemoryProvider = {
      async recall() {
        return [];
      },
      async store() {
        throw new Error('not used');
      },
      async delete() {
        return false;
      },
      async list() {
        return [];
      },
      async shutdown() {
        shutdownCalls++;
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, fakeProvider);

    await service.shutdown();
    expect(shutdownCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Mock provider — runtime safety net
// ---------------------------------------------------------------------------

describe('MockMemoryProvider (no-op) injected into MemoryService', () => {
  it('chat-style flow completes without error and recall returns []', async () => {
    const noopProvider: MemoryProvider = {
      async recall() {
        return [];
      },
      async store(record): Promise<ProviderMemoryRecord> {
        return {
          ...record,
          id: 'mock-id',
          createdAt: new Date().toISOString(),
        } as ProviderMemoryRecord;
      },
      async delete() {
        return true;
      },
      async list() {
        return [];
      },
    };

    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store, undefined, noopProvider);

    // Recall path: returns empty.
    const recalled = await service.recall('any-session', 'any-query', 5);
    expect(recalled).toEqual([]);

    // Capture path: facade still writes to its own store; provider is silent.
    const captured = await service.captureSessionSummary('any-session', [
      { role: 'user', content: 'noop test', createdAt: new Date().toISOString() },
    ]);
    expect(captured).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Shutdown drain semantics
// ---------------------------------------------------------------------------

describe('InMemoryMemoryProvider.shutdown drain', () => {
  it('waits for in-flight sync_turn promises before resolving', async () => {
    const store = new InMemoryMemoryStore();

    // Override sync_turn with a deliberately slow body so we can prove
    // shutdown waits for it. We re-track the promise into the same
    // inFlight set the base class uses by going through the public hook.
    class SlowProvider extends InMemoryMemoryProvider {
      public unblock!: () => void;
      async sync_turn(): Promise<void> {
        // Schedule the work, register it, AND make shutdown wait for it.
        const work = new Promise<void>((resolve) => {
          this.unblock = resolve;
        });
        // Track via the parent's set by shadowing.
        const tracked = work.catch(() => undefined);
        (this as unknown as { inFlight: Set<Promise<void>> }).inFlight.add(tracked);
        tracked.finally(() => {
          (this as unknown as { inFlight: Set<Promise<void>> }).inFlight.delete(tracked);
        });
        return work;
      }
    }

    const provider = new SlowProvider(store);
    void provider.sync_turn('s1', 'summary', {});

    let shutdownDone = false;
    const shutdownPromise = provider.shutdown!().then(() => {
      shutdownDone = true;
    });

    // Tick once: shutdown should still be pending because sync_turn is blocked.
    await Promise.resolve();
    expect(shutdownDone).toBe(false);

    // Now unblock and confirm shutdown resolves.
    provider.unblock();
    await shutdownPromise;
    expect(shutdownDone).toBe(true);
  });

  it('caps the wait at the configured timeout (default 10s)', async () => {
    const store = new InMemoryMemoryStore();

    class StuckProvider extends InMemoryMemoryProvider {
      async sync_turn(): Promise<void> {
        // Never resolves. Track it so shutdown sees it.
        const work = new Promise<void>(() => {});
        const tracked = work.catch(() => undefined);
        (this as unknown as { inFlight: Set<Promise<void>> }).inFlight.add(tracked);
        return work;
      }
    }

    const provider = new StuckProvider(store);
    void provider.sync_turn('s1', 'summary', {});

    const start = Date.now();
    // Use a small cap to keep the test fast — same code path as the 10s default.
    await provider.shutdown!(50);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(500);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MemoryManager,
  BuiltInMemoryProvider,
  type LegacyMemoryProvider as MemoryProvider,
  type ManagerMemoryRecord,
} from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a BuiltInMemoryProvider backed by a fresh InMemoryMemoryStore. */
function createBuiltInProvider(name: string): BuiltInMemoryProvider {
  return new BuiltInMemoryProvider(new InMemoryMemoryStore(), name);
}

/**
 * Minimal in-memory MemoryProvider for testing multi-provider scenarios
 * without depending on the storage layer.
 */
function createFakeProvider(name: string): MemoryProvider & { records: Map<string, ManagerMemoryRecord> } {
  const records = new Map<string, ManagerMemoryRecord>();
  return {
    name,
    records,
    async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
      records.set(key, {
        key,
        content,
        metadata,
        createdAt: new Date().toISOString(),
      });
    },
    async recall(query: string, limit = 10): Promise<ManagerMemoryRecord[]> {
      const matches = [...records.values()]
        .filter((r) => r.content.toLowerCase().includes(query.toLowerCase()))
        .slice(0, limit);
      return matches;
    },
    async forget(key: string): Promise<boolean> {
      return records.delete(key);
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryManager', () => {
  it('stores to all providers and recalls merged results', async () => {
    const manager = new MemoryManager();
    const providerA = createFakeProvider('provider-a');
    const providerB = createFakeProvider('provider-b');
    manager.addProvider(providerA);
    manager.addProvider(providerB);

    await manager.store('greeting', 'hello world');

    // Both providers should have the record
    expect(providerA.records.has('greeting')).toBe(true);
    expect(providerB.records.has('greeting')).toBe(true);

    const results = await manager.recall('hello');
    // Deduplicated: same key from two providers should yield one result
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('hello world');
  });

  it('deduplicates records by key across providers', async () => {
    const manager = new MemoryManager();
    const providerA = createFakeProvider('provider-a');
    const providerB = createFakeProvider('provider-b');
    manager.addProvider(providerA);
    manager.addProvider(providerB);

    await manager.store('note-1', 'typescript patterns');
    await manager.store('note-2', 'rust patterns');

    const results = await manager.recall('patterns');
    // Two distinct keys, both matching — should get exactly 2
    expect(results).toHaveLength(2);
    const keys = results.map((r) => r.key);
    expect(keys).toContain('note-1');
    expect(keys).toContain('note-2');
  });

  it('prefers higher-scored records during deduplication', async () => {
    const manager = new MemoryManager();

    // Provider that returns records with a low score
    const lowScoreProvider: MemoryProvider = {
      name: 'low-score',
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> {
        return [{ key: 'info', content: 'low relevance', score: 0.3, createdAt: '2026-01-01T00:00:00Z' }];
      },
      async forget(): Promise<boolean> { return true; },
    };

    // Provider that returns records with a high score
    const highScoreProvider: MemoryProvider = {
      name: 'high-score',
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> {
        return [{ key: 'info', content: 'high relevance', score: 0.9, createdAt: '2026-01-01T00:00:00Z' }];
      },
      async forget(): Promise<boolean> { return true; },
    };

    manager.addProvider(lowScoreProvider);
    manager.addProvider(highScoreProvider);

    const results = await manager.recall('anything');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('high relevance');
    expect(results[0]?.score).toBe(0.9);
  });

  it('prefers more recent records when scores are equal', async () => {
    const manager = new MemoryManager();

    const olderProvider: MemoryProvider = {
      name: 'older',
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> {
        return [{ key: 'data', content: 'old version', createdAt: '2025-01-01T00:00:00Z' }];
      },
      async forget(): Promise<boolean> { return true; },
    };

    const newerProvider: MemoryProvider = {
      name: 'newer',
      async store(): Promise<void> {},
      async recall(): Promise<ManagerMemoryRecord[]> {
        return [{ key: 'data', content: 'new version', createdAt: '2026-04-14T00:00:00Z' }];
      },
      async forget(): Promise<boolean> { return true; },
    };

    manager.addProvider(olderProvider);
    manager.addProvider(newerProvider);

    const results = await manager.recall('version');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toBe('new version');
  });

  it('forgets from all providers and returns true when at least one succeeds', async () => {
    const manager = new MemoryManager();
    const providerA = createFakeProvider('provider-a');
    const providerB = createFakeProvider('provider-b');
    manager.addProvider(providerA);
    manager.addProvider(providerB);

    await manager.store('temp', 'temporary data');
    expect(providerA.records.has('temp')).toBe(true);
    expect(providerB.records.has('temp')).toBe(true);

    const forgotten = await manager.forget('temp');
    expect(forgotten).toBe(true);
    expect(providerA.records.has('temp')).toBe(false);
    expect(providerB.records.has('temp')).toBe(false);
  });

  it('returns false when forgetting a key that does not exist', async () => {
    const manager = new MemoryManager();
    const provider = createFakeProvider('provider');
    manager.addProvider(provider);

    const forgotten = await manager.forget('nonexistent');
    expect(forgotten).toBe(false);
  });

  it('returns empty results when no providers are registered', async () => {
    const manager = new MemoryManager();
    const results = await manager.recall('anything');
    expect(results).toHaveLength(0);
  });

  it('respects the limit parameter on recall', async () => {
    const manager = new MemoryManager();
    const provider = createFakeProvider('provider');
    manager.addProvider(provider);

    await manager.store('a', 'pattern alpha');
    await manager.store('b', 'pattern beta');
    await manager.store('c', 'pattern gamma');

    const results = await manager.recall('pattern', 2);
    expect(results).toHaveLength(2);
  });

  it('stores metadata and preserves it on recall', async () => {
    const manager = new MemoryManager();
    const provider = createFakeProvider('provider');
    manager.addProvider(provider);

    await manager.store('tagged', 'important note', { priority: 'high', source: 'user' });

    const results = await manager.recall('important');
    expect(results).toHaveLength(1);
    expect(results[0]?.metadata).toEqual({ priority: 'high', source: 'user' });
  });

  it('works with BuiltInMemoryProvider backed by InMemoryMemoryStore', async () => {
    const manager = new MemoryManager();
    const provider = createBuiltInProvider('built-in');
    manager.addProvider(provider);

    await manager.store('deploy', 'deploy crowclaw to cloudflare workers');

    const results = await manager.recall('cloudflare');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('cloudflare');
  });

  it('merges results from BuiltInMemoryProvider and fake provider', async () => {
    const manager = new MemoryManager();
    const builtIn = createBuiltInProvider('built-in');
    const fake = createFakeProvider('fake');
    manager.addProvider(builtIn);
    manager.addProvider(fake);

    // Store different keys in each provider directly
    await builtIn.store('key-builtin', 'search optimization techniques');
    await fake.store('key-fake', 'search ranking algorithms');

    const results = await manager.recall('search');
    // Both unique keys should appear
    expect(results.length).toBeGreaterThanOrEqual(2);
    const keys = results.map((r) => r.key);
    // The fake provider uses the literal key; the built-in provider uses a UUID as key
    expect(keys).toContain('key-fake');
    // Built-in provider stores with UUID key, so we check content instead
    const contents = results.map((r) => r.content);
    expect(contents).toContain('search optimization techniques');
    expect(contents).toContain('search ranking algorithms');
  });
});

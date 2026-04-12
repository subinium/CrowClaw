import { describe, expect, it } from 'vitest';
import {
  cosineSimilarity,
  EmbeddingIndex,
  EmbeddingMemoryStore,
  MemoryService,
  UserModelService,
  type EmbeddingProvider,
} from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';
import type { MemoryRecord } from '@crowclaw/storage';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic mock embedding provider. Maps text to a fixed vector based on content. */
function createMockEmbeddingProvider(
  mapping: Record<string, number[]>
): EmbeddingProvider {
  return {
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((text) => {
        const key = Object.keys(mapping).find((k) =>
          text.toLowerCase().includes(k.toLowerCase())
        );
        return key ? mapping[key]! : [0, 0, 0];
      });
    },
  };
}

function makeRecord(
  overrides: Partial<MemoryRecord> & { id: string; sessionId: string; summary: string }
): MemoryRecord {
  return {
    scope: 'session',
    tags: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// cosineSimilarity
// ---------------------------------------------------------------------------

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero-magnitude vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
  });

  it('returns 0 for mismatched lengths', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('computes correct similarity for known vectors', () => {
    // cos([1,0,1], [0,1,1]) = 1 / (sqrt(2)*sqrt(2)) = 0.5
    expect(cosineSimilarity([1, 0, 1], [0, 1, 1])).toBeCloseTo(0.5, 5);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingIndex
// ---------------------------------------------------------------------------

describe('EmbeddingIndex', () => {
  it('starts with size 0', () => {
    const index = new EmbeddingIndex();
    expect(index.size()).toBe(0);
  });

  it('adds and searches vectors', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);
    index.add('c', [0, 0, 1]);
    expect(index.size()).toBe(3);

    const results = index.search([1, 0, 0], 2, 0.5);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('a');
    expect(results[0]!.score).toBeCloseTo(1.0, 5);
  });

  it('returns results sorted by score descending', () => {
    const index = new EmbeddingIndex();
    index.add('exact', [1, 0, 0]);
    index.add('similar', [0.9, 0.1, 0]);
    index.add('different', [0, 1, 0]);

    const results = index.search([1, 0, 0], 3, 0.0);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results[0]!.id).toBe('exact');
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it('respects threshold filtering', () => {
    const index = new EmbeddingIndex();
    index.add('close', [1, 0.1, 0]);
    index.add('far', [0, 1, 0]);

    const results = index.search([1, 0, 0], 10, 0.9);
    expect(results.every((r) => r.score >= 0.9)).toBe(true);
  });

  it('respects topK limit', () => {
    const index = new EmbeddingIndex();
    for (let i = 0; i < 20; i++) {
      const vec = [Math.cos(i * 0.1), Math.sin(i * 0.1), 0];
      index.add(`item-${i}`, vec);
    }

    const results = index.search([1, 0, 0], 3, 0.0);
    expect(results).toHaveLength(3);
  });

  it('removes vectors', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);
    expect(index.size()).toBe(2);

    index.remove('a');
    expect(index.size()).toBe(1);

    const results = index.search([1, 0, 0], 10, 0.0);
    expect(results.every((r) => r.id !== 'a')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EmbeddingMemoryStore
// ---------------------------------------------------------------------------

describe('EmbeddingMemoryStore', () => {
  const TYPESCRIPT_VEC = [1, 0, 0];
  const PYTHON_VEC = [0, 1, 0];
  const RUST_VEC = [0, 0, 1];

  const mockProvider = createMockEmbeddingProvider({
    typescript: TYPESCRIPT_VEC,
    python: PYTHON_VEC,
    rust: RUST_VEC,
  });

  it('writes and searches by embedding similarity', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
      similarityThreshold: 0.5,
    });

    await store.write(
      makeRecord({ id: 'r1', sessionId: 's1', summary: 'TypeScript patterns' })
    );
    await store.write(
      makeRecord({ id: 'r2', sessionId: 's1', summary: 'Python data science' })
    );
    await store.write(
      makeRecord({ id: 'r3', sessionId: 's1', summary: 'Rust memory safety' })
    );

    const results = await store.search('s1', 'typescript', 10);
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('r1');
  });

  it('returns empty array when no matches meet threshold', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
      similarityThreshold: 0.99,
    });

    await store.write(
      makeRecord({ id: 'r1', sessionId: 's1', summary: 'Python basics' })
    );

    // Query with an unknown term that maps to [0,0,0]
    const results = await store.search('s1', 'unknown topic', 10);
    expect(results).toHaveLength(0);
  });

  it('deduplicates similar memories by merging tags', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
      deduplicationThreshold: 0.95,
      similarityThreshold: 0.5,
    });

    await store.write(
      makeRecord({
        id: 'r1',
        sessionId: 's1',
        summary: 'TypeScript best practices',
        tags: ['lang'],
      })
    );

    // Second write with same embedding direction should deduplicate
    await store.write(
      makeRecord({
        id: 'r2',
        sessionId: 's1',
        summary: 'TypeScript coding standards',
        tags: ['standards'],
      })
    );

    // The base store will have two writes, but the second is a merge of r1
    // (rewritten with r1's id, updated content, merged tags)
    const all = await baseStore.list('s1');
    // Find the merged record (written with r1's id but updated content)
    const merged = all.find((r) => r.id === 'r1' && r.summary.includes('TypeScript coding standards'));
    expect(merged).toBeDefined();
    expect(merged!.tags).toContain('lang');
    expect(merged!.tags).toContain('standards');
  });

  it('does not deduplicate dissimilar memories', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
      deduplicationThreshold: 0.95,
      similarityThreshold: 0.5,
    });

    await store.write(
      makeRecord({ id: 'r1', sessionId: 's1', summary: 'TypeScript patterns' })
    );
    await store.write(
      makeRecord({ id: 'r2', sessionId: 's1', summary: 'Python data science' })
    );

    const results = await store.search('s1', 'typescript', 10);
    const tsResults = results.filter((r) => r.id === 'r1');
    expect(tsResults).toHaveLength(1);

    const pyResults = await store.search('s1', 'python', 10);
    expect(pyResults).toHaveLength(1);
    expect(pyResults[0]!.id).toBe('r2');
  });

  it('delegates list to base store', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
    });

    await store.write(
      makeRecord({ id: 'r1', sessionId: 's1', summary: 'TypeScript note' })
    );
    await store.write(
      makeRecord({ id: 'r2', sessionId: 's1', summary: 'Python note' })
    );

    const listed = await store.list('s1');
    expect(listed).toHaveLength(2);
  });

  it('searchByScope works with embeddings', async () => {
    const baseStore = new InMemoryMemoryStore();
    const store = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: mockProvider,
      similarityThreshold: 0.5,
    });

    await store.write(
      makeRecord({
        id: 'r1',
        sessionId: 's1',
        summary: 'TypeScript workspace pattern',
        scope: 'workspace',
        scopeKey: 'ws-1',
      })
    );
    await store.write(
      makeRecord({
        id: 'r2',
        sessionId: 's1',
        summary: 'Python workspace pattern',
        scope: 'workspace',
        scopeKey: 'ws-1',
      })
    );

    const results = await store.searchByScope('workspace', 'typescript', 10, 'ws-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe('r1');
  });
});

// ---------------------------------------------------------------------------
// TTL expiry (MemoryService)
// ---------------------------------------------------------------------------

describe('MemoryService TTL', () => {
  it('filters out expired memories on recall', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    // Save a memory with 1ms TTL — it will be expired immediately
    await service.remember('s1', 'ephemeral note', ['temp'], undefined, 'session', undefined, 1);

    // Small delay to ensure expiry
    await new Promise((resolve) => setTimeout(resolve, 10));

    const results = await service.recall('s1', 'ephemeral');
    expect(results).toHaveLength(0);
  });

  it('keeps non-expired memories on recall', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    // Save with a long TTL
    await service.remember('s1', 'durable note', ['keep'], undefined, 'session', undefined, 60_000);
    // Save without TTL
    await service.remember('s1', 'permanent note', ['forever']);

    const results = await service.recall('s1', 'note');
    expect(results).toHaveLength(2);
  });

  it('filters expired on list()', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('s1', 'expired note', ['a'], undefined, 'session', undefined, 1);
    await service.remember('s1', 'valid note', ['b']);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const listed = await service.list('s1');
    expect(listed).toHaveLength(1);
    expect(listed[0]!.summary).toBe('valid note');
  });

  it('filters expired on listByScope()', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('s1', 'expired workspace note', ['a'], undefined, 'workspace', 'ws-1', 1);
    await service.remember('s1', 'valid workspace note', ['b'], undefined, 'workspace', 'ws-1');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const results = await service.listByScope('workspace', 50, 'ws-1');
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe('valid workspace note');
  });

  it('filters expired on recallByScope()', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('s1', 'expired user note', ['pref'], undefined, 'user', 'u1', 1);
    await service.remember('s1', 'valid user note', ['pref'], undefined, 'user', 'u1');

    await new Promise((resolve) => setTimeout(resolve, 10));

    const results = await service.recallByScope('user', 'pref', 10, 'u1');
    expect(results).toHaveLength(1);
    expect(results[0]!.summary).toBe('valid user note');
  });

  it('cleanup() marks expired records as tombstones', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('s1', 'expired note', ['a'], undefined, 'session', undefined, 1);
    await service.remember('s1', 'valid note', ['b']);

    await new Promise((resolve) => setTimeout(resolve, 10));

    const cleaned = await service.cleanup('s1');
    expect(cleaned).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// UserModelService
// ---------------------------------------------------------------------------

describe('UserModelService', () => {
  it('returns empty profile when no conversations recorded', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    const profile = await userModel.getProfile('s1', 'user-1');
    expect(profile.expertise).toEqual([]);
    expect(profile.preferences).toEqual([]);
    expect(profile.interactionCount).toBe(0);
    expect(profile.lastSeenAt).toBe('');
  });

  it('detects expertise from user messages', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    await userModel.updateFromConversation(
      [
        { role: 'user', content: 'I work with TypeScript and React daily', createdAt: new Date().toISOString() },
        { role: 'assistant', content: 'Great!', createdAt: new Date().toISOString() },
        { role: 'user', content: 'Also using Docker and Kubernetes for deployment', createdAt: new Date().toISOString() },
      ],
      's1',
      'user-1'
    );

    const profile = await userModel.getProfile('s1', 'user-1');
    expect(profile.expertise).toContain('typescript');
    expect(profile.expertise).toContain('react');
    expect(profile.expertise).toContain('docker');
    expect(profile.expertise).toContain('kubernetes');
    expect(profile.interactionCount).toBe(2); // only user messages counted
  });

  it('detects preferences from user messages', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    await userModel.updateFromConversation(
      [
        { role: 'user', content: 'I prefer using arrow functions and always write tests', createdAt: new Date().toISOString() },
      ],
      's1',
      'user-1'
    );

    const profile = await userModel.getProfile('s1', 'user-1');
    expect(profile.preferences.length).toBeGreaterThan(0);
    // Should detect 'prefer' and 'always' as preference indicators
    expect(profile.preferences.some((p) => p.includes('prefer'))).toBe(true);
    expect(profile.preferences.some((p) => p.includes('always'))).toBe(true);
  });

  it('accumulates expertise across multiple conversations', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    await userModel.updateFromConversation(
      [{ role: 'user', content: 'Working on a Python project', createdAt: new Date().toISOString() }],
      's1',
      'user-1'
    );

    await userModel.updateFromConversation(
      [{ role: 'user', content: 'Now switching to Rust for performance', createdAt: new Date().toISOString() }],
      's2',
      'user-1'
    );

    const profile = await userModel.getProfile('s2', 'user-1');
    expect(profile.expertise).toContain('python');
    expect(profile.expertise).toContain('rust');
    expect(profile.interactionCount).toBe(2);
  });

  it('ignores assistant messages', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    await userModel.updateFromConversation(
      [
        { role: 'assistant', content: 'I know TypeScript and Python very well', createdAt: new Date().toISOString() },
      ],
      's1',
      'user-1'
    );

    const profile = await userModel.getProfile('s1', 'user-1');
    expect(profile.expertise).toEqual([]);
    expect(profile.interactionCount).toBe(0);
  });

  it('handles empty message array', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    await userModel.updateFromConversation([], 's1', 'user-1');

    const profile = await userModel.getProfile('s1', 'user-1');
    expect(profile.interactionCount).toBe(0);
  });
});

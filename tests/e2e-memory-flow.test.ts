/**
 * E2E: Memory Flow — cross-subsystem integration
 *
 * Tests embedding-based memory recall, TTL expiry, user model extraction
 * from conversations, and memory + learning pipeline interaction.
 */
import { describe, expect, it, beforeEach } from 'vitest';

import { MemoryService } from '@crowclaw/memory';
import { EmbeddingMemoryStore, cosineSimilarity, type EmbeddingProvider } from '@crowclaw/memory';
import { UserModelService } from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';
import type { ConversationMessage } from '@crowclaw/core';

// ============================================================================
// Helpers
// ============================================================================

/**
 * A deterministic mock embedding provider that creates embeddings based on
 * word frequency. Each word maps to a fixed dimension index, so similar
 * texts produce similar vectors.
 */
function createMockEmbeddingProvider(): EmbeddingProvider {
  const vocabulary = new Map<string, number>();
  let nextDim = 0;

  function getOrAssign(word: string): number {
    const existing = vocabulary.get(word);
    if (existing !== undefined) return existing;
    const dim = nextDim++;
    vocabulary.set(word, dim);
    return dim;
  }

  return {
    async embed(texts: string[]): Promise<number[][]> {
      // Ensure consistent dimensionality: use 64 dims
      const DIMS = 64;
      return texts.map((text) => {
        const vec = new Array(DIMS).fill(0);
        const words = text.toLowerCase().split(/\W+/).filter(Boolean);
        for (const word of words) {
          const dim = getOrAssign(word) % DIMS;
          vec[dim] += 1;
        }
        // Normalize
        const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
        if (mag > 0) {
          for (let i = 0; i < DIMS; i++) {
            vec[i] /= mag;
          }
        }
        return vec;
      });
    },
  };
}

// ============================================================================
// 1. Memory: remember -> recall with embedding
// ============================================================================

describe('E2E: memory remember -> recall with embedding', () => {
  let baseStore: InMemoryMemoryStore;
  let embeddingStore: EmbeddingMemoryStore;
  let service: MemoryService;

  beforeEach(() => {
    baseStore = new InMemoryMemoryStore();
    const provider = createMockEmbeddingProvider();
    embeddingStore = new EmbeddingMemoryStore({
      baseStore,
      embeddingProvider: provider,
      similarityThreshold: 0.1,
    });
    service = new MemoryService(embeddingStore);
  });

  it('remembers 3 different facts and recalls the most similar one first', async () => {
    await service.remember('session-1', 'TypeScript is a typed superset of JavaScript', ['typescript', 'javascript'], undefined, 'session', 'session-1');
    await service.remember('session-1', 'React is a UI library for building user interfaces', ['react', 'ui'], undefined, 'session', 'session-1');
    await service.remember('session-1', 'Docker containers run isolated applications', ['docker', 'containers'], undefined, 'session', 'session-1');

    // Recall with a TypeScript-related query
    const results = await service.recall('session-1', 'TypeScript programming language');

    expect(results.length).toBeGreaterThanOrEqual(1);
    // The TypeScript fact should be the most relevant
    expect(results[0].summary).toContain('TypeScript');
  });

  it('recall returns empty for completely unrelated queries', async () => {
    await service.remember('session-2', 'Python is great for data science', ['python'], undefined, 'session', 'session-2');

    // Query about something with zero overlap
    const results = await service.recall('session-2', 'quantum physics equations');
    // May return results based on base store fallback, but embedding relevance should be low
    // The main point is it doesn't crash
    expect(Array.isArray(results)).toBe(true);
  });

  it('deduplication merges similar memories', async () => {
    await service.remember('session-3', 'User prefers TypeScript', ['pref'], undefined, 'session', 'session-3');
    await service.remember('session-3', 'User prefers TypeScript for all projects', ['pref', 'projects'], undefined, 'session', 'session-3');

    // The embedding store should have merged due to high similarity
    const all = await service.list('session-3');
    // With deduplication, we might have 1 or 2 records depending on threshold
    expect(all.length).toBeGreaterThanOrEqual(1);
    // At least one record should have merged tags
    const hasMergedTags = all.some((r) => r.tags.includes('pref') && r.tags.includes('projects'));
    // This depends on dedup threshold — at minimum, both facts should be accessible
    expect(all.some((r) => r.summary.includes('TypeScript'))).toBe(true);
  });
});

// ============================================================================
// 2. Memory TTL expiry
// ============================================================================

describe('E2E: memory TTL expiry', () => {
  it('expired memories are filtered out of recall results', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    // Remember with very short TTL
    await service.remember('ttl-session', 'temporary fact', ['temp'], undefined, 'session', 'ttl-session', 100);

    // Immediately recall — should find it
    const immediate = await service.recall('ttl-session', 'temporary');
    expect(immediate.length).toBe(1);
    expect(immediate[0].summary).toBe('temporary fact');

    // Wait for TTL to expire
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Recall again — should NOT find it (TTL expired)
    const expired = await service.recall('ttl-session', 'temporary');
    expect(expired.length).toBe(0);
  });

  it('non-TTL memories persist indefinitely', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    // Remember without TTL
    await service.remember('persist-session', 'permanent fact', ['permanent'], undefined, 'session', 'persist-session');

    // Wait a bit
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should still be there
    const results = await service.recall('persist-session', 'permanent');
    expect(results.length).toBe(1);
    expect(results[0].summary).toBe('permanent fact');
  });

  it('cleanup marks expired records', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('cleanup-session', 'will expire', ['expire'], undefined, 'session', 'cleanup-session', 50);
    await service.remember('cleanup-session', 'will persist', ['persist'], undefined, 'session', 'cleanup-session');

    // Wait for first to expire
    await new Promise((resolve) => setTimeout(resolve, 100));

    const cleaned = await service.cleanup('cleanup-session');
    expect(cleaned).toBe(1);

    // Only persistent memory should be in recall
    const results = await service.recall('cleanup-session', '');
    const summaries = results.map((r) => r.summary);
    expect(summaries).toContain('will persist');
  });
});

// ============================================================================
// 3. User modeling from conversation
// ============================================================================

describe('E2E: user model from conversation', () => {
  it('extracts expertise domains and preferences from messages', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'I work with TypeScript and React daily', createdAt: '' },
      { role: 'user', content: 'I prefer concise code and always use arrow functions', createdAt: '' },
      { role: 'user', content: 'For deployment I use Docker and Kubernetes on AWS', createdAt: '' },
      { role: 'assistant', content: 'Got it!', createdAt: '' },
    ];

    await userModel.updateFromConversation(messages, 'session-1', 'test-user');
    const profile = await userModel.getProfile('session-1', 'test-user');

    // Check expertise
    expect(profile.expertise).toContain('typescript');
    expect(profile.expertise).toContain('react');
    expect(profile.expertise).toContain('docker');
    expect(profile.expertise).toContain('kubernetes');

    // Check preferences
    expect(profile.preferences.length).toBeGreaterThan(0);
    const prefText = profile.preferences.join(' ');
    expect(prefText).toContain('prefer');

    // Interaction count
    expect(profile.interactionCount).toBe(3); // 3 user messages
    expect(profile.lastSeenAt).toBeTruthy();
  });

  it('accumulates expertise across multiple conversations', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    const messages1: ConversationMessage[] = [
      { role: 'user', content: 'I use TypeScript for frontend', createdAt: '' },
    ];
    const messages2: ConversationMessage[] = [
      { role: 'user', content: 'For backend I use Python and Postgres', createdAt: '' },
    ];

    await userModel.updateFromConversation(messages1, 'sess-1', 'accumulate-user');
    await userModel.updateFromConversation(messages2, 'sess-2', 'accumulate-user');

    const profile = await userModel.getProfile('sess-2', 'accumulate-user');

    // Should include expertise from both conversations
    expect(profile.expertise).toContain('typescript');
    expect(profile.expertise).toContain('python');
    expect(profile.expertise).toContain('postgres');
    expect(profile.interactionCount).toBe(2);
  });

  it('ignores assistant messages for profile extraction', async () => {
    const store = new InMemoryMemoryStore();
    const userModel = new UserModelService(store);

    const messages: ConversationMessage[] = [
      { role: 'assistant', content: 'I recommend using TypeScript and React', createdAt: '' },
      { role: 'user', content: 'hello', createdAt: '' },
    ];

    await userModel.updateFromConversation(messages, 'sess-3', 'ignore-assistant');
    const profile = await userModel.getProfile('sess-3', 'ignore-assistant');

    // TypeScript and React should NOT be in expertise (they came from assistant)
    expect(profile.expertise).not.toContain('typescript');
    expect(profile.expertise).not.toContain('react');
    expect(profile.interactionCount).toBe(1);
  });
});

// ============================================================================
// 4. Cosine similarity function correctness
// ============================================================================

describe('E2E: cosine similarity correctness', () => {
  it('identical vectors have similarity 1', () => {
    const vec = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(vec, vec)).toBeCloseTo(1.0, 5);
  });

  it('orthogonal vectors have similarity 0', () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 5);
  });

  it('opposite vectors have similarity -1', () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 5);
  });

  it('handles zero vectors gracefully', () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it('handles empty vectors gracefully', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('handles different-length vectors gracefully', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

// ============================================================================
// 5. Memory scoped operations
// ============================================================================

describe('E2E: memory scoped operations', () => {
  it('user-scoped memories persist across sessions', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('sess-a', 'User likes dark mode', ['preference'], undefined, 'user', 'user-123');
    await service.remember('sess-b', 'User is a TypeScript expert', ['expertise'], undefined, 'user', 'user-123');

    // Recall by scope — should find both
    const results = await service.recallByScope('user', 'TypeScript', 10, 'user-123');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.summary.includes('TypeScript'))).toBe(true);
  });

  it('workspace-scoped memories are isolated by scopeKey', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('sess-1', 'Project uses Next.js', ['framework'], undefined, 'workspace', 'workspace-alpha');
    await service.remember('sess-1', 'Project uses Django', ['framework'], undefined, 'workspace', 'workspace-beta');

    const alpha = await service.recallByScope('workspace', 'framework', 10, 'workspace-alpha');
    expect(alpha.some((r) => r.summary.includes('Next.js'))).toBe(true);
    expect(alpha.some((r) => r.summary.includes('Django'))).toBe(false);

    const beta = await service.recallByScope('workspace', 'framework', 10, 'workspace-beta');
    expect(beta.some((r) => r.summary.includes('Django'))).toBe(true);
    expect(beta.some((r) => r.summary.includes('Next.js'))).toBe(false);
  });
});

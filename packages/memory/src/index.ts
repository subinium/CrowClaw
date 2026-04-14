import type { ConversationMessage } from '@crowclaw/core';
import type { MemoryRecord, MemoryStore, InMemorySessionStore } from '@crowclaw/storage';

export interface MemoryNote {
  scope: 'session' | 'user' | 'workspace';
  summary: string;
  messages: number;
  tags: string[];
}

function uniqueTags(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
}

/** Check whether a record has expired based on its TTL metadata. */
function isExpired(record: MemoryRecord): boolean {
  const ttlMs = record.metadata?.ttlMs;
  if (typeof ttlMs !== 'number' || ttlMs <= 0) {
    return false;
  }
  const createdMs = new Date(record.createdAt).getTime();
  return Date.now() > createdMs + ttlMs;
}

export class MemoryService {
  private readonly store?: MemoryStore;
  private readonly sessionStore?: InMemorySessionStore;

  constructor(store?: MemoryStore, sessionStore?: InMemorySessionStore) {
    this.store = store;
    this.sessionStore = sessionStore;
  }

  summarize(messages: ConversationMessage[], scope: MemoryNote['scope'] = 'session'): MemoryNote {
    const recentText = messages
      .slice(-4)
      .map((message) => message.content)
      .join(' ')
      .trim();

    const tags = uniqueTags(
      recentText
        .split(/\W+/)
        .filter((token) => token.length >= 4)
        .slice(0, 8)
    );

    return {
      scope,
      summary: `Recent activity: ${recentText.slice(0, 200)}`,
      messages: messages.length,
      tags
    };
  }

  async captureSessionSummary(sessionId: string, messages: ConversationMessage[]): Promise<MemoryRecord | null> {
    return this.captureScopedSummary('session', sessionId, messages);
  }

  async captureScopedSummary(scope: MemoryRecord['scope'], sessionId: string, messages: ConversationMessage[], scopeKey?: string): Promise<MemoryRecord | null> {
    if (!this.store || messages.length === 0) {
      return null;
    }

    const note = this.summarize(messages, scope);
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope: note.scope,
      scopeKey,
      summary: note.summary,
      tags: note.tags,
      createdAt: new Date().toISOString(),
      metadata: { messages: note.messages }
    };

    await this.store.write(record);
    return record;
  }

  async remember(
    sessionId: string,
    summary: string,
    tags: string[] = [],
    metadata?: Record<string, unknown>,
    scope: MemoryRecord['scope'] = 'session',
    scopeKey?: string,
    ttlMs?: number
  ): Promise<MemoryRecord> {
    if (!this.store) {
      throw new Error('Memory store not configured.');
    }

    const recordMetadata: Record<string, unknown> = { ...metadata };
    if (ttlMs !== undefined && ttlMs > 0) {
      recordMetadata.ttlMs = ttlMs;
    }

    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope,
      scopeKey,
      summary,
      tags: uniqueTags(tags),
      createdAt: new Date().toISOString(),
      metadata: Object.keys(recordMetadata).length > 0 ? recordMetadata : undefined
    };

    await this.store.write(record);
    return record;
  }

  async recall(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.search(sessionId, query, limit * 2);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async recallByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.searchByScope(scope, query, limit * 2, scopeKey);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async list(sessionId: string, limit = 50): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.list(sessionId);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.listByScope(scope, limit * 2, scopeKey);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async crossSessionRecall(query: string, limit = 5): Promise<Array<{ sessionId: string; summary: string; relevance: number }>> {
    const results: Array<{ sessionId: string; summary: string; relevance: number }> = [];

    // Gather matches from session store (message-level search across all sessions)
    if (this.sessionStore) {
      const sessionHits = await this.sessionStore.searchAll(query, limit * 2);
      for (const hit of sessionHits) {
        const bestScore = hit.matches[0]?.score ?? 0;
        const preview = hit.matches
          .slice(0, 2)
          .map((m) => m.content.slice(0, 100))
          .join(' | ');
        results.push({ sessionId: hit.sessionId, summary: preview, relevance: bestScore });
      }
    }

    // Gather matches from memory store (scope-level search across all scopes)
    if (this.store) {
      const memoryHits = await this.store.searchByScope('session', query, limit * 2);
      for (const record of memoryHits) {
        const existing = results.find((r) => r.sessionId === record.sessionId);
        if (existing) {
          // Boost relevance when both stores match the same session
          existing.relevance += 1;
        } else {
          results.push({ sessionId: record.sessionId, summary: record.summary.slice(0, 200), relevance: 1 });
        }
      }
    }

    results.sort((a, b) => b.relevance - a.relevance);
    return results.slice(0, limit);
  }

  /** Remove all expired memories from the store. Returns the count of cleaned records. */
  async cleanup(sessionId: string): Promise<number> {
    if (!this.store) {
      return 0;
    }

    const all = await this.store.list(sessionId);
    const expired = all.filter(isExpired);

    // The MemoryStore interface does not have a delete method,
    // so we overwrite expired records with a tombstone tag to mark them as cleaned.
    // Consumers should filter by the __expired__ tag or rely on isExpired().
    let cleaned = 0;
    for (const record of expired) {
      const tombstone: MemoryRecord = {
        ...record,
        tags: ['__expired__'],
        metadata: { ...record.metadata, expired: true, cleanedAt: new Date().toISOString() }
      };
      await this.store.write(tombstone);
      cleaned++;
    }

    return cleaned;
  }
}

export {
  EmbeddingMemoryStore,
  EmbeddingIndex,
  cosineSimilarity,
  type EmbeddingProvider,
  type EmbeddingMemoryStoreOptions
} from './embedding-store.js';
export { UserModelService, type UserProfile } from './user-model.js';
export {
  type MemoryRecord as ManagerMemoryRecord,
  type MemoryProvider,
  BuiltInMemoryProvider,
  EmbeddingMemoryProvider,
} from './memory-provider.js';
export { MemoryManager } from './memory-manager.js';
export {
  FrozenMemory,
  InMemoryFrozenStore,
  FileFrozenStore,
  type FrozenMemoryEntry,
  type FrozenSnapshot,
  type FrozenMemoryStore,
} from './frozen-memory.js';
export {
  InMemoryDreamStore,
  type DreamEntry,
  type DreamMemoryStore,
} from './dream-memory.js';

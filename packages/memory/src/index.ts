import type { ConversationMessage } from '@crowclaw/core';
import type { MemoryRecord, MemoryStore, InMemorySessionStore } from '@crowclaw/storage';
import type { MemoryProvider } from './provider.js';
import type { MemoryScope } from './types.js';
import { InMemoryMemoryProvider } from './provider.js';

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

/**
 * Backward-compat facade over a `MemoryProvider` (issue #233, v0.8.0 Hermes).
 *
 * The full v0.7.x public API (`recall`, `recallByScope`, `list`, `listByScope`,
 * `remember`, `captureSessionSummary`, `captureScopedSummary`, `summarize`,
 * `crossSessionRecall`, `cleanup`) is preserved verbatim so the 20+ existing
 * call sites in `runtime-node` keep compiling. Internally the methods that
 * overlap with `MemoryProvider` delegate to the injected provider; the rest
 * (scope-keyed capture, cross-session recall, TTL cleanup) still operate
 * directly on the underlying `MemoryStore` because those are runtime
 * concerns the provider abstraction deliberately omits.
 *
 * For new code prefer constructing an `InMemoryMemoryProvider` (or any
 * adapter) directly. For drop-in compatibility, callers that already do
 * `new MemoryService(memoryStore)` get the same behaviour as v0.7.x —
 * the constructor lazily wraps the store in an `InMemoryMemoryProvider`.
 */
export class MemoryService {
  private readonly store?: MemoryStore;
  private readonly sessionStore?: InMemorySessionStore;
  private readonly provider?: MemoryProvider;

  constructor(store?: MemoryStore, sessionStore?: InMemorySessionStore, provider?: MemoryProvider) {
    this.store = store;
    this.sessionStore = sessionStore;
    // If the caller passes an explicit provider, use it. Otherwise wrap the
    // store in a default `InMemoryMemoryProvider` so the v0.8 surface
    // (prefetch, sync_turn, shutdown) is available even without an opt-in.
    this.provider = provider ?? (store ? new InMemoryMemoryProvider(store) : undefined);
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

    const fallbackNote = this.summarize(messages, scope);
    let semanticSummary = '';
    if (this.provider?.llmSummarize) {
      try {
        semanticSummary = (await this.provider.llmSummarize(messages)).trim();
      } catch {
        semanticSummary = '';
      }
    }
    const note: MemoryNote = semanticSummary
      ? {
          ...fallbackNote,
          summary: semanticSummary,
          tags: uniqueTags([...fallbackNote.tags, 'semantic-summary']),
        }
      : fallbackNote;
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

    // v0.8.0 Hermes parity (#233): notify the provider's `sync_turn` hook
    // fire-and-forget so adapters can run post-turn work (cache warm,
    // embedding index, external sync) WITHOUT blocking the next agent
    // turn. Errors are swallowed inside the provider; we ignore the
    // promise here on purpose.
    if (this.provider?.sync_turn) {
      void this.provider.sync_turn(sessionId, note.summary, { scope: note.scope, scopeKey, messages: note.messages });
    }

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

  async recall(sessionId: string, query: string, limit = 10, scope?: MemoryScope, scopeKey?: string): Promise<MemoryRecord[]> {
    if (this.provider) {
      return this.provider.recall(sessionId, query, limit, scope, scopeKey);
    }
    if (!this.store) {
      return [];
    }

    const results = await this.store.search(sessionId, query, limit * 2);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  /**
   * v0.8 `MemoryProvider.prefetch` — exposed on the facade so the runtime can
   * call `memoryService.prefetch?.(...)` uniformly. Defers to the underlying
   * provider when present so adapters with caches can pre-warm.
   */
  async prefetch(sessionId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    if (this.provider?.prefetch) {
      return this.provider.prefetch(sessionId, query, limit);
    }
    return this.recall(sessionId, query, limit);
  }

  async recallByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.searchByScope(scope, query, limit * 2, scopeKey);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async list(sessionId: string, scopeOrLimit?: MemoryScope | number, limit?: number): Promise<MemoryRecord[]> {
    // v0.8 `MemoryProvider.list(sessionId, scope?, limit?)` widens the v0.7
    // signature `list(sessionId, limit?)`. Accept both shapes by sniffing the
    // second argument so existing callers (`memoryService.list(sid, 50)`)
    // keep working unchanged.
    let scope: MemoryScope | undefined;
    let effectiveLimit: number;
    if (typeof scopeOrLimit === 'number') {
      effectiveLimit = scopeOrLimit;
    } else {
      scope = scopeOrLimit;
      effectiveLimit = limit ?? 50;
    }

    if (!this.store) {
      return [];
    }

    const results = scope
      ? await this.store.listByScope(scope, effectiveLimit * 2)
      : await this.store.list(sessionId);
    return results.filter((r) => !isExpired(r)).slice(0, effectiveLimit);
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    if (!this.store) {
      return [];
    }

    const results = await this.store.listByScope(scope, limit * 2, scopeKey);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  /**
   * v0.8 `MemoryProvider.store` — explicit "Remember this" save. Named
   * `storeRecord` on the facade because the class already has a private
   * `store` field holding the underlying `MemoryStore`. Adapters that go
   * through the `MemoryProvider` interface directly use the canonical
   * `provider.store(...)` name; the facade only exists for v0.7.x callers.
   */
  async storeRecord(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord> {
    if (this.provider) {
      return this.provider.store(record);
    }
    if (!this.store) {
      throw new Error('Memory store not configured.');
    }
    const full: MemoryRecord = {
      ...record,
      id: crypto.randomUUID(),
      tags: uniqueTags(record.tags ?? []),
      createdAt: new Date().toISOString(),
    };
    await this.store.write(full);
    return full;
  }

  async delete(id: string): Promise<boolean> {
    if (this.provider) {
      return this.provider.delete(id);
    }
    if (!this.store) {
      return false;
    }
    const maybeDelete = (this.store as unknown as { delete?: (id: string) => Promise<void> | Promise<boolean> }).delete;
    if (typeof maybeDelete === 'function') {
      const result = await maybeDelete.call(this.store, id);
      return result === false ? false : true;
    }
    return false;
  }

  /**
   * v0.8 `MemoryProvider.sync_turn` — fire-and-forget post-turn write. The
   * runtime invokes this without awaiting; we delegate to the provider so
   * adapter-specific tracking (in-flight set, retry queue) is preserved for
   * `shutdown()` to drain.
   */
  async sync_turn(sessionId: string, summary: string, metadata?: Record<string, unknown>): Promise<void> {
    if (this.provider?.sync_turn) {
      return this.provider.sync_turn(sessionId, summary, metadata);
    }
    // Fallback: write directly through the store so even configurations
    // without a v0.8 provider still capture turn summaries.
    if (!this.store) return;
    const record: MemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope: 'session',
      summary,
      tags: [],
      createdAt: new Date().toISOString(),
      metadata,
    };
    await this.store.write(record);
  }

  async shutdown(): Promise<void> {
    if (this.provider?.shutdown) {
      return this.provider.shutdown();
    }
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
  type MemoryProvider as LegacyMemoryProvider,
  type SessionTranscriptMessage,
  BuiltInMemoryProvider,
  EmbeddingMemoryProvider,
} from './memory-provider.js';
export {
  MemoryManager,
  SKIP_REDACTION_FLAG,
  type SessionEndResult,
} from './memory-manager.js';
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

// v0.8.0 Hermes parity (#233) — pluggable MemoryProvider ABC.
export type { MemoryProvider } from './provider.js';
export type { MemoryScope } from './types.js';
export { InMemoryMemoryProvider, PluginMemoryProvider, memoryProviderFromPluginRegistry } from './provider.js';
export type { MemoryRecord as ProviderMemoryRecord, ConversationMessage as ProviderConversationMessage } from './types.js';

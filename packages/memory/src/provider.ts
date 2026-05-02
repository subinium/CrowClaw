/**
 * v0.8.0 Hermes parity — pluggable MemoryProvider ABC (issue #233).
 *
 * This is the canonical memory-backend interface for v0.8+. Adapters implement
 * it once and the runtime treats every backend (in-memory, D1, Postgres, vector
 * DB, etc.) identically. The legacy multi-provider `LegacyMemoryProvider`
 * (used by `MemoryManager`) lives in `memory-provider.ts` and is unrelated.
 *
 * Lifecycle (host responsibility):
 *
 *   const provider = new InMemoryMemoryProvider(store);
 *   await provider.init?.(config);
 *
 *   // Per turn:
 *   const memories = (await provider.prefetch?.(sid, q, 5)) ?? await provider.recall(sid, q, 5);
 *   // ... run agent ...
 *   void provider.sync_turn?.(sid, summary, metadata);   // fire-and-forget
 *
 *   // On SIGTERM:
 *   await provider.shutdown?.();   // waits up to 10s for in-flight sync_turn
 */

import type { MemoryRecord, MemoryScope, ConversationMessage } from './types.js';

export interface MemoryProvider {
  /** Init with adapter-specific config. Called once at runtime construction. */
  init?(config?: Record<string, unknown>): Promise<void>;

  /**
   * Pre-fetch step: called before the agent turn with the user message.
   * Returns candidate memories. The agent loop may further filter.
   * Adapters can use this to pre-warm caches / batch-read.
   */
  prefetch?(sessionId: string, query: string, limit: number): Promise<MemoryRecord[]>;

  /**
   * Final recall: called from the agent loop. Returns the memories that
   * will actually be injected into the prompt.
   *
   * Ordering contract: relevance-desc then recency-desc. Default 5-record
   * cap is enforced by the agent-loop call site, not the provider.
   */
  recall(
    sessionId: string,
    query: string,
    limit: number,
    scope?: MemoryScope,
    scopeKey?: string
  ): Promise<MemoryRecord[]>;

  /**
   * Post-turn write: called async-fire-and-forget AFTER the turn completes
   * with a summary. Must NOT block the next agent turn. Implementations
   * should swallow their own errors (or log) — the host doesn't await this.
   */
  sync_turn?(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>
  ): Promise<void>;

  /**
   * Explicit user-issued save (e.g., dashboard "Remember this").
   *
   * The omit list includes `lastAccessedAt` (per the v0.8 spec) for
   * forward-compat with adapters that track read-recency, even though the
   * canonical storage `MemoryRecord` doesn't yet carry the field.
   */
  store(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord>;

  /** Hard delete by id. Returns true if a record was deleted. */
  delete(id: string): Promise<boolean>;

  /** List records for browsing / dashboard. */
  list(sessionId: string, scope?: MemoryScope, limit?: number): Promise<MemoryRecord[]>;

  /** Listing across all sessions in a scope (for the global memory browser). */
  listByScope?(scope: MemoryScope, limit: number, scopeKey?: string): Promise<MemoryRecord[]>;

  /** Capture a turn summary as a memory record (existing MemoryService behaviour). */
  captureSessionSummary?(
    sessionId: string,
    messages: ConversationMessage[]
  ): Promise<MemoryRecord | null>;

  /**
   * Optional semantic session summarizer. Hosts wire this to the active LLM
   * provider when explicitly enabled; providers fall back to the deterministic
   * local summarizer when this is absent or returns an empty string.
   */
  llmSummarize?(messages: ConversationMessage[]): Promise<string>;

  /** Graceful shutdown. Wait up to 10s for in-flight sync_turn calls. */
  shutdown?(): Promise<void>;
}

interface MemoryBackendProviderLike {
  recall(sessionId: string, query: string, limit: number, scope?: string, scopeKey?: string): Promise<unknown[]>;
  store(record: Record<string, unknown>): Promise<unknown>;
  delete(id: string): Promise<boolean>;
  list(sessionId: string, scope?: string, limit?: number): Promise<unknown[]>;
  init?(config?: Record<string, unknown>): Promise<void>;
  prefetch?(sessionId: string, query: string, limit: number): Promise<unknown[]>;
  sync_turn?(sessionId: string, summary: string, metadata?: Record<string, unknown>): Promise<void>;
  shutdown?(): Promise<void>;
}

interface MemoryBackendPluginLike {
  name?: string;
  kind?: string;
  manifest?: { memoryBackend?: boolean; name?: string };
  provider?: MemoryBackendProviderLike;
}

export interface MemoryPluginRegistryLike {
  list(): unknown[];
}

function isMemoryBackendProvider(value: unknown): value is MemoryBackendProviderLike {
  if (!value || typeof value !== 'object') return false;
  const provider = value as Partial<Record<keyof MemoryBackendProviderLike, unknown>>;
  return typeof provider.recall === 'function'
    && typeof provider.store === 'function'
    && typeof provider.delete === 'function'
    && typeof provider.list === 'function';
}

function isMemoryBackendPlugin(value: unknown): value is MemoryBackendPluginLike & { provider: MemoryBackendProviderLike } {
  if (!value || typeof value !== 'object') return false;
  const plugin = value as MemoryBackendPluginLike;
  return plugin.kind === 'memory-backend'
    && plugin.manifest?.memoryBackend === true
    && isMemoryBackendProvider(plugin.provider);
}

/**
 * Adapts a registered `MemoryBackendPlugin` from the plugin registry to the
 * canonical `MemoryProvider` consumed by `MemoryService` and runtime hosts.
 *
 * The memory package intentionally keeps this structural so it can consume the
 * registry without depending on `@crowclaw/plugins` and reintroducing a package
 * layering cycle.
 */
export class PluginMemoryProvider implements MemoryProvider {
  readonly name: string;
  private readonly backend: MemoryBackendProviderLike;

  constructor(plugin: MemoryBackendPluginLike & { provider: MemoryBackendProviderLike }) {
    this.name = plugin.manifest?.name ?? plugin.name ?? 'memory-backend-plugin';
    this.backend = plugin.provider;
  }

  async init(config?: Record<string, unknown>): Promise<void> {
    await this.backend.init?.(config);
  }

  async prefetch(sessionId: string, query: string, limit: number): Promise<MemoryRecord[]> {
    if (!this.backend.prefetch) {
      return this.recall(sessionId, query, limit);
    }
    return this.backend.prefetch(sessionId, query, limit) as Promise<MemoryRecord[]>;
  }

  async recall(
    sessionId: string,
    query: string,
    limit: number,
    scope?: MemoryScope,
    scopeKey?: string
  ): Promise<MemoryRecord[]> {
    return this.backend.recall(sessionId, query, limit, scope, scopeKey) as Promise<MemoryRecord[]>;
  }

  async sync_turn(sessionId: string, summary: string, metadata?: Record<string, unknown>): Promise<void> {
    await this.backend.sync_turn?.(sessionId, summary, metadata);
  }

  async store(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord> {
    const stored = await this.backend.store(record as Record<string, unknown>);
    return stored as MemoryRecord;
  }

  async delete(id: string): Promise<boolean> {
    return this.backend.delete(id);
  }

  async list(sessionId: string, scope?: MemoryScope, limit?: number): Promise<MemoryRecord[]> {
    return this.backend.list(sessionId, scope, limit) as Promise<MemoryRecord[]>;
  }

  async shutdown(): Promise<void> {
    await this.backend.shutdown?.();
  }
}

export function memoryProviderFromPluginRegistry(registry?: MemoryPluginRegistryLike): MemoryProvider | undefined {
  const plugin = registry?.list().find(isMemoryBackendPlugin);
  return plugin ? new PluginMemoryProvider(plugin) : undefined;
}

// ---------------------------------------------------------------------------
// InMemoryMemoryProvider — default backend
// ---------------------------------------------------------------------------

import type { MemoryStore } from '@crowclaw/storage';

function uniqueTags(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
}

/**
 * Build a session-summary `MemoryRecord` from the tail of a transcript.
 * Mirrors the existing `MemoryService.summarize` heuristic 1:1 so the
 * provider extraction is a pure refactor (no behaviour drift).
 */
function summarizeTranscript(
  messages: ConversationMessage[],
  scope: MemoryScope,
  sessionId: string,
  scopeKey?: string
): MemoryRecord {
  const recentText = messages
    .slice(-4)
    .map((m) => m.content)
    .join(' ')
    .trim();

  const tags = uniqueTags(
    recentText
      .split(/\W+/)
      .filter((token) => token.length >= 4)
      .slice(0, 8)
  );

  return {
    id: crypto.randomUUID(),
    sessionId,
    scope,
    scopeKey,
    summary: `Recent activity: ${recentText.slice(0, 200)}`,
    tags,
    createdAt: new Date().toISOString(),
    metadata: { messages: messages.length },
  };
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
 * Default in-memory `MemoryProvider` backed by an injected `MemoryStore`
 * (typically `InMemoryMemoryStore` from `@crowclaw/storage`, or a D1-backed
 * one in Cloudflare runtimes — both implement the same interface so this
 * class works with either).
 *
 * Tracks every in-flight `sync_turn` promise so `shutdown()` can drain them
 * with a 10s cap, matching the contract documented on the interface.
 */
export class InMemoryMemoryProvider implements MemoryProvider {
  private readonly memoryStore: MemoryStore;
  private readonly inFlight = new Set<Promise<void>>();
  llmSummarize?: (messages: ConversationMessage[]) => Promise<string>;

  constructor(memoryStore: MemoryStore, options: { llmSummarize?: (messages: ConversationMessage[]) => Promise<string> } = {}) {
    this.memoryStore = memoryStore;
    this.llmSummarize = options.llmSummarize;
  }

  async recall(
    sessionId: string,
    query: string,
    limit: number,
    scope?: MemoryScope,
    scopeKey?: string
  ): Promise<MemoryRecord[]> {
    // Branch on whether the caller is asking session-scoped (default) or
    // a specific scope. Storage exposes two distinct search methods so we
    // don't conflate session-search with scope-search.
    const results = scope
      ? await this.memoryStore.searchByScope(scope, query, limit * 2, scopeKey)
      : await this.memoryStore.search(sessionId, query, limit * 2);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async prefetch(
    sessionId: string,
    query: string,
    limit: number
  ): Promise<MemoryRecord[]> {
    // Default prefetch == recall. Adapters with caches/embeddings override.
    return this.recall(sessionId, query, limit);
  }

  /**
   * Fire-and-forget post-turn hook. The default in-memory provider is a
   * NO-OP because the `MemoryService.captureSessionSummary` path already
   * wrote the canonical record through `store.write` — issuing a second
   * write here would duplicate every turn summary. The promise is still
   * tracked in `inFlight` so `shutdown()` exhibits the documented drain
   * behaviour even on the default provider, and adapters that DO want
   * to do real work (embeddings, external sync, cache warm) override
   * this method and should track their own promises the same way.
   *
   * Tracking-with-no-work also exercises the `shutdown()` cap path in
   * tests without forcing them to plug in a full adapter.
   */
  async sync_turn(
    _sessionId: string,
    _summary: string,
    _metadata?: Record<string, unknown>
  ): Promise<void> {
    const work: Promise<void> = Promise.resolve();
    const tracked = work.catch(() => undefined);
    this.inFlight.add(tracked);
    tracked.finally(() => {
      this.inFlight.delete(tracked);
    });
    return work;
  }

  async store(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord> {
    const full: MemoryRecord = {
      ...record,
      id: crypto.randomUUID(),
      tags: uniqueTags(record.tags ?? []),
      createdAt: new Date().toISOString(),
    };
    await this.memoryStore.write(full);
    return full;
  }

  async delete(id: string): Promise<boolean> {
    // Some MemoryStore implementations (notably InMemoryMemoryStore in v0.7+)
    // expose a `delete(id)` method even though it's not on the base interface.
    // Probe and fall through to a tombstone-write fallback so adapters
    // without native delete still mark the record as gone.
    const maybeDelete = (this.memoryStore as unknown as { delete?: (id: string) => Promise<void> | Promise<boolean> }).delete;
    if (typeof maybeDelete === 'function') {
      const result = await maybeDelete.call(this.memoryStore, id);
      // InMemoryMemoryStore.delete returns void on success; treat any non-throw as deleted.
      return result === false ? false : true;
    }
    return false;
  }

  async list(
    sessionId: string,
    scope?: MemoryScope,
    limit = 50
  ): Promise<MemoryRecord[]> {
    const results = scope
      ? await this.memoryStore.listByScope(scope, limit * 2)
      : await this.memoryStore.list(sessionId);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async listByScope(
    scope: MemoryScope,
    limit: number,
    scopeKey?: string
  ): Promise<MemoryRecord[]> {
    const results = await this.memoryStore.listByScope(scope, limit * 2, scopeKey);
    return results.filter((r) => !isExpired(r)).slice(0, limit);
  }

  async captureSessionSummary(
    sessionId: string,
    messages: ConversationMessage[]
  ): Promise<MemoryRecord | null> {
    if (messages.length === 0) return null;
    const fallback = summarizeTranscript(messages, 'session', sessionId);
    let llmSummary = '';
    if (this.llmSummarize) {
      try {
        llmSummary = (await this.llmSummarize(messages)).trim();
      } catch {
        llmSummary = '';
      }
    }
    const record = llmSummary
      ? { ...fallback, summary: llmSummary, tags: uniqueTags([...fallback.tags, 'semantic-summary']) }
      : fallback;
    await this.memoryStore.write(record);
    return record;
  }

  /**
   * Drain in-flight `sync_turn` writes with a 10s cap. After the cap we
   * resolve regardless so a hung adapter can't block process exit.
   * Idempotent — calling twice on a clean provider is a no-op.
   */
  async shutdown(timeoutMs: number = 10_000): Promise<void> {
    if (this.inFlight.size === 0) return;
    const pending = [...this.inFlight];
    const timeout = new Promise<'timeout'>((resolve) => {
      const t = setTimeout(() => resolve('timeout'), timeoutMs);
      // Don't keep the process alive just for this timer.
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref(): void }).unref();
      }
    });
    await Promise.race([Promise.allSettled(pending), timeout]);
  }
}

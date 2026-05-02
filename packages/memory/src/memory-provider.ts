import type { MemoryRecord as StorageMemoryRecord, MemoryStore } from '@crowclaw/storage';
import type { EmbeddingMemoryStoreOptions } from './embedding-store.js';
import { EmbeddingMemoryStore } from './embedding-store.js';
import type { DreamMemoryStore } from './dream-memory.js';
import type { MemoryScope } from './types.js';

/**
 * A simplified memory record returned by the MemoryProvider abstraction.
 * Decoupled from the storage-layer MemoryRecord to allow provider-agnostic usage.
 */
export interface MemoryRecord {
  key: string;
  content: string;
  score?: number;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Minimal transcript shape consumed by `MemoryProvider.onSessionEnd`. Mirrors
 * `ConversationMessage` from `@crowclaw/core` but is intentionally restated
 * here so the memory package stays free of a runtime dep on core. Hosts can
 * pass `session.messages` directly.
 */
export interface SessionTranscriptMessage {
  role: string;
  content: string;
  createdAt?: string;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Pluggable memory backend. Implementations wrap a concrete storage mechanism
 * (in-memory map, embedding index, external DB, etc.) behind a uniform interface.
 *
 * Issue #85 — `onSessionEnd` is the canonical hook for end-of-session memory
 * consolidation (dream-memory live capture, session-summary writes, FTS
 * indexing). Hosts MUST pass the actual `session.messages` transcript here,
 * not `[]`. Previously some call sites passed an empty array, which silently
 * disabled summarisation. Implementations that don't need transcripts can
 * leave the hook unset.
 */
export interface MemoryProvider {
  name: string;
  /** Scopes this backend accepts. Omitted means all scopes for backward compatibility. */
  acceptedScopes?: MemoryScope[];
  dreamMemory?: DreamMemoryStore;
  llmSummarize?: (messages: SessionTranscriptMessage[]) => Promise<string>;
  store(key: string, content: string, metadata?: Record<string, unknown>, scope?: MemoryScope): Promise<void>;
  recall(query: string, limit?: number, scope?: MemoryScope): Promise<MemoryRecord[]>;
  forget(key: string): Promise<boolean>;
  /**
   * Optional end-of-session hook. The host calls this with the full
   * conversation transcript when a session terminates so the provider can
   * persist a summary, embed the transcript, etc. Errors thrown here are
   * caught by `MemoryManager.shutdown` and reported per-provider so one
   * failing backend cannot abort the rest of the fan-out.
   */
  onSessionEnd?(sessionId: string, messages: SessionTranscriptMessage[]): Promise<void>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DEFAULT_SESSION_ID = '__memory_manager__';

function toMemoryRecord(record: StorageMemoryRecord): MemoryRecord {
  return {
    key: record.id,
    content: record.summary,
    metadata: record.metadata,
    createdAt: record.createdAt,
  };
}

function uniqueTags(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((value) => value.toLowerCase()))];
}

function summarizeTranscript(messages: SessionTranscriptMessage[]): { summary: string; tags: string[] } {
  const recentText = messages
    .slice(-8)
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
    summary: `Recent activity: ${recentText.slice(0, 400)}`,
    tags,
  };
}

// ---------------------------------------------------------------------------
// BuiltInMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an InMemoryMemoryStore (or any MemoryStore) as a MemoryProvider.
 * Uses a fixed sessionId so all records live in the same logical bucket.
 */
export class BuiltInMemoryProvider implements MemoryProvider {
  readonly name: string;
  readonly acceptedScopes?: MemoryScope[];
  private readonly memoryStore: MemoryStore;
  private readonly sessionId: string;
  /** Track stored ids so forget() can locate records. */
  private readonly storedIds = new Map<string, string>();
  llmSummarize?: (messages: SessionTranscriptMessage[]) => Promise<string>;

  constructor(
    memoryStore: MemoryStore,
    name = 'built-in',
    sessionId = DEFAULT_SESSION_ID,
    options: { acceptedScopes?: MemoryScope[]; llmSummarize?: (messages: SessionTranscriptMessage[]) => Promise<string> } = {}
  ) {
    this.memoryStore = memoryStore;
    this.name = name;
    this.sessionId = sessionId;
    this.acceptedScopes = options.acceptedScopes;
    this.llmSummarize = options.llmSummarize;
  }

  async store(key: string, content: string, metadata?: Record<string, unknown>, scope: MemoryScope = 'session'): Promise<void> {
    const id = crypto.randomUUID();
    this.storedIds.set(key, id);
    const record: StorageMemoryRecord = {
      id,
      sessionId: this.sessionId,
      scope,
      scopeKey: typeof metadata?.scopeKey === 'string' ? metadata.scopeKey : undefined,
      summary: content,
      tags: [key],
      createdAt: new Date().toISOString(),
      metadata,
    };
    await this.memoryStore.write(record);
  }

  async recall(query: string, limit = 10, scope?: MemoryScope): Promise<MemoryRecord[]> {
    const results = scope
      ? await this.memoryStore.searchByScope(scope, query, limit)
      : await this.memoryStore.search(this.sessionId, query, limit);
    return results.map(toMemoryRecord);
  }

  async onSessionEnd(sessionId: string, messages: SessionTranscriptMessage[]): Promise<void> {
    if (messages.length === 0) return;
    const fallback = summarizeTranscript(messages);
    let semanticSummary = '';
    if (this.llmSummarize) {
      try {
        semanticSummary = (await this.llmSummarize(messages)).trim();
      } catch {
        semanticSummary = '';
      }
    }
    const summary = semanticSummary || fallback.summary;
    const tags = semanticSummary ? uniqueTags([...fallback.tags, 'semantic-summary']) : fallback.tags;
    const record: StorageMemoryRecord = {
      id: crypto.randomUUID(),
      sessionId,
      scope: 'session',
      summary,
      tags,
      createdAt: new Date().toISOString(),
      metadata: { messages: messages.length, source: semanticSummary ? 'llm' : 'local' },
    };
    await this.memoryStore.write(record);
  }

  async forget(key: string): Promise<boolean> {
    // The underlying MemoryStore interface does not expose a delete method,
    // so we write a tombstone record that marks the key as forgotten.
    const existingId = this.storedIds.get(key);
    if (!existingId) {
      return false;
    }
    const tombstone: StorageMemoryRecord = {
      id: existingId,
      sessionId: this.sessionId,
      scope: 'session',
      summary: '',
      tags: ['__forgotten__'],
      createdAt: new Date().toISOString(),
      metadata: { forgotten: true, forgottenAt: new Date().toISOString() },
    };
    await this.memoryStore.write(tombstone);
    this.storedIds.delete(key);
    return true;
  }
}

// ---------------------------------------------------------------------------
// EmbeddingMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an EmbeddingMemoryStore as a MemoryProvider, providing
 * vector-similarity-based recall.
 */
export class EmbeddingMemoryProvider implements MemoryProvider {
  readonly name: string;
  readonly acceptedScopes?: MemoryScope[];
  private readonly embeddingStore: EmbeddingMemoryStore;
  private readonly sessionId: string;
  private readonly storedIds = new Map<string, string>();

  constructor(
    options: EmbeddingMemoryStoreOptions,
    name = 'embedding',
    sessionId = DEFAULT_SESSION_ID,
    acceptedScopes?: MemoryScope[]
  ) {
    this.embeddingStore = new EmbeddingMemoryStore(options);
    this.name = name;
    this.sessionId = sessionId;
    this.acceptedScopes = acceptedScopes;
  }

  async store(key: string, content: string, metadata?: Record<string, unknown>, scope: MemoryScope = 'session'): Promise<void> {
    const id = crypto.randomUUID();
    this.storedIds.set(key, id);
    const record: StorageMemoryRecord = {
      id,
      sessionId: this.sessionId,
      scope,
      scopeKey: typeof metadata?.scopeKey === 'string' ? metadata.scopeKey : undefined,
      summary: content,
      tags: [key],
      createdAt: new Date().toISOString(),
      metadata,
    };
    await this.embeddingStore.write(record);
  }

  async recall(query: string, limit = 10, scope?: MemoryScope): Promise<MemoryRecord[]> {
    const results = scope
      ? await this.embeddingStore.searchByScope(scope, query, limit)
      : await this.embeddingStore.search(this.sessionId, query, limit);
    return results.map(toMemoryRecord);
  }

  async forget(key: string): Promise<boolean> {
    const existingId = this.storedIds.get(key);
    if (!existingId) {
      return false;
    }
    const tombstone: StorageMemoryRecord = {
      id: existingId,
      sessionId: this.sessionId,
      scope: 'session',
      summary: '',
      tags: ['__forgotten__'],
      createdAt: new Date().toISOString(),
      metadata: { forgotten: true, forgottenAt: new Date().toISOString() },
    };
    await this.embeddingStore.write(tombstone);
    this.storedIds.delete(key);
    return true;
  }
}

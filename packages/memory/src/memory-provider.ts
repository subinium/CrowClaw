import type { MemoryRecord as StorageMemoryRecord, MemoryStore } from '@crowclaw/storage';
import type { EmbeddingMemoryStoreOptions } from './embedding-store.js';
import { EmbeddingMemoryStore } from './embedding-store.js';

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
 * Pluggable memory backend. Implementations wrap a concrete storage mechanism
 * (in-memory map, embedding index, external DB, etc.) behind a uniform interface.
 */
export interface MemoryProvider {
  name: string;
  store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void>;
  recall(query: string, limit?: number): Promise<MemoryRecord[]>;
  forget(key: string): Promise<boolean>;
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

// ---------------------------------------------------------------------------
// BuiltInMemoryProvider
// ---------------------------------------------------------------------------

/**
 * Wraps an InMemoryMemoryStore (or any MemoryStore) as a MemoryProvider.
 * Uses a fixed sessionId so all records live in the same logical bucket.
 */
export class BuiltInMemoryProvider implements MemoryProvider {
  readonly name: string;
  private readonly memoryStore: MemoryStore;
  private readonly sessionId: string;
  /** Track stored ids so forget() can locate records. */
  private readonly storedIds = new Map<string, string>();

  constructor(memoryStore: MemoryStore, name = 'built-in', sessionId = DEFAULT_SESSION_ID) {
    this.memoryStore = memoryStore;
    this.name = name;
    this.sessionId = sessionId;
  }

  async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const id = crypto.randomUUID();
    this.storedIds.set(key, id);
    const record: StorageMemoryRecord = {
      id,
      sessionId: this.sessionId,
      scope: 'session',
      summary: content,
      tags: [key],
      createdAt: new Date().toISOString(),
      metadata,
    };
    await this.memoryStore.write(record);
  }

  async recall(query: string, limit = 10): Promise<MemoryRecord[]> {
    const results = await this.memoryStore.search(this.sessionId, query, limit);
    return results.map(toMemoryRecord);
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
  private readonly embeddingStore: EmbeddingMemoryStore;
  private readonly sessionId: string;
  private readonly storedIds = new Map<string, string>();

  constructor(options: EmbeddingMemoryStoreOptions, name = 'embedding', sessionId = DEFAULT_SESSION_ID) {
    this.embeddingStore = new EmbeddingMemoryStore(options);
    this.name = name;
    this.sessionId = sessionId;
  }

  async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const id = crypto.randomUUID();
    this.storedIds.set(key, id);
    const record: StorageMemoryRecord = {
      id,
      sessionId: this.sessionId,
      scope: 'session',
      summary: content,
      tags: [key],
      createdAt: new Date().toISOString(),
      metadata,
    };
    await this.embeddingStore.write(record);
  }

  async recall(query: string, limit = 10): Promise<MemoryRecord[]> {
    const results = await this.embeddingStore.search(this.sessionId, query, limit);
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

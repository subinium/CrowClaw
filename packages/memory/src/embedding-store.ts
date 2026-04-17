import type { MemoryRecord, MemoryStore } from '@crowclaw/storage';

/** Provider that converts text into embedding vectors. */
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingMemoryStoreOptions {
  baseStore: MemoryStore;
  embeddingProvider: EmbeddingProvider;
  similarityThreshold?: number;
  deduplicationThreshold?: number;
  /** Cap total vectors held in the in-memory index. FIFO eviction beyond the
   *  cap (oldest insertion order). Without a cap, the linear-scan `search()`
   *  crosses 100ms around 10k entries and grows without bound. Defaults to
   *  10_000 — pair with a real ANN backend for anything higher. */
  maxVectors?: number;
}

/** Cosine similarity between two vectors. Returns 0 if either vector has zero magnitude. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    magA += a[i]! * a[i]!;
    magB += b[i]! * b[i]!;
  }

  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  if (denom === 0) {
    return 0;
  }

  return dot / denom;
}

/** Simple in-memory embedding index for vector similarity search. */
export class EmbeddingIndex {
  private readonly vectors = new Map<string, number[]>();
  private readonly maxVectors: number | undefined;

  constructor(options?: { maxVectors?: number }) {
    this.maxVectors = options?.maxVectors;
  }

  /** Returns the id of the evicted record, if eviction fired. */
  add(id: string, vector: number[]): string | null {
    this.vectors.set(id, vector);
    // FIFO eviction once capped — Map preserves insertion order.
    if (this.maxVectors !== undefined && this.vectors.size > this.maxVectors) {
      const oldest = this.vectors.keys().next().value;
      if (oldest !== undefined && oldest !== id) {
        this.vectors.delete(oldest);
        return oldest;
      }
    }
    return null;
  }

  remove(id: string): void {
    this.vectors.delete(id);
  }

  search(
    query: number[],
    topK: number,
    threshold: number
  ): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    for (const [id, vector] of this.vectors) {
      const score = cosineSimilarity(query, vector);
      if (score >= threshold) {
        results.push({ id, score });
      }
    }

    results.sort((a, b) => b.score - a.score);
    return results.slice(0, topK);
  }

  size(): number {
    return this.vectors.size;
  }
}

function uniqueTags(values: string[]): string[] {
  return [...new Set(values.filter(Boolean).map((v) => v.toLowerCase()))];
}

/**
 * Wraps a base MemoryStore and adds embedding-based similarity search.
 *
 * On write: computes embedding, checks deduplication (cosine > deduplicationThreshold
 * merges tags instead of inserting a new record), then delegates to the base store.
 *
 * On search: computes query embedding, ranks by cosine similarity, returns top-k.
 */
export class EmbeddingMemoryStore implements MemoryStore {
  private readonly baseStore: MemoryStore;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly similarityThreshold: number;
  private readonly deduplicationThreshold: number;
  private readonly index: EmbeddingIndex;
  /** Maps record id -> record for dedup lookups. */
  private readonly recordCache = new Map<string, MemoryRecord>();
  private readonly maxVectors: number;

  constructor(options: EmbeddingMemoryStoreOptions) {
    this.baseStore = options.baseStore;
    this.embeddingProvider = options.embeddingProvider;
    this.similarityThreshold = options.similarityThreshold ?? 0.7;
    this.deduplicationThreshold = options.deduplicationThreshold ?? 0.95;
    this.maxVectors = options.maxVectors ?? 10_000;
    this.index = new EmbeddingIndex({ maxVectors: this.maxVectors });
  }

  async write(record: MemoryRecord): Promise<void> {
    const [embedding] = await this.embeddingProvider.embed([record.summary]);
    if (!embedding) {
      await this.baseStore.write(record);
      return;
    }

    // Check for duplicates in the index
    const candidates = this.index.search(embedding, 1, this.deduplicationThreshold);
    if (candidates.length > 0) {
      const existingId = candidates[0]!.id;
      const existing = this.recordCache.get(existingId);
      if (existing) {
        // Merge: update content and combine tags
        const merged: MemoryRecord = {
          ...existing,
          summary: record.summary,
          tags: uniqueTags([...existing.tags, ...record.tags]),
          metadata: { ...existing.metadata, ...record.metadata }
        };
        this.recordCache.set(existingId, merged);
        this.index.remove(existingId);
        this.index.add(existingId, embedding);
        await this.baseStore.write(merged);
        return;
      }
    }

    // No duplicate — insert as new. Prune recordCache alongside the index
    // so the two stay the same size (otherwise recordCache leaks past maxVectors).
    const evicted = this.index.add(record.id, embedding);
    if (evicted) this.recordCache.delete(evicted);
    this.recordCache.set(record.id, record);
    await this.baseStore.write(record);
  }

  async search(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    if (!queryEmbedding) {
      return this.baseStore.search(sessionId, query, limit);
    }

    const hits = this.index.search(queryEmbedding, limit * 2, this.similarityThreshold);
    if (hits.length === 0) {
      return [];
    }

    // Fetch all records from base store for this session, then filter by index hits
    const allRecords = await this.baseStore.list(sessionId);
    const hitIds = new Set(hits.map((h) => h.id));
    const scoreMap = new Map(hits.map((h) => [h.id, h.score]));

    return allRecords
      .filter((r) => hitIds.has(r.id))
      .sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0))
      .slice(0, limit);
  }

  async searchByScope(
    scope: MemoryRecord['scope'],
    query: string,
    limit = 10,
    scopeKey?: string
  ): Promise<MemoryRecord[]> {
    const [queryEmbedding] = await this.embeddingProvider.embed([query]);
    if (!queryEmbedding) {
      return this.baseStore.searchByScope(scope, query, limit, scopeKey);
    }

    const hits = this.index.search(queryEmbedding, limit * 2, this.similarityThreshold);
    if (hits.length === 0) {
      return [];
    }

    const allRecords = await this.baseStore.listByScope(scope, limit * 2, scopeKey);
    const hitIds = new Set(hits.map((h) => h.id));
    const scoreMap = new Map(hits.map((h) => [h.id, h.score]));

    return allRecords
      .filter((r) => hitIds.has(r.id))
      .sort((a, b) => (scoreMap.get(b.id) ?? 0) - (scoreMap.get(a.id) ?? 0))
      .slice(0, limit);
  }

  async list(sessionId: string): Promise<MemoryRecord[]> {
    return this.baseStore.list(sessionId);
  }

  async listByScope(
    scope: MemoryRecord['scope'],
    limit?: number,
    scopeKey?: string
  ): Promise<MemoryRecord[]> {
    return this.baseStore.listByScope(scope, limit, scopeKey);
  }
}

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
   *  2_000 (#104) — tightened from 10_000 because the linear-scan search is
   *  O(n·d) and crosses the 100ms budget around 5k×1536-dim vectors. Pair
   *  with a real ANN backend (e.g. hnswlib-node) for anything higher;
   *  hnswlib integration tracked as a follow-up. */
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

/** Compute the L2 magnitude (Euclidean norm) of a vector. */
function vectorMagnitude(v: number[]): number {
  let sum = 0;
  for (let i = 0; i < v.length; i++) {
    sum += v[i]! * v[i]!;
  }
  return Math.sqrt(sum);
}

/**
 * Simple in-memory embedding index for vector similarity search.
 *
 * Perf (#104): vector magnitudes are cached on insert so `search()` only does
 * one dot-product + one divide per candidate (instead of two `Math.sqrt`
 * per candidate). Combined with an early-exit when the dot product is
 * non-positive but the threshold is positive (the cosine score is bounded
 * above by `dot / (|q|·|v|)`, so a non-positive dot can never beat a
 * positive threshold), this halves CPU on the common ranking case.
 *
 * For >2k vectors, prefer an ANN backend (hnswlib-node) — tracked as a
 * follow-up to #104.
 */
export class EmbeddingIndex {
  private readonly vectors = new Map<string, number[]>();
  /** Cached |v| per id — populated on `add`, dropped on `remove`. */
  private readonly norms = new Map<string, number>();
  private readonly maxVectors: number | undefined;

  constructor(options?: { maxVectors?: number }) {
    this.maxVectors = options?.maxVectors;
  }

  /** Returns the id of the evicted record, if eviction fired. */
  add(id: string, vector: number[]): string | null {
    this.vectors.set(id, vector);
    this.norms.set(id, vectorMagnitude(vector));
    // FIFO eviction once capped — Map preserves insertion order.
    if (this.maxVectors !== undefined && this.vectors.size > this.maxVectors) {
      const oldest = this.vectors.keys().next().value;
      if (oldest !== undefined && oldest !== id) {
        this.vectors.delete(oldest);
        this.norms.delete(oldest);
        return oldest;
      }
    }
    return null;
  }

  remove(id: string): void {
    this.vectors.delete(id);
    this.norms.delete(id);
  }

  search(
    query: number[],
    topK: number,
    threshold: number
  ): Array<{ id: string; score: number }> {
    const results: Array<{ id: string; score: number }> = [];

    if (query.length === 0) {
      return results;
    }

    // Pre-compute the query magnitude once instead of every candidate.
    const qMag = vectorMagnitude(query);
    if (qMag === 0) {
      return results;
    }

    for (const [id, vector] of this.vectors) {
      if (vector.length !== query.length) {
        continue;
      }
      const vMag = this.norms.get(id);
      if (vMag === undefined || vMag === 0) {
        continue;
      }

      // Inline dot product — keeps the hot loop branch-free.
      let dot = 0;
      for (let i = 0; i < query.length; i++) {
        dot += query[i]! * vector[i]!;
      }

      // Early-exit: when threshold > 0, a non-positive dot can never produce
      // a passing score (cosine has the same sign as the dot product).
      if (threshold > 0 && dot <= 0) {
        continue;
      }

      const score = dot / (qMag * vMag);
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
    // #104: tightened from 10_000 — see EmbeddingMemoryStoreOptions.maxVectors.
    this.maxVectors = options.maxVectors ?? 2_000;
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

    // Pull only the matching records instead of `list(sessionId)` + filter.
    // For a 1k-record session with 5 hits this collapses 1000 reads to 5.
    // `getByIds` preserves input order, so the score ranking from `index.search`
    // (already sorted desc) carries through. We still filter by sessionId
    // because the index is global across sessions.
    const hitIds = hits.map((h) => h.id);
    const fetched = await this.baseStore.getByIds(hitIds);
    return fetched
      .filter((record) => record.sessionId === sessionId)
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

    // Fetch ranked hits directly, then scope-filter — avoids paging the entire
    // scope just to intersect with k matches.
    const hitIds = hits.map((h) => h.id);
    const fetched = await this.baseStore.getByIds(hitIds);
    return fetched
      .filter((record) => record.scope === scope && (!scopeKey || record.scopeKey === scopeKey))
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

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    return this.baseStore.getByIds(ids);
  }
}

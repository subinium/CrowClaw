import type { MemoryProvider, MemoryRecord } from './memory-provider.js';

/**
 * Orchestrates multiple MemoryProviders, fanning out writes to all backends
 * and merging results on recall. Deduplication is key-based: when multiple
 * providers return a record with the same key, the one with the highest score
 * (or most recent createdAt) wins.
 */
export class MemoryManager {
  private providers: MemoryProvider[] = [];

  addProvider(provider: MemoryProvider): void {
    this.providers.push(provider);
  }

  /** Store a key-value pair in ALL registered providers. */
  async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    await Promise.all(
      this.providers.map((provider) => provider.store(key, content, metadata))
    );
  }

  /**
   * Query all providers, merge results, and deduplicate by key.
   * When duplicates exist, the record with the highest score wins;
   * ties are broken by most recent createdAt.
   */
  async recall(query: string, limit = 10): Promise<MemoryRecord[]> {
    const allResults = await Promise.all(
      this.providers.map((provider) => provider.recall(query, limit))
    );

    const merged = allResults.flat();
    const deduped = this.deduplicateByKey(merged);

    return deduped.slice(0, limit);
  }

  /** Remove a key from ALL providers. Returns true if at least one provider removed it. */
  async forget(key: string): Promise<boolean> {
    const results = await Promise.all(
      this.providers.map((provider) => provider.forget(key))
    );
    return results.some(Boolean);
  }

  /** Deduplicate records by key, keeping the best record per key. */
  private deduplicateByKey(records: MemoryRecord[]): MemoryRecord[] {
    const best = new Map<string, MemoryRecord>();

    for (const record of records) {
      const existing = best.get(record.key);
      if (!existing || this.isBetter(record, existing)) {
        best.set(record.key, record);
      }
    }

    // Sort by score descending (if present), then by createdAt descending
    return [...best.values()].sort((a, b) => {
      const scoreDiff = (b.score ?? 0) - (a.score ?? 0);
      if (scoreDiff !== 0) return scoreDiff;
      return b.createdAt.localeCompare(a.createdAt);
    });
  }

  /** Returns true if `candidate` should replace `existing`. */
  private isBetter(candidate: MemoryRecord, existing: MemoryRecord): boolean {
    const candidateScore = candidate.score ?? 0;
    const existingScore = existing.score ?? 0;

    if (candidateScore !== existingScore) {
      return candidateScore > existingScore;
    }

    return candidate.createdAt > existing.createdAt;
  }
}

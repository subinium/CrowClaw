import { redactStructuredData } from '@crowclaw/core';
import type {
  MemoryProvider,
  MemoryRecord,
  SessionTranscriptMessage,
} from './memory-provider.js';

/**
 * Per-provider outcome reported by `MemoryManager.shutdown`. Hosts can log
 * failures without losing the rest of the fan-out result. (#85)
 */
export interface SessionEndResult {
  /** Provider name as reported by `MemoryProvider.name`. */
  provider: string;
  /** Whether the provider's `onSessionEnd` ran (false when the hook was unset). */
  invoked: boolean;
  /** Whether the hook completed without throwing. */
  ok: boolean;
  /** Error message when `ok === false`. */
  error?: string;
}

/**
 * Metadata flag that opts a single `store()` call out of credential
 * redaction (#137). Use only for tools that intentionally persist secret
 * material (e.g. an explicit `secrets.put` tool, a credential-vault provider).
 *
 * Set `metadata.__skipRedaction = true` to bypass. The flag is stripped
 * before the metadata reaches the provider, so it never leaks into storage.
 */
export const SKIP_REDACTION_FLAG = '__skipRedaction';

/**
 * Orchestrates multiple MemoryProviders, fanning out writes to all backends
 * and merging results on recall. Deduplication is key-based: when multiple
 * providers return a record with the same key, the one with the highest score
 * (or most recent createdAt) wins.
 *
 * Security (#137): all writes pass through `redactStructuredData` from
 * `@crowclaw/core` so accidentally-captured credentials (API keys, bearer
 * tokens, PEM blocks, sensitive metadata keys like `authorization`) never
 * persist into provider backends. Opt out per-call via the
 * `SKIP_REDACTION_FLAG` metadata flag for explicit secret-handling tools.
 * Source: internal security audit + OpenClaw issue #42982 ("avoid echoing
 * rotated device tokens").
 */
export class MemoryManager {
  private providers: MemoryProvider[] = [];

  addProvider(provider: MemoryProvider): void {
    this.providers.push(provider);
  }

  /**
   * Store a key-value pair in ALL registered providers. Content and metadata
   * are run through credential redaction (#137) unless the caller sets
   * `metadata[SKIP_REDACTION_FLAG] = true`. The opt-out flag is stripped
   * before being persisted.
   */
  async store(key: string, content: string, metadata?: Record<string, unknown>): Promise<void> {
    const skipRedaction = metadata?.[SKIP_REDACTION_FLAG] === true;

    // Always strip the opt-out flag — it's a routing hint, not data we
    // want sitting in a memory backend (and would leak across providers).
    let cleanedMetadata: Record<string, unknown> | undefined = metadata;
    if (metadata && SKIP_REDACTION_FLAG in metadata) {
      const { [SKIP_REDACTION_FLAG]: _drop, ...rest } = metadata;
      cleanedMetadata = Object.keys(rest).length > 0 ? rest : undefined;
    }

    let safeContent = content;
    let safeMetadata = cleanedMetadata;
    if (!skipRedaction) {
      // `redactStructuredData` walks strings through `redactCredentials` and
      // wholesale-blanks values under sensitive keys (token, secret, bearer,
      // authorization, ...). Top-level strings are handled directly.
      safeContent = redactStructuredData(content);
      safeMetadata = cleanedMetadata
        ? redactStructuredData(cleanedMetadata)
        : undefined;
    }

    await Promise.all(
      this.providers.map((provider) => provider.store(key, safeContent, safeMetadata))
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

  /**
   * Fan a session-end transcript out to every provider's optional
   * `onSessionEnd` hook. Issue #85 — previously the host passed `[]` here,
   * which silently disabled dream-memory live capture and end-of-session
   * summarisation. Callers MUST pass the live `session.messages` array.
   *
   * Errors are caught per-provider so a single failing backend does not
   * abort the rest of the fan-out. Returns one `SessionEndResult` per
   * registered provider, in registration order.
   */
  async shutdown(
    sessionId: string,
    messages: SessionTranscriptMessage[],
  ): Promise<SessionEndResult[]> {
    if (!Array.isArray(messages)) {
      // Defensive: a host bug that passes `null`/`undefined` should not
      // crash shutdown, but we surface it via an empty-transcript result so
      // the issue is observable in logs.
      messages = [];
    }
    return Promise.all(
      this.providers.map(async (provider): Promise<SessionEndResult> => {
        if (typeof provider.onSessionEnd !== 'function') {
          return { provider: provider.name, invoked: false, ok: true };
        }
        try {
          await provider.onSessionEnd(sessionId, messages);
          return { provider: provider.name, invoked: true, ok: true };
        } catch (err: unknown) {
          const error = err instanceof Error ? err.message : String(err);
          return { provider: provider.name, invoked: true, ok: false, error };
        }
      }),
    );
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

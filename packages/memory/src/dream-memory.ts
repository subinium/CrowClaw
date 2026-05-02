/**
 * Dream Memory: 2-stage memory consolidation (inspired by Nanobot).
 * Stage 1: Live session summaries captured after each conversation
 * Stage 2: Background consolidation merges summaries into long-term entries
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DreamEntry {
  id: string;
  content: string;
  source: 'session' | 'consolidation';
  sourceSessionIds: string[];
  createdAt: string;
  consolidatedAt?: string;
}

export interface DreamMemoryStore {
  addLive(sessionId: string, summary: string): Promise<void>;
  consolidate(maxEntries?: number): Promise<DreamEntry[]>;
  getLongTerm(limit?: number): Promise<DreamEntry[]>;
  formatForPrompt(limit?: number): Promise<string>;
}

// ---------------------------------------------------------------------------
// InMemoryDreamStore
// ---------------------------------------------------------------------------

/**
 * Hard cap on consolidated entries retained in `longTerm` (#122). Without a
 * cap, repeated `consolidate()` calls grow the array unbounded and OOM the
 * worker after enough sessions. Newest entries are kept; oldest evicted.
 */
const MAX_LONG_TERM = 500;

export class InMemoryDreamStore implements DreamMemoryStore {
  private live: Map<string, { summary: string; createdAt: string }> = new Map();
  private longTerm: DreamEntry[] = [];

  /** Stage 1: capture a live session summary. */
  async addLive(sessionId: string, summary: string): Promise<void> {
    this.live.set(sessionId, {
      summary,
      createdAt: new Date().toISOString(),
    });
  }

  /**
   * Stage 2: consolidate live entries into long-term memory.
   * Groups live summaries, merges similar ones, and promotes to longTerm.
   * Returns the newly created long-term entries.
   */
  async consolidate(maxEntries = 10): Promise<DreamEntry[]> {
    if (this.live.size === 0) {
      return [];
    }

    const newEntries: DreamEntry[] = [];
    const liveEntries = [...this.live.entries()];

    // Group live entries into chunks for consolidation
    const chunkSize = Math.max(1, Math.ceil(liveEntries.length / maxEntries));
    for (let i = 0; i < liveEntries.length; i += chunkSize) {
      const chunk = liveEntries.slice(i, i + chunkSize);
      const firstEntry = chunk[0];
      if (!firstEntry) {
        continue;
      }
      const firstLiveEntry = firstEntry[1];
      if (!firstLiveEntry) {
        continue;
      }
      const sessionIds = chunk.map(([id]) => id);
      const mergedContent = chunk
        .map(([, entry]) => entry.summary)
        .join(' | ');

      const entry: DreamEntry = {
        id: crypto.randomUUID(),
        content: mergedContent,
        source: 'consolidation',
        sourceSessionIds: sessionIds,
        createdAt: firstLiveEntry.createdAt,
        consolidatedAt: new Date().toISOString(),
      };

      newEntries.push(entry);
    }

    // Promote to long-term and clear live entries.
    this.longTerm.push(...newEntries);
    // Cap longTerm at MAX_LONG_TERM (#122). Splice the oldest entries from the
    // front so the most recent consolidations always survive.
    if (this.longTerm.length > MAX_LONG_TERM) {
      this.longTerm.splice(0, this.longTerm.length - MAX_LONG_TERM);
    }
    this.live.clear();

    return newEntries;
  }

  /** Retrieve long-term consolidated entries, most recent first. */
  async getLongTerm(limit = 20): Promise<DreamEntry[]> {
    return this.longTerm
      .slice()
      .sort((a, b) => {
        const aTime = a.consolidatedAt ?? a.createdAt;
        const bTime = b.consolidatedAt ?? b.createdAt;
        return bTime.localeCompare(aTime);
      })
      .slice(0, limit);
  }

  /** Format top-N long-term entries as a markdown summary suitable for prompt injection. */
  async formatForPrompt(limit = 5): Promise<string> {
    const entries = await this.getLongTerm(limit);
    if (entries.length === 0) {
      return '';
    }

    const lines = entries.map((entry, idx) => {
      const sessions = entry.sourceSessionIds.join(', ');
      return `${idx + 1}. [${entry.source}] ${entry.content} (sessions: ${sessions})`;
    });

    return `## Long-term Memory\n${lines.join('\n')}`;
  }
}

import { describe, expect, it } from 'vitest';
import { D1MemoryStore, type MemoryRecord } from '@crowclaw/storage';
import type { D1DatabaseLike } from '@crowclaw/shared';

type MemoryRow = {
  id: string;
  session_id: string;
  scope: 'session' | 'user' | 'workspace';
  scope_key?: string | null;
  summary: string;
  tags_json: string;
  created_at: string;
  metadata_json?: string;
};

class FakeD1Database implements D1DatabaseLike {
  private readonly rows: MemoryRow[] = [];

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>() => {
          const results = this.runQuery(query, values);
          return (results[0] ?? null) as T | null;
        },
        all: async <T>() => ({
          results: this.runQuery(query, values) as T[]
        }),
        run: async () => {
          this.runMutation(query, values);
          return { success: true };
        }
      })
    };
  }

  private runMutation(query: string, values: unknown[]): void {
    if (!query.includes('INSERT INTO memories')) {
      return;
    }

    const [id, sessionId, scope, scopeKey, summary, tagsJson, createdAt, metadataJson] = values;
    this.rows.push({
      id: String(id),
      session_id: String(sessionId),
      scope: scope as MemoryRow['scope'],
      scope_key: scopeKey == null ? null : String(scopeKey),
      summary: String(summary),
      tags_json: String(tagsJson),
      created_at: String(createdAt),
      metadata_json: metadataJson == null ? undefined : String(metadataJson)
    });
  }

  private runQuery(query: string, values: unknown[]): MemoryRow[] {
    let results = [...this.rows];

    if (query.includes('WHERE session_id = ?1')) {
      const [sessionId, likeValue, limit] = values;
      const needle = String(likeValue).replaceAll('%', '').toLowerCase();
      results = results
        .filter((row) => row.session_id === String(sessionId))
        .filter((row) => this.matchesNeedle(row, needle))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Number(limit));
      return results;
    }

    if (query.includes('WHERE scope = ?1')) {
      if (query.includes('summary LIKE ?2')) {
        const [scope, likeValue, limit, scopeKey] = values;
        const needle = String(likeValue).replaceAll('%', '').toLowerCase();
        results = results
          .filter((row) => row.scope === scope)
          .filter((row) => scopeKey == null || row.scope_key === String(scopeKey))
          .filter((row) => this.matchesNeedle(row, needle))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, Number(limit));
        return results;
      }

      const [scope, limit, scopeKey] = values;
      results = results
        .filter((row) => row.scope === scope)
        .filter((row) => scopeKey == null || row.scope_key === String(scopeKey))
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, Number(limit));
      return results;
    }

    return [];
  }

  private matchesNeedle(row: MemoryRow, needle: string): boolean {
    if (!needle) {
      return true;
    }
    return row.summary.toLowerCase().includes(needle)
      || row.tags_json.toLowerCase().includes(needle)
      || String(row.metadata_json ?? '').toLowerCase().includes(needle);
  }
}

describe('D1MemoryStore', () => {
  it('supports scope-keyed list/search ordering and metadata-aware search', async () => {
    const db = new FakeD1Database();
    const store = new D1MemoryStore(db);

    const records: MemoryRecord[] = [
      {
        id: 'm1',
        sessionId: 's1',
        scope: 'workspace',
        scopeKey: 'workspace-a',
        summary: 'older workspace note',
        tags: ['cloudflare'],
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {
        id: 'm2',
        sessionId: 's2',
        scope: 'workspace',
        scopeKey: 'workspace-b',
        summary: 'other workspace note',
        tags: ['cloudflare'],
        createdAt: '2026-01-02T00:00:00.000Z'
      },
      {
        id: 'm3',
        sessionId: 's3',
        scope: 'workspace',
        scopeKey: 'workspace-a',
        summary: 'newest workspace note',
        tags: ['edge'],
        createdAt: '2026-01-03T00:00:00.000Z',
        metadata: { owner: 'workspace-a', lane: 'ops' }
      }
    ];

    for (const record of records) {
      await store.write(record);
    }

    const scopedSearch = await store.searchByScope('workspace', 'owner', 10, 'workspace-a');
    expect(scopedSearch).toHaveLength(1);
    expect(scopedSearch[0]?.id).toBe('m3');

    const sessionSearch = await store.search('s3', 'ops', 10);
    expect(sessionSearch).toHaveLength(1);
    expect(sessionSearch[0]?.id).toBe('m3');

    const scopedList = await store.listByScope('workspace', 10, 'workspace-a');
    expect(scopedList.map((record) => record.id)).toEqual(['m3', 'm1']);
  });
});

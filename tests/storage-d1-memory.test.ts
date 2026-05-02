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
      const [sessionId] = values;
      results = results
        .filter((row) => row.session_id === String(sessionId))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return results;
    }

    if (query.includes('WHERE scope = ?1')) {
      if (query.includes('LIMIT ?2')) {
        const [scope, limit, scopeKey] = values;
        results = results
          .filter((row) => row.scope === scope)
          .filter((row) => scopeKey == null || row.scope_key === String(scopeKey))
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .slice(0, Number(limit));
        return results;
      }

      const [scope, scopeKey] = values;
      results = results
        .filter((row) => row.scope === scope)
        .filter((row) => scopeKey == null || row.scope_key === String(scopeKey))
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return results;
    }

    return [];
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

  it('uses deterministic local semantic ranking for session and scoped search', async () => {
    const db = new FakeD1Database();
    const store = new D1MemoryStore(db);

    await store.write({
      id: 'finance',
      sessionId: 'semantic-d1',
      scope: 'workspace',
      scopeKey: 'workspace-a',
      summary: 'newer invoice reconciliation note',
      tags: ['finance'],
      createdAt: '2026-01-02T00:00:00.000Z'
    });
    await store.write({
      id: 'kubernetes-deploy',
      sessionId: 'semantic-d1',
      scope: 'workspace',
      scopeKey: 'workspace-a',
      summary: 'Kubernetes canary deployment strategy',
      tags: ['cluster'],
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    const sessionSearch = await store.search('semantic-d1', 'k8s rollout', 5);
    expect(sessionSearch.map((record) => record.id)).toEqual(['kubernetes-deploy']);

    const scopedSearch = await store.searchByScope('workspace', 'k8s rollout', 5, 'workspace-a');
    expect(scopedSearch.map((record) => record.id)).toEqual(['kubernetes-deploy']);
  });
});

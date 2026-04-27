import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  D1MemoryStore,
  D1SessionStore,
  FileCheckpointStore,
  InMemoryMemoryStore,
  type MemoryRecord
} from '@crowclaw/storage';
import { createCheckpoint } from '@crowclaw/core';
import type { SessionState } from '@crowclaw/core';
import type { D1DatabaseLike } from '@crowclaw/shared';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * v0.6.0 storage fixes regression tests:
 *  - #99  D1MemoryStore upsert
 *  - #100 D1SessionStore atomic FTS via batch
 *  - #105 InMemoryMemoryStore sorted-on-write
 *  - #107 D1MemoryStore.getByIds chunking
 *  - #110 D1SessionStore incremental FTS index
 *  - #112 FileCheckpointStore O(1) get via flat index
 */

// -----------------------------------------------------------------------------
// #99: D1MemoryStore upsert — fake D1 that simulates a UNIQUE(id) constraint.
// -----------------------------------------------------------------------------

interface MemoryRow {
  id: string;
  session_id: string;
  scope: 'session' | 'user' | 'workspace';
  scope_key: string | null;
  summary: string;
  tags_json: string;
  created_at: string;
  metadata_json?: string;
}

class UpsertAwareD1 implements D1DatabaseLike {
  public readonly rows = new Map<string, MemoryRow>();
  public conflictUpdates = 0;
  public uniqueViolationsThrown = 0;

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>() => {
          const r = this.runQuery(query, values);
          return (r[0] ?? null) as T | null;
        },
        all: async <T>() => ({ results: this.runQuery(query, values) as T[] }),
        run: async () => {
          this.runMutation(query, values);
          return { success: true };
        }
      })
    };
  }

  private runMutation(query: string, values: unknown[]): void {
    if (!query.includes('INSERT INTO memories')) return;
    const [id, sessionId, scope, scopeKey, summary, tagsJson, createdAt, metadataJson] = values;
    const newRow: MemoryRow = {
      id: String(id),
      session_id: String(sessionId),
      scope: scope as MemoryRow['scope'],
      scope_key: scopeKey == null ? null : String(scopeKey),
      summary: String(summary),
      tags_json: String(tagsJson),
      created_at: String(createdAt),
      metadata_json: metadataJson == null ? undefined : String(metadataJson)
    };

    if (this.rows.has(newRow.id)) {
      if (query.includes('ON CONFLICT(id) DO UPDATE')) {
        // Upsert: refresh mutable fields, leave session_id/created_at stable.
        const existing = this.rows.get(newRow.id)!;
        this.rows.set(newRow.id, {
          ...existing,
          scope: newRow.scope,
          scope_key: newRow.scope_key,
          summary: newRow.summary,
          tags_json: newRow.tags_json,
          metadata_json: newRow.metadata_json
        });
        this.conflictUpdates += 1;
        return;
      }
      this.uniqueViolationsThrown += 1;
      throw new Error('UNIQUE constraint failed: memories.id');
    }

    this.rows.set(newRow.id, newRow);
  }

  private runQuery(query: string, values: unknown[]): MemoryRow[] {
    if (query.includes('FROM memories') && query.includes('WHERE id IN')) {
      const ids = values.map(String);
      return ids
        .map((id) => this.rows.get(id))
        .filter((r): r is MemoryRow => r !== undefined);
    }
    return [];
  }
}

describe('#99 D1MemoryStore.write upsert', () => {
  it('rewrites the same id without raising UNIQUE violation', async () => {
    const db = new UpsertAwareD1();
    const store = new D1MemoryStore(db);

    const base: MemoryRecord = {
      id: 'mem-1',
      sessionId: 'session-a',
      scope: 'session',
      summary: 'first version',
      tags: ['v1'],
      createdAt: '2026-01-01T00:00:00.000Z'
    };

    await store.write(base);
    // Second write of the SAME id with updated content (mimics
    // EmbeddingStore's dedup-merge re-write path).
    await store.write({ ...base, summary: 'second version', tags: ['v2'], metadata: { ver: 2 } });

    expect(db.uniqueViolationsThrown).toBe(0);
    expect(db.conflictUpdates).toBe(1);
    expect(db.rows.size).toBe(1);
    const row = db.rows.get('mem-1')!;
    expect(row.summary).toBe('second version');
    expect(row.tags_json).toContain('v2');
  });
});

// -----------------------------------------------------------------------------
// #100: D1SessionStore.indexSession atomic FTS via batch
// -----------------------------------------------------------------------------

class BatchAwareD1 implements D1DatabaseLike {
  public sessions = new Map<string, { payload: string; updated_at: string }>();
  /** Tracks whether an FTS row currently exists. */
  public ftsRow: { sessionId: string; content: string } | null = null;
  /** Records every batch invocation so the test can assert atomicity. */
  public batchCalls: number = 0;
  public lastBatchSize: number = 0;
  /** If set, the next `batch` call rejects after applying NO statements (the
   *  atomic semantics: either all or none). Used to assert that crash-mid-batch
   *  doesn't leave a half-deleted FTS row. */
  public failNextBatch = false;

  prepare(query: string) {
    return {
      bind: (...values: unknown[]) => ({
        first: async <T>() => null as T | null,
        all: async <T>() => ({ results: [] as T[] }),
        run: async () => {
          this.applyMutation(query, values);
          return { success: true };
        },
        // Marker so batch() can recover the (query, values) pair.
        __query: query,
        __values: values
      })
    };
  }

  async batch(statements: Array<{ __query?: string; __values?: unknown[] }>): Promise<unknown> {
    this.batchCalls += 1;
    this.lastBatchSize = statements.length;
    if (this.failNextBatch) {
      this.failNextBatch = false;
      throw new Error('simulated mid-batch fault');
    }
    for (const stmt of statements) {
      if (!stmt.__query || !stmt.__values) continue;
      this.applyMutation(stmt.__query, stmt.__values);
    }
    return { success: true };
  }

  private applyMutation(query: string, values: unknown[]): void {
    if (query.includes('INSERT INTO sessions ')) {
      const [id, payload, updatedAt] = values;
      this.sessions.set(String(id), { payload: String(payload), updated_at: String(updatedAt) });
      return;
    }
    if (query.includes('DELETE FROM sessions_fts')) {
      this.ftsRow = null;
      return;
    }
    if (query.includes('INSERT INTO sessions_fts')) {
      const [sessionId, content] = values;
      this.ftsRow = { sessionId: String(sessionId), content: String(content) };
      return;
    }
  }
}

function makeSession(messages: Array<{ role: 'user' | 'assistant'; content: string }>, sessionId = 'session-1'): SessionState {
  return {
    agentId: 'agent-1',
    sessionId,
    messages: messages.map((m, i) => ({
      role: m.role,
      content: m.content,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString()
    })),
    updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 1, 0)).toISOString()
  };
}

describe('#100 D1SessionStore atomic FTS via batch', () => {
  it('uses batch API for DELETE+INSERT so the FTS update is atomic', async () => {
    const db = new BatchAwareD1();
    const store = new D1SessionStore(db);

    const session = makeSession([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]);

    await store.put(session);

    expect(db.batchCalls).toBe(1);
    expect(db.lastBatchSize).toBe(2);
    expect(db.ftsRow).not.toBeNull();
    expect(db.ftsRow?.sessionId).toBe(session.sessionId);
    expect(db.ftsRow?.content).toContain('hello');
    expect(db.ftsRow?.content).toContain('world');
  });

  it('leaves FTS row in pre-call state if the batch fails (atomic)', async () => {
    const db = new BatchAwareD1();
    const store = new D1SessionStore(db);

    // Seed an existing FTS row by completing one successful put first.
    const seeded = makeSession([{ role: 'user', content: 'seeded' }], 'session-x');
    await store.put(seeded);
    expect(db.ftsRow?.content).toBe('seeded');

    // Now fail the next batch — simulates worker crash mid-update. Append a
    // new message so the incremental-FTS optimization (#110) still triggers
    // the re-index (which then fails atomically thanks to #100's batch).
    db.failNextBatch = true;
    const next = makeSession([
      { role: 'user', content: 'seeded' },
      { role: 'assistant', content: 'updated' }
    ], 'session-x');
    await expect(store.put(next)).rejects.toThrow(/mid-batch/);

    // Atomic semantics: original row preserved, NOT half-deleted.
    expect(db.ftsRow?.content).toBe('seeded');
  });
});

// -----------------------------------------------------------------------------
// #105: InMemoryMemoryStore sorted-on-write
// -----------------------------------------------------------------------------

describe('#105 InMemoryMemoryStore sorted-on-write', () => {
  it('returns list() in newest-first order without sorting on read', async () => {
    const store = new InMemoryMemoryStore();

    // Insert OUT OF ORDER on purpose to verify the bucket ends up sorted.
    const records: MemoryRecord[] = [
      { id: 'm-mid', sessionId: 's', scope: 'session', summary: 'mid', tags: [], createdAt: '2026-01-02T00:00:00.000Z' },
      { id: 'm-old', sessionId: 's', scope: 'session', summary: 'old', tags: [], createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'm-new', sessionId: 's', scope: 'session', summary: 'new', tags: [], createdAt: '2026-01-03T00:00:00.000Z' }
    ];
    for (const r of records) await store.write(r);

    const listed = await store.list('s');
    expect(listed.map((r) => r.id)).toEqual(['m-new', 'm-mid', 'm-old']);

    // Defensive slice: mutating the returned array must not corrupt the
    // internal bucket.
    listed.reverse();
    const listedAgain = await store.list('s');
    expect(listedAgain.map((r) => r.id)).toEqual(['m-new', 'm-mid', 'm-old']);
  });

  it('search respects sorted-on-write order and limit', async () => {
    const store = new InMemoryMemoryStore();
    for (let i = 0; i < 5; i += 1) {
      await store.write({
        id: `m${i}`,
        sessionId: 's',
        scope: 'session',
        summary: `match-${i}`,
        tags: ['common'],
        createdAt: new Date(Date.UTC(2026, 0, 1 + i)).toISOString()
      });
    }
    const hits = await store.search('s', 'match', 3);
    // Newest-first slice of size 3: m4, m3, m2.
    expect(hits.map((r) => r.id)).toEqual(['m4', 'm3', 'm2']);
  });

  it('rewriting the same id keeps the bucket sorted', async () => {
    const store = new InMemoryMemoryStore();
    await store.write({ id: 'a', sessionId: 's', scope: 'session', summary: 'a', tags: [], createdAt: '2026-01-01T00:00:00.000Z' });
    await store.write({ id: 'b', sessionId: 's', scope: 'session', summary: 'b', tags: [], createdAt: '2026-01-02T00:00:00.000Z' });
    // Rewrite 'a' with a NEWER timestamp — must move to the front.
    await store.write({ id: 'a', sessionId: 's', scope: 'session', summary: 'a-updated', tags: [], createdAt: '2026-01-03T00:00:00.000Z' });

    const listed = await store.list('s');
    expect(listed.map((r) => r.id)).toEqual(['a', 'b']);
    expect(listed[0]!.summary).toBe('a-updated');
  });
});

// -----------------------------------------------------------------------------
// #107: D1MemoryStore.getByIds chunking for >500 ids
// -----------------------------------------------------------------------------

class ChunkTrackingD1 implements D1DatabaseLike {
  public readonly rows = new Map<string, MemoryRow>();
  /** Sizes of each `IN (...)` chunk passed to `prepare`, in call order. */
  public chunkSizes: number[] = [];

  prepare(query: string) {
    const isGetByIds = query.includes('FROM memories') && query.includes('WHERE id IN');
    return {
      bind: (...values: unknown[]) => {
        if (isGetByIds) {
          this.chunkSizes.push(values.length);
        }
        return {
          first: async <T>() => null as T | null,
          all: async <T>() => {
            const ids = values.map(String);
            const matches = ids
              .map((id) => this.rows.get(id))
              .filter((r): r is MemoryRow => r !== undefined);
            return { results: matches as T[] };
          },
          run: async () => {
            if (query.includes('INSERT INTO memories')) {
              const [id, sessionId, scope, scopeKey, summary, tagsJson, createdAt, metadataJson] = values;
              this.rows.set(String(id), {
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
            return { success: true };
          }
        };
      }
    };
  }
}

describe('#107 D1MemoryStore.getByIds chunking', () => {
  it('splits >500 ids into chunks of 500 and preserves input order', async () => {
    const db = new ChunkTrackingD1();
    const store = new D1MemoryStore(db);

    const total = 1250;
    const ids: string[] = [];
    for (let i = 0; i < total; i += 1) {
      const id = `m-${String(i).padStart(5, '0')}`;
      ids.push(id);
      await store.write({
        id,
        sessionId: 's',
        scope: 'session',
        summary: id,
        tags: [],
        createdAt: '2026-01-01T00:00:00.000Z'
      });
    }
    db.chunkSizes = []; // reset — only count getByIds chunks below.

    // Caller-controlled order: reverse so we can verify ordering preservation.
    const queryOrder = [...ids].reverse();
    const out = await store.getByIds(queryOrder);

    expect(out.map((r) => r.id)).toEqual(queryOrder);
    expect(db.chunkSizes).toEqual([500, 500, 250]);
  });

  it('handles empty and small input without spurious chunks', async () => {
    const db = new ChunkTrackingD1();
    const store = new D1MemoryStore(db);

    expect(await store.getByIds([])).toEqual([]);
    expect(db.chunkSizes).toEqual([]);

    await store.write({
      id: 'one',
      sessionId: 's',
      scope: 'session',
      summary: 'one',
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    db.chunkSizes = [];
    const result = await store.getByIds(['one']);
    expect(result.map((r) => r.id)).toEqual(['one']);
    expect(db.chunkSizes).toEqual([1]);
  });
});

// -----------------------------------------------------------------------------
// #110: D1SessionStore incremental FTS index
// -----------------------------------------------------------------------------

describe('#110 D1SessionStore incremental FTS index', () => {
  it('skips re-indexing when message count is unchanged', async () => {
    const db = new BatchAwareD1();
    const store = new D1SessionStore(db);

    const session = makeSession([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' }
    ]);

    await store.put(session);
    expect(db.batchCalls).toBe(1);

    // Re-put the SAME session (e.g. lastToolActivityAt bump or duplicate
    // stream flush). FTS index should be skipped because message count
    // hasn't changed.
    await store.put(session);
    expect(db.batchCalls).toBe(1); // unchanged
  });

  it('re-indexes when a new message is appended', async () => {
    const db = new BatchAwareD1();
    const store = new D1SessionStore(db);

    const session = makeSession([{ role: 'user', content: 'first' }]);
    await store.put(session);
    expect(db.batchCalls).toBe(1);

    const grown = makeSession([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'second' }
    ]);
    await store.put(grown);
    expect(db.batchCalls).toBe(2);
    expect(db.ftsRow?.content).toContain('second');
  });
});

// -----------------------------------------------------------------------------
// #112: FileCheckpointStore O(1) get via flat index
// -----------------------------------------------------------------------------

describe('#112 FileCheckpointStore O(1) get', () => {
  let testDir: string;
  let store: FileCheckpointStore;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'crowclaw-cp-v06-'));
    store = new FileCheckpointStore(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('writes a flat index entry on save and uses it for direct lookup', async () => {
    const session: SessionState = {
      agentId: 'a',
      sessionId: 'session-aaa',
      messages: [],
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const cp = createCheckpoint(session, [], 1, 'iteration', 'cp-test');

    await store.save(cp);

    // Index file exists at {baseDir}/_index/{checkpointId}.json
    const indexFile = join(testDir, '_index', cp.id + '.json');
    const indexStat = await stat(indexFile);
    expect(indexStat.isFile()).toBe(true);

    // Lookup still returns the checkpoint (identical to legacy behavior).
    const loaded = await store.get(cp.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(cp.id);
    expect(loaded!.sessionId).toBe('session-aaa');
  });

  it('get() uses the index even when many session directories exist', async () => {
    // Spread checkpoints across many session directories. The fast path must
    // not depend on which directory the target lives in.
    const sessions = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
    const ids: string[] = [];
    for (const sessionId of sessions) {
      const cp = createCheckpoint(
        { agentId: 'a', sessionId, messages: [], updatedAt: '2026-01-01T00:00:00.000Z' },
        [],
        1,
        'iteration'
      );
      await store.save(cp);
      ids.push(cp.id);
    }

    // Sample a few lookups. Each should resolve correctly.
    for (const id of ids) {
      const loaded = await store.get(id);
      expect(loaded?.id).toBe(id);
    }

    // Verify the index directory contains exactly N entries (no leftovers).
    const indexEntries = await readdir(join(testDir, '_index'));
    expect(indexEntries.filter((f) => f.endsWith('.json'))).toHaveLength(ids.length);
  });

  it('falls back to scan when the index entry is missing (legacy data)', async () => {
    const cp = createCheckpoint(
      { agentId: 'a', sessionId: 'legacy-session', messages: [], updatedAt: '2026-01-01T00:00:00.000Z' },
      [],
      1,
      'iteration'
    );
    await store.save(cp);

    // Simulate legacy on-disk state by removing the index entry.
    await rm(join(testDir, '_index', cp.id + '.json'));

    const loaded = await store.get(cp.id);
    expect(loaded?.id).toBe(cp.id);
  });

  it('delete() removes the index entry along with the checkpoint file', async () => {
    const cp = createCheckpoint(
      { agentId: 'a', sessionId: 'session-del', messages: [], updatedAt: '2026-01-01T00:00:00.000Z' },
      [],
      1,
      'iteration'
    );
    await store.save(cp);
    expect(await store.delete(cp.id)).toBe(true);

    // Index entry must also be gone — otherwise stale pointers accumulate.
    await expect(stat(join(testDir, '_index', cp.id + '.json'))).rejects.toThrow();
    expect(await store.get(cp.id)).toBeNull();
  });

  it('deleteBySession cleans up index entries for every removed checkpoint', async () => {
    const session: SessionState = {
      agentId: 'a',
      sessionId: 'session-batch-del',
      messages: [],
      updatedAt: '2026-01-01T00:00:00.000Z'
    };
    const cp1 = createCheckpoint(session, [], 1, 'iteration');
    const cp2 = createCheckpoint(session, [], 2, 'iteration');
    await store.save(cp1);
    await store.save(cp2);

    const removed = await store.deleteBySession(session.sessionId);
    expect(removed).toBe(2);

    await expect(stat(join(testDir, '_index', cp1.id + '.json'))).rejects.toThrow();
    await expect(stat(join(testDir, '_index', cp2.id + '.json'))).rejects.toThrow();
  });
});

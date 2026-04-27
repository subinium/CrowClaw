import type { SessionState, SessionStore, CheckpointStore, SessionCheckpoint } from '@crowclaw/core';
import type { D1DatabaseLike, D1StatementLike } from '@crowclaw/shared';
import { mkdir, readFile, writeFile, readdir, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * #100: Local widening of `D1DatabaseLike` to optionally expose D1's `batch`
 * API for atomic multi-statement execution. Not added to `@crowclaw/shared`
 * to keep the surface there minimal — storage is the only consumer that
 * needs transactional batching today. Real CF D1 always exposes `batch`;
 * test fakes may opt-in by providing it.
 *
 * `batch` accepts the *bound* statements returned by `D1StatementLike.bind()`
 * (which omit `bind` themselves), so the parameter type widens accordingly.
 */
type D1BoundStatement = ReturnType<D1StatementLike['bind']>;
interface D1DatabaseWithBatch extends D1DatabaseLike {
  batch?(statements: D1BoundStatement[]): Promise<unknown>;
}

export interface SessionSearchHit {
  sessionId: string;
  content: string;
  rank?: number;
}

export interface SessionSearchStore {
  search(sessionId: string, query: string, limit?: number): Promise<SessionSearchHit[]>;
  indexSession(session: SessionState): Promise<void>;
}

export interface SessionListStore {
  list(): Promise<SessionState[]>;
  listRecent(limit?: number): Promise<SessionState[]>;
}

export interface MemoryRecord {
  id: string;
  sessionId: string;
  scope: 'session' | 'user' | 'workspace';
  scopeKey?: string;
  summary: string;
  tags: string[];
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryStore {
  search(sessionId: string, query: string, limit?: number): Promise<MemoryRecord[]>;
  searchByScope(scope: MemoryRecord['scope'], query: string, limit?: number, scopeKey?: string): Promise<MemoryRecord[]>;
  write(record: MemoryRecord): Promise<void>;
  list(sessionId: string): Promise<MemoryRecord[]>;
  listByScope(scope: MemoryRecord['scope'], limit?: number, scopeKey?: string): Promise<MemoryRecord[]>;
  /**
   * Fetch records by id in a single round-trip. Order of the returned array
   * matches `ids`; missing ids are omitted (not nulled). Used by hot paths
   * like embedding-store search where loading the full session just to filter
   * down to k hits is wasteful at session scale.
   */
  getByIds(ids: string[]): Promise<MemoryRecord[]>;
}

function normalizeNeedle(query: string): string {
  return query.trim().toLowerCase();
}

function matchesScope(record: MemoryRecord, scope: MemoryRecord['scope'], scopeKey?: string): boolean {
  return record.scope === scope && (!scopeKey || record.scopeKey === scopeKey);
}

/**
 * Pre-index a record's searchable text once at write time so `matchesQuery`
 * can skip repeated `JSON.stringify(metadata).toLowerCase()` on every search.
 * We stash it on a weakly-typed symbol field so the serialized MemoryRecord
 * shape stays stable across storage boundaries.
 */
const SEARCH_BLOB = Symbol('searchBlob');
type IndexedRecord = MemoryRecord & { [SEARCH_BLOB]?: string };

function buildSearchBlob(record: MemoryRecord): string {
  return `${record.summary}\n${record.tags.join('\n')}\n${JSON.stringify(record.metadata ?? {})}`.toLowerCase();
}

function getSearchBlob(record: IndexedRecord): string {
  if (record[SEARCH_BLOB] !== undefined) return record[SEARCH_BLOB]!;
  const blob = buildSearchBlob(record);
  record[SEARCH_BLOB] = blob;
  return blob;
}

function matchesQuery(record: MemoryRecord, query: string): boolean {
  const needle = normalizeNeedle(query);
  if (!needle) return true;
  return getSearchBlob(record as IndexedRecord).includes(needle);
}

function sortByNewest(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/**
 * #105: Insert `record` into a bucket already sorted newest-first by
 * `createdAt`, in O(log n) via binary search + O(n) splice. Replaces the
 * naive append-then-sort-on-read pattern so per-session `list`/`search`
 * reads can return a zero-sort slice. Records arriving out-of-order
 * (e.g. backfill / clock skew) still land in the correct slot.
 */
function insertSortedDesc(bucket: MemoryRecord[], record: MemoryRecord): void {
  let lo = 0;
  let hi = bucket.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // Newest-first: if record.createdAt > bucket[mid].createdAt, it belongs earlier.
    if (record.createdAt > bucket[mid]!.createdAt) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  bucket.splice(lo, 0, record);
}

export class InMemorySessionStore implements SessionStore, SessionSearchStore, SessionListStore {
  private readonly store = new Map<string, SessionState>();

  get size(): number {
    return this.store.size;
  }

  async get(sessionId: string): Promise<SessionState | null> {
    return this.store.get(sessionId) ?? null;
  }

  async put(session: SessionState): Promise<void> {
    this.store.set(session.sessionId, session);
  }

  async indexSession(session: SessionState): Promise<void> {
    this.store.set(session.sessionId, session);
  }

  async list(): Promise<SessionState[]> {
    return [...this.store.values()];
  }

  async listRecent(limit = 50): Promise<SessionState[]> {
    return [...this.store.values()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit);
  }

  async search(sessionId: string, query: string, limit = 10): Promise<SessionSearchHit[]> {
    const session = this.store.get(sessionId);
    if (!session) {
      return [];
    }

    const needle = query.toLowerCase();
    return session.messages
      .filter((message) => message.content.toLowerCase().includes(needle))
      .slice(0, limit)
      .map((message) => ({ sessionId, content: message.content }));
  }

  async searchAll(query: string, limit = 10): Promise<Array<{ sessionId: string; matches: Array<{ role: string; content: string; score: number }> }>> {
    const needle = normalizeNeedle(query);
    if (!needle) {
      return [];
    }

    const terms = needle.split(/\s+/).filter(Boolean);
    const grouped: Array<{ sessionId: string; matches: Array<{ role: string; content: string; score: number }> }> = [];

    for (const [sessionId, session] of this.store) {
      const matches: Array<{ role: string; content: string; score: number }> = [];
      for (const message of session.messages) {
        const lower = message.content.toLowerCase();
        const score = terms.reduce((count, term) => count + (lower.includes(term) ? 1 : 0), 0);
        if (score > 0) {
          matches.push({ role: message.role, content: message.content, score });
        }
      }
      if (matches.length > 0) {
        matches.sort((a, b) => b.score - a.score);
        grouped.push({ sessionId, matches: matches.slice(0, limit) });
      }
    }

    // Sort session groups by their best match score descending
    grouped.sort((a, b) => (b.matches[0]?.score ?? 0) - (a.matches[0]?.score ?? 0));
    return grouped.slice(0, limit);
  }
}

export class InMemoryMemoryStore implements MemoryStore {
  /** #105: Each bucket is held sorted newest-first by `createdAt` so reads
   *  (`list`, `search`) skip the per-call copy+sort. `write` does an O(log n)
   *  binary-search insertion (see `insertSortedDesc`). */
  private readonly store = new Map<string, MemoryRecord[]>();
  /** Secondary index for O(1) `getByIds` lookups so consumers don't have to
   *  scan every session bucket to find a record by id. */
  private readonly byId = new Map<string, MemoryRecord>();

  async search(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    // #105: bucket is already sorted newest-first → no copy+sort on read.
    const bucket = this.store.get(sessionId);
    if (!bucket) return [];
    const out: MemoryRecord[] = [];
    for (const record of bucket) {
      if (matchesQuery(record, query)) {
        out.push(record);
        if (out.length >= limit) break;
      }
    }
    return out;
  }

  async searchByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    // Filter first (cheap scope check), then query (cached search blob).
    // Previous implementation ran query filter over every record in every
    // session regardless of scope, then flattened + stringified metadata
    // per-record — catastrophic at 10 sessions × 100 memories.
    const out: MemoryRecord[] = [];
    for (const records of this.store.values()) {
      for (const record of records) {
        if (matchesScope(record, scope, scopeKey) && matchesQuery(record, query)) {
          out.push(record);
        }
      }
    }
    // Cross-bucket aggregation still needs a final sort, but each input
    // bucket is already sorted, so the sort is on a smaller filtered slice.
    return sortByNewest(out).slice(0, limit);
  }

  async write(record: MemoryRecord): Promise<void> {
    // #105: keep buckets sorted newest-first so reads are zero-sort.
    // Pre-compute search blob once so later matchesQuery() calls are O(|needle|).
    (record as IndexedRecord)[SEARCH_BLOB] = buildSearchBlob(record);
    const existing = this.store.get(record.sessionId);
    if (existing) {
      // Replace in-place if the same id already exists (e.g. embedding-store
      // dedup merge writes the same id back). Without this the bucket would
      // accumulate stale copies and `getByIds` could surface them. We remove
      // first then re-insert so position reflects the (possibly updated)
      // createdAt of the new record.
      const idx = existing.findIndex((r) => r.id === record.id);
      if (idx >= 0) {
        existing.splice(idx, 1);
      }
      insertSortedDesc(existing, record);
    } else {
      this.store.set(record.sessionId, [record]);
    }
    this.byId.set(record.id, record);
  }

  async list(sessionId: string): Promise<MemoryRecord[]> {
    // #105: zero-sort read — return a defensive slice so callers can't mutate
    // the internal bucket order.
    const bucket = this.store.get(sessionId);
    return bucket ? bucket.slice() : [];
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    const out: MemoryRecord[] = [];
    for (const records of this.store.values()) {
      for (const record of records) {
        if (matchesScope(record, scope, scopeKey)) out.push(record);
      }
    }
    return sortByNewest(out).slice(0, limit);
  }

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    // Preserve the input order so callers ranking by score upstream (e.g. the
    // embedding store) get back records in the same order they asked for.
    const out: MemoryRecord[] = [];
    for (const id of ids) {
      const record = this.byId.get(id);
      if (record) out.push(record);
    }
    return out;
  }
}

export class D1SessionStore implements SessionStore, SessionSearchStore, SessionListStore {
  /** #110: per-instance incremental FTS index cache. Maps `sessionId` →
   *  message count last indexed. If a subsequent `indexSession` call sees
   *  the same count it skips the rebuild entirely. Held in memory so the
   *  cache is best-effort across worker restarts (a cold start indexes
   *  unconditionally, which is correct). For a Durable-Object-style single
   *  writer this is sufficient; multi-writer setups still get correct
   *  behavior because `put` always rebuilds when message count changes. */
  private readonly indexedMessageCount = new Map<string, number>();

  constructor(private readonly db: D1DatabaseLike) {}

  async get(sessionId: string): Promise<SessionState | null> {
    const row = await this.db
      .prepare('SELECT payload FROM sessions WHERE id = ?1')
      .bind(sessionId)
      .first<{ payload: string }>();

    return row?.payload ? (JSON.parse(row.payload) as SessionState) : null;
  }

  async put(session: SessionState): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO sessions (id, payload, updated_at)
         VALUES (?1, ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`
      )
      .bind(session.sessionId, JSON.stringify(session), session.updatedAt)
      .run();

    await this.indexSession(session);
  }

  async indexSession(session: SessionState): Promise<void> {
    // #110: skip the full FTS rebuild when no new messages have been appended.
    // The current sessions_fts schema stores one row per session_id with the
    // full concatenated transcript, so a true append-only incremental update
    // is not possible without a schema change; the next-best optimization is
    // to detect "nothing changed" and short-circuit. This already eliminates
    // the dominant duplicate-write case from `put()` after a no-op
    // `lastToolActivityAt` bump or repeated stream flushes.
    const lastCount = this.indexedMessageCount.get(session.sessionId);
    if (lastCount === session.messages.length) {
      return;
    }

    const transcript = session.messages.map((message) => message.content).join('\n');

    // #100: DELETE+INSERT must be atomic. Without a transaction, a worker
    // crash between the two leaves the FTS row deleted but never re-inserted,
    // so the session disappears from full-text search. D1's `batch` API runs
    // multiple prepared statements in a single transaction.
    const dbWithBatch = this.db as D1DatabaseWithBatch;
    const deleteStmt = this.db
      .prepare('DELETE FROM sessions_fts WHERE session_id = ?1')
      .bind(session.sessionId);
    const insertStmt = this.db
      .prepare(
        `INSERT INTO sessions_fts (session_id, content)
         VALUES (?1, ?2)`
      )
      .bind(session.sessionId, transcript);

    if (typeof dbWithBatch.batch === 'function') {
      await dbWithBatch.batch([deleteStmt, insertStmt]);
    } else {
      // Fallback for D1-likes that don't expose `batch` (older test fakes).
      // Real `@cloudflare/workers-types` D1 always exposes `batch`. The order
      // here intentionally mirrors the batched form so behavior is the same
      // on the happy path; the rare crash window between the two calls is
      // the documented limitation.
      await (deleteStmt as { run(): Promise<unknown> }).run();
      await (insertStmt as { run(): Promise<unknown> }).run();
    }

    this.indexedMessageCount.set(session.sessionId, session.messages.length);
  }

  async search(sessionId: string, query: string, limit = 10): Promise<SessionSearchHit[]> {
    const statement = this.db
      .prepare(
        `SELECT session_id, content, bm25(sessions_fts) AS rank
         FROM sessions_fts
         WHERE session_id = ?1 AND sessions_fts MATCH ?2
         LIMIT ?3`
      )
      .bind(sessionId, query, limit);

    if (statement.all) {
      const result = await statement.all<{ session_id: string; content: string; rank?: number }>();
      return result.results.map((row) => ({
        sessionId: row.session_id,
        content: row.content,
        rank: row.rank
      }));
    }

    const single = await statement.first<{ session_id: string; content: string; rank?: number }>();
    return single ? [{ sessionId: single.session_id, content: single.content, rank: single.rank }] : [];
  }

  async list(): Promise<SessionState[]> {
    const statement = this.db
      .prepare('SELECT payload FROM sessions ORDER BY updated_at DESC');

    if (statement.all) {
      const result = await statement.all<{ payload: string }>();
      return result.results.map((row) => JSON.parse(row.payload) as SessionState);
    }

    if (!statement.first) {
      return [];
    }
    const single = await statement.first<{ payload: string }>();
    return single?.payload ? [JSON.parse(single.payload) as SessionState] : [];
  }

  async listRecent(limit = 50): Promise<SessionState[]> {
    const statement = this.db
      .prepare(
        `SELECT payload
         FROM sessions
         ORDER BY updated_at DESC
         LIMIT ?1`
      )
      .bind(limit);

    if (statement.all) {
      const result = await statement.all<{ payload: string }>();
      return result.results
        .map((row) => JSON.parse(row.payload) as SessionState);
    }

    if (!statement.first) {
      return [];
    }
    const single = await statement.first<{ payload: string }>();
    return single?.payload ? [JSON.parse(single.payload) as SessionState] : [];
  }
}

export class D1MemoryStore implements MemoryStore {
  constructor(private readonly db: D1DatabaseLike) {}

  private mapRow(row: { id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }): MemoryRecord {
    return {
      id: row.id,
      sessionId: row.session_id,
      scope: row.scope,
      scopeKey: row.scope_key ?? undefined,
      summary: row.summary,
      tags: JSON.parse(row.tags_json) as string[],
      createdAt: row.created_at,
      metadata: row.metadata_json ? JSON.parse(row.metadata_json) as Record<string, unknown> : undefined
    };
  }

  async search(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    const statement = this.db
      .prepare(
        `SELECT id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json
         FROM memories
         WHERE session_id = ?1 AND (summary LIKE ?2 OR tags_json LIKE ?2 OR IFNULL(metadata_json, '') LIKE ?2)
         ORDER BY created_at DESC
         LIMIT ?3`
      )
      .bind(sessionId, `%${query}%`, limit);

    if (statement.all) {
      const results = await statement.all<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
      return results.results.map((row) => this.mapRow(row));
    }

    const row = await statement.first<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
    return row ? [this.mapRow(row)] : [];
  }

  async searchByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    const statement = this.db
      .prepare(
        `SELECT id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json
         FROM memories
         WHERE scope = ?1 AND (summary LIKE ?2 OR tags_json LIKE ?2 OR IFNULL(metadata_json, '') LIKE ?2)
           AND (?4 IS NULL OR scope_key = ?4)
         ORDER BY created_at DESC
         LIMIT ?3`
      )
      .bind(scope, `%${query}%`, limit, scopeKey ?? null);

    if (statement.all) {
      const results = await statement.all<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
      return results.results.map((row) => this.mapRow(row));
    }

    const row = await statement.first<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
    return row ? [this.mapRow(row)] : [];
  }

  async write(record: MemoryRecord): Promise<void> {
    // #99: Upsert semantics — `EmbeddingStore`'s dedup-merge re-writes the
    // same id back, and D1 raises a UNIQUE-constraint error on plain INSERT.
    // `InMemoryMemoryStore` already does in-place replacement; the D1 backend
    // must match. We deliberately do NOT update `session_id`/`created_at`
    // (those are identity-ish and stable for a given memory id) but do
    // refresh the mutable fields a merge would touch.
    await this.db
      .prepare(
        `INSERT INTO memories (id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(id) DO UPDATE SET
           scope = excluded.scope,
           scope_key = excluded.scope_key,
           summary = excluded.summary,
           tags_json = excluded.tags_json,
           metadata_json = excluded.metadata_json`
      )
      .bind(
        record.id,
        record.sessionId,
        record.scope,
        record.scopeKey ?? null,
        record.summary,
        JSON.stringify(record.tags),
        record.createdAt,
        JSON.stringify(record.metadata ?? null)
      )
      .run();
  }

  async list(sessionId: string): Promise<MemoryRecord[]> {
    const statement = this.db
      .prepare(
        `SELECT id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json
         FROM memories
         WHERE session_id = ?1
         ORDER BY created_at DESC`
      )
      .bind(sessionId);

    if (statement.all) {
      const results = await statement.all<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
      return results.results.map((row) => this.mapRow(row));
    }

    const row = await statement.first<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
    return row ? [this.mapRow(row)] : [];
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    const statement = this.db
      .prepare(
        `SELECT id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json
         FROM memories
         WHERE scope = ?1
           AND (?3 IS NULL OR scope_key = ?3)
         ORDER BY created_at DESC
         LIMIT ?2`
      )
      .bind(scope, limit, scopeKey ?? null);

    if (statement.all) {
      const results = await statement.all<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
      return results.results.map((row) => this.mapRow(row));
    }

    const row = await statement.first<{ id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string }>();
    return row ? [this.mapRow(row)] : [];
  }

  /** #107: SQLite caps host parameters per statement (`SQLITE_MAX_VARIABLE_NUMBER`,
   *  default 999 in older builds, 32k in modern). 500 is a safe ceiling that
   *  also keeps each round-trip's payload reasonable. */
  private static readonly GET_BY_IDS_CHUNK_SIZE = 500;

  async getByIds(ids: string[]): Promise<MemoryRecord[]> {
    if (ids.length === 0) {
      return [];
    }

    type Row = { id: string; session_id: string; scope: MemoryRecord['scope']; scope_key?: string | null; summary: string; tags_json: string; created_at: string; metadata_json?: string };

    // #107: chunk to stay under SQLite's parameter limit. A single `IN (...)`
    // with 10k+ placeholders blows up at prepare time on real D1.
    const chunkSize = D1MemoryStore.GET_BY_IDS_CHUNK_SIZE;
    const byId = new Map<string, MemoryRecord>();

    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      const chunk = ids.slice(offset, offset + chunkSize);

      // Build positional placeholders (`?1, ?2, ...`) to match the rest of the
      // file's binding style and to keep the query safely parameterized — never
      // interpolate user-supplied ids directly into SQL.
      const placeholders = chunk.map((_, index) => `?${index + 1}`).join(', ');
      const statement = this.db
        .prepare(
          `SELECT id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json
           FROM memories
           WHERE id IN (${placeholders})`
        )
        .bind(...chunk);

      let rows: Row[] = [];

      if (statement.all) {
        const results = await statement.all<Row>();
        rows = results.results;
      } else if (statement.first) {
        // Fallback for D1-likes that only support `first` — best-effort, returns
        // at most one row. Real D1/SQLite always exposes `all`.
        const single = await statement.first<Row>();
        rows = single ? [single] : [];
      }

      for (const row of rows) {
        byId.set(row.id, this.mapRow(row));
      }
    }

    // Preserve caller-provided `ids` ordering so upstream ranked sequences
    // (e.g. embedding score order) survive the round-trip — `IN (...)` makes
    // no guarantee about result order across SQL engines, and chunked
    // queries lose order across chunks too.
    const out: MemoryRecord[] = [];
    for (const id of ids) {
      const record = byId.get(id);
      if (record) out.push(record);
    }
    return out;
  }
}

export class FileCheckpointStore implements CheckpointStore {
  private readonly baseDir: string;
  /** #112: directory holding `{checkpointId}.json` pointers to the owning
   *  sessionId. Underscore prefix avoids collision with any user-controlled
   *  sessionId (sessionIds are agent-generated, but defense-in-depth). */
  private static readonly INDEX_DIRNAME = '_index';

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.env.HOME ?? '/tmp', '.crowclaw', 'checkpoints');
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private filePath(sessionId: string, checkpointId: string): string {
    return join(this.sessionDir(sessionId), checkpointId + '.json');
  }

  /** #112: Path to the `checkpointId -> sessionId` pointer file. Reading it
   *  is O(1) regardless of how many session directories exist. */
  private indexPath(checkpointId: string): string {
    return join(this.baseDir, FileCheckpointStore.INDEX_DIRNAME, checkpointId + '.json');
  }

  async save(checkpoint: SessionCheckpoint): Promise<void> {
    const dir = this.sessionDir(checkpoint.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath(checkpoint.sessionId, checkpoint.id), JSON.stringify(checkpoint), 'utf-8');

    // #112: write a flat index entry so `get(id)` and `delete(id)` can locate
    // the owning session in one stat instead of scanning every session
    // directory. Failure to write the index is non-fatal — `get` falls back
    // to the legacy scan path so old data without an index still resolves.
    try {
      const indexDir = join(this.baseDir, FileCheckpointStore.INDEX_DIRNAME);
      await mkdir(indexDir, { recursive: true });
      await writeFile(this.indexPath(checkpoint.id), JSON.stringify({ sessionId: checkpoint.sessionId }), 'utf-8');
    } catch { /* index is best-effort; primary file is the source of truth */ }
  }

  async get(id: string): Promise<SessionCheckpoint | null> {
    // #112: O(1) fast path — look up the index entry, then read the
    // checkpoint file directly.
    try {
      const indexData = await readFile(this.indexPath(id), 'utf-8');
      const { sessionId } = JSON.parse(indexData) as { sessionId: string };
      try {
        const data = await readFile(this.filePath(sessionId, id), 'utf-8');
        return JSON.parse(data) as SessionCheckpoint;
      } catch {
        // Stale index pointer (file was deleted out-of-band). Fall through
        // to the scan path which will return null cleanly.
      }
    } catch { /* no index entry → fall through to legacy scan */ }

    // Backward-compat scan for checkpoints written before the index existed.
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === FileCheckpointStore.INDEX_DIRNAME) continue;
        try {
          const data = await readFile(this.filePath(entry.name, id), 'utf-8');
          return JSON.parse(data) as SessionCheckpoint;
        } catch { continue; }
      }
    } catch { /* baseDir doesn't exist */ }
    return null;
  }

  async listBySession(sessionId: string): Promise<SessionCheckpoint[]> {
    const dir = this.sessionDir(sessionId);
    try {
      const files = await readdir(dir);
      const checkpoints: SessionCheckpoint[] = [];
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const data = await readFile(join(dir, file), 'utf-8');
          checkpoints.push(JSON.parse(data) as SessionCheckpoint);
        } catch { continue; }
      }
      return checkpoints.sort((a, b) => a.iteration - b.iteration);
    } catch { return []; }
  }

  async getLatest(sessionId: string): Promise<SessionCheckpoint | null> {
    const checkpoints = await this.listBySession(sessionId);
    return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
  }

  async delete(id: string): Promise<boolean> {
    // #112: O(1) fast path via the index.
    let sessionId: string | undefined;
    try {
      const indexData = await readFile(this.indexPath(id), 'utf-8');
      sessionId = (JSON.parse(indexData) as { sessionId: string }).sessionId;
    } catch { /* no index entry → fall through to scan */ }

    if (sessionId) {
      try {
        await rm(this.filePath(sessionId, id));
        try { await unlink(this.indexPath(id)); } catch { /* best-effort */ }
        return true;
      } catch {
        // File already gone — clean up the dangling index entry and report
        // not-found so the caller's contract (boolean = was-removed) stays
        // honest.
        try { await unlink(this.indexPath(id)); } catch { /* best-effort */ }
        return false;
      }
    }

    // Backward-compat scan for entries written before the index existed.
    try {
      const entries = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === FileCheckpointStore.INDEX_DIRNAME) continue;
        try {
          await rm(this.filePath(entry.name, id));
          try { await unlink(this.indexPath(id)); } catch { /* best-effort */ }
          return true;
        } catch { continue; }
      }
    } catch { /* baseDir doesn't exist */ }
    return false;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const dir = this.sessionDir(sessionId);
    try {
      const files = await readdir(dir);
      const checkpointIds = files
        .filter((f: string) => f.endsWith('.json'))
        .map((f: string) => f.slice(0, -'.json'.length));
      await rm(dir, { recursive: true });
      // #112: clean up the flat index pointers for each removed checkpoint
      // so stale entries don't accumulate. Best-effort; missing entries are
      // expected for legacy data.
      await Promise.all(checkpointIds.map(async (cpId) => {
        try { await unlink(this.indexPath(cpId)); } catch { /* best-effort */ }
      }));
      return checkpointIds.length;
    } catch { return 0; }
  }
}

export const bootstrapSql = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  updated_at TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts USING fts5(
  session_id UNINDEXED,
  content
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  scope_key TEXT,
  summary TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  metadata_json TEXT
);
`;

export { InMemoryMessageStore, MESSAGE_STORE_SCHEMA, type StoredMessage, type MessageQuery, type MessageStats, type MessageStore } from './message-store.js';

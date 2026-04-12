import type { SessionState, SessionStore } from '@crowclaw/core';
import type { D1DatabaseLike, R2BucketLike } from '@crowclaw/shared';

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
}

function normalizeNeedle(query: string): string {
  return query.trim().toLowerCase();
}

function matchesScope(record: MemoryRecord, scope: MemoryRecord['scope'], scopeKey?: string): boolean {
  return record.scope === scope && (!scopeKey || record.scopeKey === scopeKey);
}

function matchesQuery(record: MemoryRecord, query: string): boolean {
  const needle = normalizeNeedle(query);
  if (!needle) {
    return true;
  }

  return record.summary.toLowerCase().includes(needle)
    || record.tags.some((tag) => tag.toLowerCase().includes(needle))
    || JSON.stringify(record.metadata ?? {}).toLowerCase().includes(needle);
}

function sortByNewest(records: MemoryRecord[]): MemoryRecord[] {
  return [...records].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
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
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly store = new Map<string, MemoryRecord[]>();

  async search(sessionId: string, query: string, limit = 10): Promise<MemoryRecord[]> {
    return sortByNewest(this.store.get(sessionId) ?? [])
      .filter((record) => matchesQuery(record, query))
      .slice(0, limit);
  }

  async searchByScope(scope: MemoryRecord['scope'], query: string, limit = 10, scopeKey?: string): Promise<MemoryRecord[]> {
    return sortByNewest([...this.store.values()].flat())
      .filter((record) => matchesScope(record, scope, scopeKey))
      .filter((record) => matchesQuery(record, query))
      .slice(0, limit);
  }

  async write(record: MemoryRecord): Promise<void> {
    const current = this.store.get(record.sessionId) ?? [];
    this.store.set(record.sessionId, [...current, record]);
  }

  async list(sessionId: string): Promise<MemoryRecord[]> {
    return sortByNewest(this.store.get(sessionId) ?? []);
  }

  async listByScope(scope: MemoryRecord['scope'], limit = 50, scopeKey?: string): Promise<MemoryRecord[]> {
    return sortByNewest([...this.store.values()].flat())
      .filter((record) => matchesScope(record, scope, scopeKey))
      .slice(0, limit);
  }
}

export class D1SessionStore implements SessionStore, SessionSearchStore, SessionListStore {
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
    const transcript = session.messages.map((message) => message.content).join('\n');
    await this.db
      .prepare('DELETE FROM sessions_fts WHERE session_id = ?1')
      .bind(session.sessionId)
      .run();
    await this.db
      .prepare(
        `INSERT INTO sessions_fts (session_id, content)
         VALUES (?1, ?2)`
      )
      .bind(session.sessionId, transcript)
      .run();
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
    await this.db
      .prepare(
        `INSERT INTO memories (id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
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
}

export class R2ArtifactStore {
  constructor(private readonly bucket: R2BucketLike) {}

  async putJson(key: string, value: unknown): Promise<void> {
    await this.bucket.put(key, JSON.stringify(value, null, 2), {
      httpMetadata: { contentType: 'application/json; charset=utf-8' }
    });
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

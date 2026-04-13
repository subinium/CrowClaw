import type { SessionState, SessionStore, CheckpointStore, SessionCheckpoint } from '@crowclaw/core';
import type { D1DatabaseLike } from '@crowclaw/shared';
import { mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

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

export class FileCheckpointStore implements CheckpointStore {
  private readonly baseDir: string;

  constructor(baseDir?: string) {
    this.baseDir = baseDir ?? join(process.env.HOME ?? '/tmp', '.crowclaw', 'checkpoints');
  }

  private sessionDir(sessionId: string): string {
    return join(this.baseDir, sessionId);
  }

  private filePath(sessionId: string, checkpointId: string): string {
    return join(this.sessionDir(sessionId), checkpointId + '.json');
  }

  async save(checkpoint: SessionCheckpoint): Promise<void> {
    const dir = this.sessionDir(checkpoint.sessionId);
    await mkdir(dir, { recursive: true });
    await writeFile(this.filePath(checkpoint.sessionId, checkpoint.id), JSON.stringify(checkpoint), 'utf-8');
  }

  async get(id: string): Promise<SessionCheckpoint | null> {
    try {
      const sessions = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
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
    try {
      const sessions = await readdir(this.baseDir, { withFileTypes: true });
      for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        try {
          await rm(this.filePath(entry.name, id));
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
      const count = files.filter((f: string) => f.endsWith('.json')).length;
      await rm(dir, { recursive: true });
      return count;
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

/**
 * #337 (v0.9.0 Hermes parity): FTS5 with `tokenize='trigram'` for CJK
 * (Chinese/Japanese/Korean) substring search.
 *
 * Acceptance criteria from the issue, all verified below:
 *   - Korean substring search returns matches via FTS5, not LIKE
 *   - Japanese / Chinese same
 *   - Migration runs once on upgrade, is idempotent
 *   - Benchmark: 1000-entry corpus, Korean query → < 100ms
 *
 * Uses Node's built-in `node:sqlite` (stable in Node 22+) so the test
 * exercises a real FTS5 trigram tokenizer instead of a fake.
 */

import { describe, expect, it, beforeAll } from 'vitest';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { bootstrapSql, runFts5TrigramMigration } from '@crowclaw/storage';
import { MESSAGE_STORE_SCHEMA } from '@crowclaw/storage';

// Adapt node:sqlite to the D1DatabaseLike interface our migration helper
// expects. Real D1 returns `{ results: T[] }`; node:sqlite returns plain
// arrays — this wrapper bridges the gap.
function wrapD1(db: DatabaseSync) {
  return {
    prepare(query: string) {
      let stmt: StatementSync;
      try {
        stmt = db.prepare(query);
      } catch (err) {
        // For DDL (DROP/CREATE), node:sqlite errors at prepare-time if the
        // table doesn't exist. Fall back to exec-style by capturing a
        // closure that calls db.exec on .run().
        return {
          bind: () => ({
            first: async <T>() => null as T | null,
            all: async <T>() => ({ results: [] as T[] }),
            run: async () => {
              try { db.exec(query); } catch { /* swallow */ }
            },
          }),
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => {
            try { db.exec(query); } catch { /* swallow */ }
          },
        };
      }

      const bound = (...values: unknown[]) => ({
        first: async <T>() => {
          const row = stmt.get(...values as unknown[]) as T | undefined;
          return row ?? null;
        },
        all: async <T>() => {
          const rows = stmt.all(...values as unknown[]) as T[];
          return { results: rows };
        },
        run: async () => {
          if (stmt.run) {
            return stmt.run(...values as unknown[]);
          }
          return null;
        },
      });

      return {
        bind: (...values: unknown[]) => bound(...values),
        first: async <T>() => {
          const row = stmt.get() as T | undefined;
          return row ?? null;
        },
        all: async <T>() => {
          const rows = stmt.all() as T[];
          return { results: rows };
        },
        run: async () => stmt.run?.(),
      };
    },
  };
}

describe('FTS5 trigram CJK search (#337)', () => {
  it('exposes tokenize=trigram in the bootstrap schema', () => {
    expect(bootstrapSql).toMatch(/sessions_fts.*tokenize='trigram'/s);
    expect(bootstrapSql).toMatch(/memories_fts.*tokenize='trigram'/s);
    expect(MESSAGE_STORE_SCHEMA).toMatch(/messages_fts.*tokenize='trigram'/s);
  });

  it('Korean substring search hits the FTS5 index', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(bootstrapSql);

    // No-space Korean strings — without trigram these are single tokens
    // and substring search degrades to a LIKE scan.
    const seed = [
      { id: 'm1', sessionId: 's1', summary: '서울에서만나는한국어교실', scope: 'session' },
      { id: 'm2', sessionId: 's1', summary: '오늘날씨가좋네요', scope: 'session' },
      { id: 'm3', sessionId: 's1', summary: '한국문화체험프로그램', scope: 'session' },
    ];
    for (const r of seed) {
      db.prepare('INSERT INTO memories_fts(memory_id, session_id, scope, summary) VALUES (?, ?, ?, ?)').run(r.id, r.sessionId, r.scope, r.summary);
    }

    // Substring queries must return matches via FTS5.
    const r1 = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '만나는'").all() as Array<{ memory_id: string }>;
    expect(r1.map((r) => r.memory_id)).toContain('m1');

    const r2 = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '한국문화'").all() as Array<{ memory_id: string }>;
    expect(r2.map((r) => r.memory_id)).toContain('m3');

    // Note: FTS5 trigram tokenizer requires queries of at least 3 chars
    // (one trigram). 2-char CJK queries (e.g. '날씨') will not match — that's
    // a documented limitation of the trigram tokenizer, not a bug. Use
    // '날씨가' (3 chars).
    const r3 = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '날씨가'").all() as Array<{ memory_id: string }>;
    expect(r3.map((r) => r.memory_id)).toContain('m2');
  });

  it('Japanese and Chinese substring search hit too', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(bootstrapSql);

    // All test needles are 3+ chars so they form at least one trigram.
    const samples = [
      ['ja1', 's1', 'session', '東京タワーから見える夜の景色'],
      ['ja2', 's1', 'session', 'ラーメンと餃子の名店'],
      ['zh1', 's2', 'session', '北京烤鴨真好吃'],
      ['zh2', 's2', 'session', '長城是世界遺產'],
    ] as const;
    for (const [id, sid, scope, summary] of samples) {
      db.prepare('INSERT INTO memories_fts(memory_id, session_id, scope, summary) VALUES (?, ?, ?, ?)').run(id, sid, scope, summary);
    }

    const ja = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '夜の景色'").all() as Array<{ memory_id: string }>;
    expect(ja.map((r) => r.memory_id)).toContain('ja1');

    const ja2 = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH 'ラーメン'").all() as Array<{ memory_id: string }>;
    expect(ja2.map((r) => r.memory_id)).toContain('ja2');

    const zh = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '京烤鴨'").all() as Array<{ memory_id: string }>;
    expect(zh.map((r) => r.memory_id)).toContain('zh1');

    const zh2 = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '世界遺產'").all() as Array<{ memory_id: string }>;
    expect(zh2.map((r) => r.memory_id)).toContain('zh2');
  });

  it('runFts5TrigramMigration migrates a legacy unicode61 FTS table', async () => {
    const db = new DatabaseSync(':memory:');
    // Simulate v0.8.x deployment: tables exist but FTS5 uses the default
    // tokenizer (which is unicode61, not trigram).
    db.exec(`
      CREATE TABLE sessions (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE VIRTUAL TABLE sessions_fts USING fts5(session_id UNINDEXED, content);
      CREATE TABLE memories (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, scope TEXT NOT NULL, scope_key TEXT, summary TEXT NOT NULL, tags_json TEXT NOT NULL, created_at TEXT NOT NULL, metadata_json TEXT);
      CREATE VIRTUAL TABLE memories_fts USING fts5(memory_id UNINDEXED, session_id UNINDEXED, scope UNINDEXED, summary);
    `);

    // Seed canonical rows so the rebuild step has something to index.
    db.prepare('INSERT INTO sessions(id, updated_at, payload) VALUES (?, ?, ?)').run(
      'sess1', '2025-01-01T00:00:00Z',
      JSON.stringify({ messages: [{ role: 'user', content: '한국어로검색해보자' }] }),
    );
    db.prepare('INSERT INTO memories(id, session_id, scope, scope_key, summary, tags_json, created_at, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      'mem1', 'sess1', 'session', null, '한국문화체험', '[]', '2025-01-01T00:00:00Z', null,
    );

    // Migration must drop+recreate with trigram and rebuild the indices.
    const results = await runFts5TrigramMigration(wrapD1(db));
    const sessionsResult = results.find((r) => r.table === 'sessions_fts');
    const memoriesResult = results.find((r) => r.table === 'memories_fts');
    expect(sessionsResult?.status).toBe('migrated');
    expect(memoriesResult?.status).toBe('migrated');
    expect(sessionsResult?.rowsIndexed).toBe(1);
    expect(memoriesResult?.rowsIndexed).toBe(1);

    // Post-migration: substring queries must hit.
    const memHits = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH '한국문화'").all() as Array<{ memory_id: string }>;
    expect(memHits.map((r) => r.memory_id)).toContain('mem1');

    const sessHits = db.prepare("SELECT session_id FROM sessions_fts WHERE sessions_fts MATCH '검색해'").all() as Array<{ session_id: string }>;
    expect(sessHits.map((r) => r.session_id)).toContain('sess1');
  });

  it('migration is idempotent — second run is a no-op', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec(bootstrapSql); // sessions_fts + memories_fts are trigram from boot
    db.exec(MESSAGE_STORE_SCHEMA); // messages_fts also trigram from boot

    // First run: every present FTS table reports `already-trigram`.
    const first = await runFts5TrigramMigration(wrapD1(db));
    const presentFirst = first.filter((r) => r.status !== 'absent');
    expect(presentFirst.length).toBeGreaterThan(0);
    expect(presentFirst.every((r) => r.status === 'already-trigram')).toBe(true);

    // Second run: idempotent — no table gets re-migrated.
    const second = await runFts5TrigramMigration(wrapD1(db));
    expect(second.filter((r) => r.status !== 'absent').every((r) => r.status === 'already-trigram')).toBe(true);
  });

  it('Korean query on 1000-entry corpus completes in < 100ms', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(bootstrapSql);

    // Build a 1000-entry corpus with assorted Korean text. A few specific
    // entries embed the query needle so we can verify the result count.
    const NEEDLE = '한국어교실';
    const needleCount = 7;
    const insertStmt = db.prepare('INSERT INTO memories_fts(memory_id, session_id, scope, summary) VALUES (?, ?, ?, ?)');
    db.exec('BEGIN');
    try {
      for (let i = 0; i < 1000; i += 1) {
        const includeNeedle = i < needleCount;
        const body = includeNeedle
          ? `오늘${NEEDLE}에서공부했어요${i}`
          : `랜덤한국어문장${i}입니다오늘날씨좋아요`;
        insertStmt.run(`m-${i}`, 's-corpus', 'session', body);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }

    const t0 = performance.now();
    const hits = db.prepare("SELECT memory_id FROM memories_fts WHERE memories_fts MATCH ?").all(NEEDLE) as Array<{ memory_id: string }>;
    const elapsed = performance.now() - t0;

    expect(hits.length).toBe(needleCount);
    expect(elapsed).toBeLessThan(100);
  });
});

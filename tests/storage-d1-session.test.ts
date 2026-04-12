import { describe, expect, it } from 'vitest';
import { D1SessionStore, type SessionSearchHit } from '@crowclaw/storage';
import type { SessionState } from '@crowclaw/core';
import type { D1DatabaseLike } from '@crowclaw/shared';

type SessionRow = { id: string; updated_at: string; payload: string };
type FtsRow = { session_id: string; content: string };

class FakeD1Database implements D1DatabaseLike {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly fts = new Map<string, FtsRow>();

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
    if (query.includes('INSERT INTO sessions (id, payload, updated_at)')) {
      const [id, payload, updatedAt] = values;
      this.sessions.set(String(id), {
        id: String(id),
        payload: String(payload),
        updated_at: String(updatedAt)
      });
      return;
    }

    if (query.includes('DELETE FROM sessions_fts')) {
      const [sessionId] = values;
      this.fts.delete(String(sessionId));
      return;
    }

    if (query.includes('INSERT INTO sessions_fts')) {
      const [sessionId, content] = values;
      this.fts.set(String(sessionId), {
        session_id: String(sessionId),
        content: String(content)
      });
    }
  }

  private runQuery(query: string, values: unknown[]): Array<Record<string, unknown>> {
    if (query.includes('SELECT payload FROM sessions WHERE id = ?1')) {
      const [sessionId] = values;
      const row = this.sessions.get(String(sessionId));
      return row ? [{ payload: row.payload }] : [];
    }

    if (query.includes('FROM sessions_fts')) {
      const [sessionId, needle, limit] = values;
      const row = this.fts.get(String(sessionId));
      if (!row) return [];
      const normalized = String(needle).toLowerCase();
      if (!row.content.toLowerCase().includes(normalized)) {
        return [];
      }
      return [{ session_id: row.session_id, content: row.content, rank: 0.01 }].slice(0, Number(limit));
    }

    return [];
  }
}

describe('D1SessionStore', () => {
  it('persists, reloads, and searches indexed transcript content', async () => {
    const db = new FakeD1Database();
    const store = new D1SessionStore(db);

    const session: SessionState = {
      agentId: 'crowclaw',
      sessionId: 'session-d1-1',
      messages: [
        { role: 'user', content: 'Need help deploying CrowClaw', createdAt: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'Let us inspect the runtime adapter.', createdAt: '2026-01-01T00:01:00.000Z' }
      ],
      updatedAt: '2026-01-01T00:02:00.000Z'
    };

    await store.put(session);

    const loaded = await store.get('session-d1-1');
    expect(loaded).toEqual(session);

    const hits = await store.search('session-d1-1', 'runtime', 10);
    expect(hits).toHaveLength(1);
    expect((hits[0] as SessionSearchHit).content).toContain('Need help deploying CrowClaw');
    expect((hits[0] as SessionSearchHit).content).toContain('Let us inspect the runtime adapter.');
  });
});

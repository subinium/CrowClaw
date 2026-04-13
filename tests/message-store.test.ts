import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryMessageStore } from '@crowclaw/storage';
import type { StoredMessage, MessageQuery } from '@crowclaw/storage';

function makeMessage(overrides: Partial<StoredMessage> & { id: string; sessionId: string }): StoredMessage {
  return {
    role: 'user',
    content: 'hello',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('InMemoryMessageStore', () => {
  let store: InMemoryMessageStore;

  beforeEach(() => {
    store = new InMemoryMessageStore();
  });

  it('append stores a message', async () => {
    const msg = makeMessage({ id: 'm1', sessionId: 's1', content: 'first' });
    await store.append(msg);
    const result = await store.getById('m1');
    expect(result).toEqual(msg);
  });

  it('appendBatch stores multiple messages', async () => {
    const messages = [
      makeMessage({ id: 'm1', sessionId: 's1', content: 'one' }),
      makeMessage({ id: 'm2', sessionId: 's1', content: 'two' }),
      makeMessage({ id: 'm3', sessionId: 's1', content: 'three' }),
    ];
    await store.appendBatch(messages);
    const results = await store.query({ sessionId: 's1' });
    expect(results).toHaveLength(3);
  });

  it('query with sessionId returns all session messages', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'a' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's2', content: 'b' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', content: 'c' }));

    const results = await store.query({ sessionId: 's1' });
    expect(results).toHaveLength(2);
    expect(results.map((m) => m.id)).toContain('m1');
    expect(results.map((m) => m.id)).toContain('m3');
  });

  it('query with role filter', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'question' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: 'answer' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', role: 'user', content: 'follow-up' }));

    const results = await store.query({ sessionId: 's1', role: 'assistant' });
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe('answer');
  });

  it('query with time range (after/before)', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', createdAt: '2026-01-02T00:00:00.000Z' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', createdAt: '2026-01-03T00:00:00.000Z' }));

    const afterResults = await store.query({
      sessionId: 's1',
      after: '2026-01-01T12:00:00.000Z',
    });
    expect(afterResults).toHaveLength(2);

    const beforeResults = await store.query({
      sessionId: 's1',
      before: '2026-01-02T12:00:00.000Z',
    });
    expect(beforeResults).toHaveLength(2);

    const rangeResults = await store.query({
      sessionId: 's1',
      after: '2026-01-01T12:00:00.000Z',
      before: '2026-01-02T12:00:00.000Z',
    });
    expect(rangeResults).toHaveLength(1);
    expect(rangeResults[0]!.id).toBe('m2');
  });

  it('query with limit and offset (pagination)', async () => {
    for (let i = 0; i < 10; i++) {
      await store.append(makeMessage({
        id: `m${i}`,
        sessionId: 's1',
        content: `msg-${i}`,
        createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      }));
    }

    const page1 = await store.query({ sessionId: 's1', limit: 3, offset: 0 });
    expect(page1).toHaveLength(3);
    expect(page1[0]!.content).toBe('msg-0');

    const page2 = await store.query({ sessionId: 's1', limit: 3, offset: 3 });
    expect(page2).toHaveLength(3);
    expect(page2[0]!.content).toBe('msg-3');

    const lastPage = await store.query({ sessionId: 's1', limit: 3, offset: 9 });
    expect(lastPage).toHaveLength(1);
  });

  it('query with search string', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'hello world' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', content: 'goodbye world' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', content: 'hello again' }));

    const results = await store.query({ sessionId: 's1', search: 'hello' });
    expect(results).toHaveLength(2);
  });

  it('getById returns correct message', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'target' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', content: 'other' }));

    const result = await store.getById('m1');
    expect(result).not.toBeNull();
    expect(result!.content).toBe('target');
  });

  it('getById returns null for unknown ID', async () => {
    const result = await store.getById('nonexistent');
    expect(result).toBeNull();
  });

  it('search finds messages by content substring', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'deploying to cloudflare workers' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', content: 'testing locally' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', content: 'cloudflare pages setup' }));

    const results = await store.search('s1', 'cloudflare');
    expect(results).toHaveLength(2);
    expect(results.every((m) => m.content.toLowerCase().includes('cloudflare'))).toBe(true);
  });

  it('searchAll searches across sessions', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'agent loop in session one' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's2', content: 'agent loop in session two' }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's3', content: 'unrelated content' }));

    const results = await store.searchAll('agent loop');
    expect(results).toHaveLength(2);
    expect(new Set(results.map((m) => m.sessionId))).toEqual(new Set(['s1', 's2']));
  });

  it('stats returns correct counts, tokens, cost, byRole breakdown', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', role: 'user', content: 'q1', tokens: 10, costUsd: 0.001 }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', role: 'assistant', content: 'a1', tokens: 50, costUsd: 0.005 }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', role: 'user', content: 'q2', tokens: 12, costUsd: 0.0012 }));
    await store.append(makeMessage({ id: 'm4', sessionId: 's1', role: 'tool', content: 'result', name: 'web.search', tokens: 5, costUsd: 0.0005 }));

    const result = await store.stats('s1');
    expect(result.sessionId).toBe('s1');
    expect(result.totalMessages).toBe(4);
    expect(result.totalTokens).toBe(77);
    expect(result.totalCostUsd).toBeCloseTo(0.0077, 4);
    expect(result.byRole).toEqual({ user: 2, assistant: 1, tool: 1 });
    expect(result.firstMessageAt).not.toBeNull();
    expect(result.lastMessageAt).not.toBeNull();
  });

  it('stats for empty session returns zeroes', async () => {
    const result = await store.stats('nonexistent');
    expect(result.totalMessages).toBe(0);
    expect(result.totalTokens).toBe(0);
    expect(result.totalCostUsd).toBe(0);
    expect(result.byRole).toEqual({});
    expect(result.firstMessageAt).toBeNull();
    expect(result.lastMessageAt).toBeNull();
  });

  it('deleteSession removes all messages and returns count', async () => {
    await store.appendBatch([
      makeMessage({ id: 'm1', sessionId: 's1', content: 'one' }),
      makeMessage({ id: 'm2', sessionId: 's1', content: 'two' }),
      makeMessage({ id: 'm3', sessionId: 's1', content: 'three' }),
    ]);

    const count = await store.deleteSession('s1');
    expect(count).toBe(3);

    const remaining = await store.query({ sessionId: 's1' });
    expect(remaining).toHaveLength(0);

    expect(await store.getById('m1')).toBeNull();
    expect(await store.getById('m2')).toBeNull();
  });

  it('deleteSession for unknown session returns 0', async () => {
    const count = await store.deleteSession('nonexistent');
    expect(count).toBe(0);
  });

  it('getLineage returns child messages of a compression', async () => {
    const compressionId = 'compression-1';
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'original' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', content: 'child of compression', parentId: compressionId }));
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', content: 'another child', parentId: compressionId }));
    await store.append(makeMessage({ id: 'm4', sessionId: 's1', content: 'unrelated' }));

    const lineage = await store.getLineage(compressionId);
    expect(lineage).toHaveLength(2);
    expect(lineage.every((m) => m.parentId === compressionId)).toBe(true);
  });

  it('messages are ordered by createdAt', async () => {
    await store.append(makeMessage({ id: 'm3', sessionId: 's1', createdAt: '2026-01-03T00:00:00.000Z' }));
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', createdAt: '2026-01-01T00:00:00.000Z' }));
    await store.append(makeMessage({ id: 'm2', sessionId: 's1', createdAt: '2026-01-02T00:00:00.000Z' }));

    const results = await store.query({ sessionId: 's1' });
    expect(results.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('metadata is preserved through round-trip', async () => {
    const meta = { model: 'opus-4', temperature: 0.7, tags: ['important', 'debug'] };
    await store.append(makeMessage({
      id: 'm1',
      sessionId: 's1',
      content: 'with metadata',
      metadata: meta,
    }));

    const result = await store.getById('m1');
    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual(meta);
  });

  it('large batch (100 messages) works correctly', async () => {
    const batch: StoredMessage[] = [];
    for (let i = 0; i < 100; i++) {
      batch.push(makeMessage({
        id: `m${i}`,
        sessionId: 's1',
        content: `message number ${i}`,
        createdAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`,
        tokens: i,
        costUsd: i * 0.001,
      }));
    }
    await store.appendBatch(batch);

    const all = await store.query({ sessionId: 's1' });
    expect(all).toHaveLength(100);

    const stats = await store.stats('s1');
    expect(stats.totalMessages).toBe(100);
    expect(stats.totalTokens).toBe(4950); // sum 0..99
    expect(stats.totalCostUsd).toBeCloseTo(4.95, 2);
  });

  it('search is case-insensitive', async () => {
    await store.append(makeMessage({ id: 'm1', sessionId: 's1', content: 'Cloudflare Workers' }));
    const results = await store.search('s1', 'cloudflare workers');
    expect(results).toHaveLength(1);
  });

  it('name field is preserved for tool messages', async () => {
    await store.append(makeMessage({
      id: 'm1',
      sessionId: 's1',
      role: 'tool',
      content: '{"result": "ok"}',
      name: 'web.search',
    }));

    const result = await store.getById('m1');
    expect(result!.name).toBe('web.search');
    expect(result!.role).toBe('tool');
  });
});

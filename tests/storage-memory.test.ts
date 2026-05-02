import { describe, expect, it } from 'vitest';
import { MemoryService } from '@crowclaw/memory';
import { InMemoryMemoryStore, InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createMemoryListTool, createMemoryRememberTool, createMemorySearchTool, createSessionSearchTool } from '@crowclaw/tools';

describe('storage and memory services', () => {
  it('captures and recalls memory summaries', async () => {
    const store = new InMemoryMemoryStore();
    const memory = new MemoryService(store);

    await memory.captureSessionSummary('session-a', [
      { role: 'user', content: 'Need help debugging Cloudflare sandbox routing', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'Let us inspect the runtime.', createdAt: new Date().toISOString() }
    ]);

    const recalled = await memory.recall('session-a', 'sandbox');
    expect(recalled).toHaveLength(1);
    expect(recalled[0]?.summary).toContain('Cloudflare sandbox routing');
  });


  it('keeps scope-keyed listing/search isolated and newest-first', async () => {
    const memories = new InMemoryMemoryStore();

    await memories.write({
      id: 'm1',
      sessionId: 'session-x',
      scope: 'workspace',
      scopeKey: 'workspace-a',
      summary: 'older workspace memory',
      tags: ['cloudflare'],
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    await memories.write({
      id: 'm2',
      sessionId: 'session-y',
      scope: 'workspace',
      scopeKey: 'workspace-b',
      summary: 'other workspace memory',
      tags: ['cloudflare'],
      createdAt: '2026-01-02T00:00:00.000Z'
    });
    await memories.write({
      id: 'm3',
      sessionId: 'session-z',
      scope: 'workspace',
      scopeKey: 'workspace-a',
      summary: 'newest workspace memory',
      tags: ['cloudflare'],
      createdAt: '2026-01-03T00:00:00.000Z',
      metadata: { owner: 'workspace-a' }
    });

    const scopedList = await memories.listByScope('workspace', 10, 'workspace-a');
    expect(scopedList.map((record) => record.id)).toEqual(['m3', 'm1']);

    const scopedSearch = await memories.searchByScope('workspace', 'owner', 10, 'workspace-a');
    expect(scopedSearch).toHaveLength(1);
    expect(scopedSearch[0]?.id).toBe('m3');
  });

  it('matches tokenized memory queries when contiguous substring search would miss', async () => {
    const memories = new InMemoryMemoryStore();
    await memories.write({
      id: 'migration',
      sessionId: 'session-token',
      scope: 'session',
      summary: 'database migration checklist for release',
      tags: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    const results = await memories.search('session-token', 'db migration', 5);
    expect(results.map((record) => record.id)).toEqual(['migration']);
  });

  it('exposes session and memory search as worker tools', async () => {
    const sessions = new InMemorySessionStore();
    await sessions.put({
      agentId: 'crowclaw',
      sessionId: 'session-b',
      messages: [
        { role: 'user', content: 'searchable transcript', createdAt: new Date().toISOString() }
      ],
      updatedAt: new Date().toISOString()
    });

    const memories = new InMemoryMemoryStore();
    const registry = new ToolRegistry()
      .register(createSessionSearchTool(sessions))
      .register(createMemoryRememberTool(memories))
      .register(createMemorySearchTool(memories))
      .register(createMemoryListTool(memories));

    const remember = await registry.execute('memory.remember', { summary: 'Persisted note about Cloudflare', tags: ['cloudflare'] }, {
      agentId: 'crowclaw',
      sessionId: 'session-b'
    });
    expect(remember.ok).toBe(true);

    await registry.execute('memory.remember', { summary: 'Workspace-scoped note', tags: ['cloudflare'], scope: 'workspace', scopeKey: 'workspace-a' }, {
      agentId: 'crowclaw',
      sessionId: 'session-b',
      workspaceId: 'workspace-a'
    });

    const recall = await registry.execute('memory.search', { query: 'cloudflare' }, {
      agentId: 'crowclaw',
      sessionId: 'session-b'
    });
    expect(recall.output).toContain('Persisted note');
    expect(recall.metadata).toMatchObject({ backend: 'substring' });

    const scopeRecall = await registry.execute('memory.search', { query: 'cloudflare', scope: 'workspace', scopeKey: 'workspace-a' }, {
      agentId: 'crowclaw',
      sessionId: 'session-b',
      workspaceId: 'workspace-a'
    });
    expect(scopeRecall.metadata).toMatchObject({ scope: 'workspace', scopeKey: 'workspace-a' });
    expect(scopeRecall.output).toContain('Workspace-scoped note');

    const list = await registry.execute('memory.list', {}, {
      agentId: 'crowclaw',
      sessionId: 'session-b'
    });
    expect(list.output).toContain('Persisted note');

    const scopedList = await registry.execute('memory.list', { scope: 'workspace', scopeKey: 'workspace-a' }, {
      agentId: 'crowclaw',
      sessionId: 'session-b',
      workspaceId: 'workspace-a'
    });
    expect(scopedList.output).toContain('Workspace-scoped note');

    const search = await registry.execute('session.search', { query: 'searchable' }, {
      agentId: 'crowclaw',
      sessionId: 'session-b'
    });
    expect(search.output).toContain('searchable transcript');
  });
});

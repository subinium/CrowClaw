import { describe, expect, it } from 'vitest';
import { MemoryService } from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';

describe('MemoryService', () => {
  it('captures and recalls session summaries', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.captureSessionSummary('session-1', [
      { role: 'user', content: 'Need help deploying crowclaw to cloudflare workers with sandbox', createdAt: new Date().toISOString() }
    ]);

    const results = await service.recall('session-1', 'cloudflare');
    expect(results).toHaveLength(1);
    expect(results[0]?.summary).toContain('cloudflare');
  });


  it('lists scoped memories with identity-aware filtering', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('session-1', 'user alpha note', ['pref'], undefined, 'user', 'user-alpha');
    await service.remember('session-2', 'user beta note', ['pref'], undefined, 'user', 'user-beta');

    const listed = await service.listByScope('user', 10, 'user-alpha');
    expect(listed).toHaveLength(1);
    expect(listed[0]?.scopeKey).toBe('user-alpha');
    expect(listed[0]?.summary).toContain('user alpha note');
  });

  it('captures scope-keyed summaries independently', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.captureScopedSummary('workspace', 'session-1', [
      { role: 'user', content: 'workspace alpha convention', createdAt: new Date().toISOString() }
    ], 'workspace-alpha');
    await service.captureScopedSummary('workspace', 'session-2', [
      { role: 'user', content: 'workspace beta convention', createdAt: new Date().toISOString() }
    ], 'workspace-beta');

    const results = await service.recallByScope('workspace', 'workspace', 10, 'workspace-alpha');
    expect(results).toHaveLength(1);
    expect(results[0]?.scopeKey).toBe('workspace-alpha');
    expect(results[0]?.summary).toContain('workspace alpha convention');
  });
});

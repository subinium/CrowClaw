import { describe, expect, it } from 'vitest';
import { MemoryService } from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';

describe('memory scope semantics', () => {
  it('captures and recalls workspace-scoped memory independently from session-scoped memory', async () => {
    const store = new InMemoryMemoryStore();
    const service = new MemoryService(store);

    await service.remember('session-a', 'Session detail about node runtime', ['node'], undefined, 'session');
    await service.remember('session-b', 'Workspace standard about cloudflare deployment', ['cloudflare'], undefined, 'workspace', 'workspace-a');
    await service.remember('session-c', 'Other workspace standard about cloudflare deployment', ['cloudflare'], undefined, 'workspace', 'workspace-b');

    const sessionResults = await service.recallByScope('session', 'node');
    const workspaceResults = await service.recallByScope('workspace', 'cloudflare', 10, 'workspace-a');

    expect(sessionResults).toHaveLength(1);
    expect(sessionResults[0]?.scope).toBe('session');
    expect(workspaceResults).toHaveLength(1);
    expect(workspaceResults[0]?.scope).toBe('workspace');
    expect(workspaceResults[0]?.scopeKey).toBe('workspace-a');
  });
});

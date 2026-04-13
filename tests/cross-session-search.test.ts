import { describe, expect, it } from 'vitest';
import { InMemorySessionStore, InMemoryMemoryStore } from '@crowclaw/storage';
import { MemoryService } from '@crowclaw/memory';
import type { SessionState } from '@crowclaw/core';

function makeSession(id: string, messages: Array<{ role: string; content: string }>): SessionState {
  return {
    agentId: 'test-agent',
    sessionId: id,
    messages: messages.map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
      createdAt: new Date().toISOString()
    })),
    updatedAt: new Date().toISOString()
  };
}

describe('Cross-session search', () => {
  describe('InMemorySessionStore.searchAll', () => {
    it('finds messages across multiple sessions', async () => {
      const store = new InMemorySessionStore();

      await store.put(makeSession('s1', [
        { role: 'user', content: 'How do I deploy to kubernetes?' },
        { role: 'assistant', content: 'Use kubectl apply to deploy your manifests.' }
      ]));
      await store.put(makeSession('s2', [
        { role: 'user', content: 'Tell me about docker containers.' },
        { role: 'assistant', content: 'Docker is a containerization platform.' }
      ]));
      await store.put(makeSession('s3', [
        { role: 'user', content: 'How to deploy docker images to production?' },
        { role: 'assistant', content: 'Build the image, push to registry, then deploy.' }
      ]));

      const results = await store.searchAll('deploy');
      expect(results.length).toBe(2);

      const sessionIds = results.map((r) => r.sessionId);
      expect(sessionIds).toContain('s1');
      expect(sessionIds).toContain('s3');
      // s2 should not appear — no mention of "deploy"
      expect(sessionIds).not.toContain('s2');
    });

    it('scores by keyword overlap and sorts by best score', async () => {
      const store = new InMemorySessionStore();

      await store.put(makeSession('low', [
        { role: 'user', content: 'I need help with kubernetes.' }
      ]));
      await store.put(makeSession('high', [
        { role: 'user', content: 'Deploy kubernetes pods using kubectl.' }
      ]));

      // "deploy kubernetes" has 2 terms: session "high" matches both, "low" matches one
      const results = await store.searchAll('deploy kubernetes');
      expect(results.length).toBe(2);
      expect(results[0]?.sessionId).toBe('high');
      expect(results[0]?.matches[0]?.score).toBe(2);
      expect(results[1]?.sessionId).toBe('low');
      expect(results[1]?.matches[0]?.score).toBe(1);
    });

    it('returns empty array for empty query', async () => {
      const store = new InMemorySessionStore();
      await store.put(makeSession('s1', [
        { role: 'user', content: 'some content' }
      ]));

      const results = await store.searchAll('');
      expect(results).toEqual([]);
    });

    it('returns empty array when no sessions match', async () => {
      const store = new InMemorySessionStore();
      await store.put(makeSession('s1', [
        { role: 'user', content: 'hello world' }
      ]));

      const results = await store.searchAll('nonexistent-term');
      expect(results).toEqual([]);
    });

    it('respects limit parameter', async () => {
      const store = new InMemorySessionStore();
      for (let i = 0; i < 5; i++) {
        await store.put(makeSession(`s${i}`, [
          { role: 'user', content: `Session ${i} mentions deploy` }
        ]));
      }

      const results = await store.searchAll('deploy', 2);
      expect(results.length).toBe(2);
    });
  });

  describe('MemoryService.crossSessionRecall', () => {
    it('combines session store and memory store results', async () => {
      const sessionStore = new InMemorySessionStore();
      const memoryStore = new InMemoryMemoryStore();
      const service = new MemoryService(memoryStore, sessionStore);

      await sessionStore.put(makeSession('s1', [
        { role: 'user', content: 'Setting up cloudflare workers for production deploy' }
      ]));
      await sessionStore.put(makeSession('s2', [
        { role: 'user', content: 'React component testing patterns' }
      ]));
      await sessionStore.put(makeSession('s3', [
        { role: 'user', content: 'Cloudflare pages deployment guide' }
      ]));

      // Also add a memory record for s2 that mentions cloudflare
      await service.remember('s2', 'Discussed cloudflare DNS configuration', ['cloudflare', 'dns']);

      const results = await service.crossSessionRecall('cloudflare');
      expect(results.length).toBeGreaterThanOrEqual(2);

      const sessionIds = results.map((r) => r.sessionId);
      expect(sessionIds).toContain('s1');
      expect(sessionIds).toContain('s3');
    });

    it('boosts relevance when both stores match same session', async () => {
      const sessionStore = new InMemorySessionStore();
      const memoryStore = new InMemoryMemoryStore();
      const service = new MemoryService(memoryStore, sessionStore);

      // s1 has matching messages AND a matching memory record
      await sessionStore.put(makeSession('s1', [
        { role: 'user', content: 'Deploy to kubernetes cluster' }
      ]));
      await service.captureSessionSummary('s1', [
        { role: 'user', content: 'Deploy to kubernetes cluster', createdAt: new Date().toISOString() }
      ]);

      // s2 only has matching messages
      await sessionStore.put(makeSession('s2', [
        { role: 'user', content: 'Kubernetes networking setup' }
      ]));

      const results = await service.crossSessionRecall('kubernetes');
      expect(results.length).toBe(2);
      // s1 should rank higher because it matches in both stores
      expect(results[0]?.sessionId).toBe('s1');
      expect(results[0]?.relevance).toBeGreaterThan(results[1]?.relevance ?? 0);
    });

    it('returns results sorted by relevance descending', async () => {
      const sessionStore = new InMemorySessionStore();
      const memoryStore = new InMemoryMemoryStore();
      const service = new MemoryService(memoryStore, sessionStore);

      await sessionStore.put(makeSession('low-match', [
        { role: 'user', content: 'Some deploy question' }
      ]));
      await sessionStore.put(makeSession('high-match', [
        { role: 'user', content: 'Deploy docker containers to kubernetes cluster' }
      ]));

      const results = await service.crossSessionRecall('deploy docker kubernetes');
      expect(results.length).toBe(2);
      // high-match has 3 keyword hits, low-match has 1
      expect(results[0]?.sessionId).toBe('high-match');
      expect(results[1]?.sessionId).toBe('low-match');
    });

    it('returns empty when no stores are configured', async () => {
      const service = new MemoryService();
      const results = await service.crossSessionRecall('anything');
      expect(results).toEqual([]);
    });

    it('works with only session store (no memory store)', async () => {
      const sessionStore = new InMemorySessionStore();
      const service = new MemoryService(undefined, sessionStore);

      await sessionStore.put(makeSession('s1', [
        { role: 'user', content: 'Hello world deploy test' }
      ]));

      const results = await service.crossSessionRecall('deploy');
      expect(results.length).toBe(1);
      expect(results[0]?.sessionId).toBe('s1');
    });

    it('respects limit parameter', async () => {
      const sessionStore = new InMemorySessionStore();
      const service = new MemoryService(undefined, sessionStore);

      for (let i = 0; i < 10; i++) {
        await sessionStore.put(makeSession(`s${i}`, [
          { role: 'user', content: `Session ${i} deploy topic` }
        ]));
      }

      const results = await service.crossSessionRecall('deploy', 3);
      expect(results.length).toBe(3);
    });
  });
});

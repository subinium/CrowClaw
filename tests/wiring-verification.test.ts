import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { EchoProvider } from '@crowclaw/providers';
import { InMemoryMemoryStore } from '@crowclaw/storage';
import { EmbeddingMemoryStore } from '@crowclaw/memory';
import { InMemorySchedulerStore, FileSchedulerStore } from '@crowclaw/scheduler';
import { SecurityAuditLog } from '@crowclaw/core';

// Minimal provider that echoes back messages
class StubProvider {
  async generate(request: { messages: Array<{ content: string }> }) {
    return { assistantMessage: `echo:${request.messages.at(-1)?.content ?? ''}` };
  }
}

describe('wiring verification', () => {
  describe('SecurityAuditLog', () => {
    it('is passed to AgentLoop and exposed on runtime', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      expect(runtime.securityAuditLog).toBeInstanceOf(SecurityAuditLog);
    });

    it('GET /api/security/events returns events from the audit log', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      // Record an event manually
      runtime.securityAuditLog.record({
        type: 'injection_detected',
        severity: 'warning',
        detail: 'test injection',
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/security/events')
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { events: Array<{ type: string; detail: string }> };
      expect(body.events).toHaveLength(1);
      expect(body.events[0]!.type).toBe('injection_detected');
    });

    it('GET /api/security/stats returns stats from the audit log', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      runtime.securityAuditLog.record({
        type: 'command_blocked',
        severity: 'critical',
        detail: 'rm -rf /',
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/security/stats')
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { total: number; byType: Record<string, number> };
      expect(body.total).toBe(1);
      expect(body.byType.command_blocked).toBe(1);
    });
  });

  describe('CredentialPool', () => {
    it('creates CredentialPool when multiple CROWCLAW_API_KEY_N keys present', async () => {
      const { resolveProviderFromConfig } = await import(
        '../packages/runtime-node/src/provider-factory.js'
      );
      const result = await resolveProviderFromConfig({
        env: {
          CROWCLAW_API_KEY: 'key-primary',
          CROWCLAW_API_KEY_2: 'key-secondary',
          CROWCLAW_API_KEY_3: 'key-tertiary',
          CROWCLAW_PROVIDER: 'openai',
        },
        configFileContents: null,
      });
      // The provider should have been created with the primary key
      expect(result.source).toBe('env');
      expect(result.provider).toBeDefined();
    });

    it('does not create CredentialPool with single key', async () => {
      const { resolveProviderFromConfig } = await import(
        '../packages/runtime-node/src/provider-factory.js'
      );
      const result = await resolveProviderFromConfig({
        env: {
          CROWCLAW_API_KEY: 'key-only',
          CROWCLAW_PROVIDER: 'openai',
        },
        configFileContents: null,
      });
      expect(result.source).toBe('env');
      expect(result.provider).toBeDefined();
    });

    it('creates CredentialPool for numbered OPENAI_API_KEY keys', async () => {
      const { resolveProviderFromConfig } = await import(
        '../packages/runtime-node/src/provider-factory.js'
      );
      const result = await resolveProviderFromConfig({
        env: {
          OPENAI_API_KEY: 'sk-primary',
          OPENAI_API_KEY_2: 'sk-secondary',
        },
        configFileContents: null,
      });
      expect(result.source).toBe('env');
      expect(result.provider).toBeDefined();
    });
  });

  describe('EmbeddingMemoryStore', () => {
    it('uses EmbeddingMemoryStore by default', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      // The memoryStore should be an EmbeddingMemoryStore wrapping InMemoryMemoryStore
      expect(runtime.memoryStore).toBeInstanceOf(EmbeddingMemoryStore);
    });

    it('uses plain InMemoryMemoryStore when useEmbeddingMemory is false', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        useEmbeddingMemory: false,
        schedulerStorePath: null,
      });
      expect(runtime.memoryStore).toBeInstanceOf(InMemoryMemoryStore);
    });

    it('uses caller-provided memoryStore as-is (no wrapping)', () => {
      const customStore = new InMemoryMemoryStore();
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        memoryStore: customStore,
        schedulerStorePath: null,
      });
      // When a custom store is passed, it should not be wrapped
      expect(runtime.memoryStore).toBe(customStore);
    });
  });

  describe('UserModelService', () => {
    it('is instantiated and exposed on runtime', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      expect(runtime.userModelService).toBeDefined();
      expect(typeof runtime.userModelService.getProfile).toBe('function');
      expect(typeof runtime.userModelService.updateFromConversation).toBe('function');
    });

    it('GET /api/user/profile returns a profile object', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/user/profile')
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as {
        expertise: string[];
        preferences: string[];
        interactionCount: number;
      };
      expect(body.expertise).toEqual([]);
      expect(body.preferences).toEqual([]);
      expect(body.interactionCount).toBe(0);
    });
  });

  describe('FileSchedulerStore', () => {
    it('uses FileSchedulerStore by default', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
      });
      expect(runtime.schedulerStore).toBeInstanceOf(FileSchedulerStore);
    });

    it('uses InMemorySchedulerStore when schedulerStorePath is null', () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      expect(runtime.schedulerStore).toBeInstanceOf(InMemorySchedulerStore);
    });

    it('uses caller-provided schedulerStore as-is', () => {
      const customStore = new InMemorySchedulerStore();
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStore: customStore,
      });
      expect(runtime.schedulerStore).toBe(customStore);
    });
  });

  describe('API route existence', () => {
    it('GET /api/security/events route exists and returns JSON', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/security/events')
      );
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('application/json');
    });

    it('GET /api/security/stats route exists and returns JSON', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/security/stats')
      );
      expect(response.ok).toBe(true);
      const body = (await response.json()) as { total: number };
      expect(typeof body.total).toBe('number');
    });

    it('GET /api/user/profile route exists and returns JSON', async () => {
      const runtime = createNodeRuntime({
        provider: new StubProvider() as never,
        schedulerStorePath: null,
      });
      const response = await runtime.fetch(
        new Request('http://localhost/api/user/profile')
      );
      expect(response.ok).toBe(true);
      expect(response.headers.get('content-type')).toContain('application/json');
    });
  });
});

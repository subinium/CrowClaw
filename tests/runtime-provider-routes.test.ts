import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

describe('runtime provider routes', () => {
  it('lists known model metadata and routes provider selection hints', async () => {
    const runtime = createNodeRuntime();

    const models = await runtime.fetch(new Request(localRoute(routePaths.providers.models)));
    const modelsPayload = await models.json() as { count: number; models: Array<{ id: string }> };
    expect(modelsPayload.count).toBeGreaterThan(0);
    expect(modelsPayload.models.some((model) => model.id === 'gpt-4o')).toBe(true);

    const simple = await runtime.fetch(new Request(localRoute(routePaths.providers.route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello there', hasTools: false })
    }));
    expect(await simple.json()).toMatchObject({
      complexity: 'simple',
      selectedTier: 'cheap',
      fallbackTier: 'primary'
    });

    const complex = await runtime.fetch(new Request(localRoute(routePaths.providers.route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'please debug and refactor this module', hasTools: true })
    }));
    expect(await complex.json()).toMatchObject({
      complexity: 'complex',
      selectedTier: 'primary',
      hasTools: true,
      fallbackTier: 'cheap',
      requiredCapabilities: expect.arrayContaining(['tools', 'reasoning']),
      recommendedModels: expect.arrayContaining([
        expect.objectContaining({ id: expect.any(String), rationale: expect.any(String) })
      ]),
      signals: expect.arrayContaining([expect.stringContaining('keyword:debug')])
    });
  });

  it('summarizes configured credential pool state for a provider', async () => {
    const prevPrimary = process.env.OPENAI_API_KEY;
    const prevSecondary = process.env.OPENAI_API_KEY_2;
    process.env.OPENAI_API_KEY = 'sk-openai-primary-1234';
    process.env.OPENAI_API_KEY_2 = 'sk-openai-secondary-5678';
    try {
      const runtime = createNodeRuntime();
      const response = await runtime.fetch(new Request(`${localRoute(routePaths.providers.pool)}?provider=openai`));
      const payload = await response.json() as {
        provider: string;
        configured: boolean;
        total: number;
        active: number;
        status: Array<{ key: string }>;
      };
      expect(payload).toMatchObject({
        provider: 'openai',
        configured: true,
        total: 2,
        active: 2
      });
      expect(payload.status[0]?.key).toContain('1234');
    } finally {
      if (prevPrimary === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = prevPrimary;
      if (prevSecondary === undefined) delete process.env.OPENAI_API_KEY_2;
      else process.env.OPENAI_API_KEY_2 = prevSecondary;
    }
  });

  it('shows effective provider slot/failover plan', async () => {
    const runtime = createNodeRuntime({
      configStorePath: null,
      initialProviderConfig: {
        primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o' },
        fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-haiku-4' },
        compression: { name: 'Compression', provider: 'openai', model: 'gpt-4o-mini' }
      }
    });

    const response = await runtime.fetch(new Request(localRoute(routePaths.providers.plan)));
    const payload = await response.json() as {
      configured: boolean;
      slots: { primary: { provider: string }; fallback: { provider: string } | null; compression: { provider: string } | null } | null;
      executionPlan: { primary: string; fallbackChain: string[]; usesCompressionProvider: boolean };
    };

    expect(payload.configured).toBe(true);
    expect(payload.executionPlan).toBeDefined();
    expect(payload.slots?.primary.provider).toBe('openai');
    expect(payload.slots?.fallback?.provider).toBe('anthropic');
    expect(payload.executionPlan.fallbackChain).toContain('anthropic');
    expect(payload.executionPlan.usesCompressionProvider).toBe(true);
  });

  it('shows a simulated provider failover chain preview', async () => {
    const runtime = createNodeRuntime({
      configStorePath: null,
      initialProviderConfig: {
        primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o' },
        fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-haiku-4' }
      }
    });

    const response = await runtime.fetch(new Request(localRoute(routePaths.providers.failoverPreview)));
    const payload = await response.json() as {
      configured: boolean;
      chain: Array<{ slot: string; provider: string; model: string }>;
      simulation: Array<{ attempt: number; slot: string; reason: string }>;
      notes: string[];
    };

    expect(payload.configured).toBe(true);
    expect(payload.chain).toEqual([
      { slot: 'primary', provider: 'openai', model: 'gpt-4o' },
      { slot: 'fallback', provider: 'anthropic', model: 'claude-haiku-4' }
    ]);
    expect(payload.simulation[1]).toMatchObject({ attempt: 2, slot: 'fallback', reason: 'fallback-attempt' });
    expect(payload.notes[0]).toContain('Preview only');
  });
});

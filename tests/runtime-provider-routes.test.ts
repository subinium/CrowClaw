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
});

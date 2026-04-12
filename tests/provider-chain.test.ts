import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@crowclaw/core';
import { ProviderChain } from '../packages/providers/src/index.js';

const request: ProviderRequest = {
  messages: [{ role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  availableTools: []
};

class FailingProvider implements ProviderAdapter {
  constructor(private readonly message: string) {}
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error(this.message);
  }
}

class StaticProvider implements ProviderAdapter {
  constructor(private readonly text: string) {}
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return { assistantMessage: this.text };
  }
}

describe('ProviderChain', () => {
  it('falls back to the next provider when an earlier provider fails', async () => {
    const chain = new ProviderChain({
      providers: [new FailingProvider('primary failed'), new StaticProvider('secondary works')]
    });

    const result = await chain.generate(request);
    expect(result.assistantMessage).toBe('secondary works');
  });

  it('can stop fallback when shouldFallbackOnError returns false', async () => {
    const chain = new ProviderChain({
      providers: [new FailingProvider('do not retry'), new StaticProvider('unused')],
      shouldFallbackOnError: () => false
    });

    await expect(chain.generate(request)).rejects.toThrow('do not retry');
  });
});

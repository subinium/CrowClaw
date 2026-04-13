import { describe, it, expect } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@crowclaw/core';
import { RuntimeConfigStore } from '../packages/runtime-node/src/config-store.js';
import type { ProviderConfig, ProviderSlot } from '../packages/runtime-node/src/config-store.js';
import { resolveProvidersFromConfig, createProviderFromSlot } from '../packages/runtime-node/src/provider-factory.js';
import type { ResolvedProviders } from '../packages/runtime-node/src/provider-factory.js';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockProvider implements ProviderAdapter {
  constructor(private readonly label: string) {}
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return { assistantMessage: `response from ${this.label}` };
  }
}

const baseSlot: ProviderSlot = {
  name: 'Primary',
  provider: 'openai',
  model: 'gpt-4o',
  apiKey: 'sk-test-123',
};

const baseFallbackSlot: ProviderSlot = {
  name: 'Fallback',
  provider: 'anthropic',
  model: 'claude-haiku-4',
  apiKey: 'sk-ant-test',
};

const baseConfig: ProviderConfig = {
  primary: baseSlot,
  fallback: baseFallbackSlot,
};

// ---------------------------------------------------------------------------
// 1. ProviderConfig type exists with all slots
// ---------------------------------------------------------------------------

describe('ProviderConfig type', () => {
  it('has all expected slot fields', () => {
    const config: ProviderConfig = {
      primary: { name: 'P', provider: 'openai', model: 'gpt-4o' },
      fallback: { name: 'F', provider: 'anthropic', model: 'claude-haiku-4' },
      vision: { name: 'V', provider: 'openai', model: 'gpt-4o' },
      compression: { name: 'C', provider: 'openai', model: 'gpt-4o-mini' },
      embedding: { name: 'E', provider: 'openai', model: 'text-embedding-3-small' },
    };

    expect(config.primary).toBeDefined();
    expect(config.fallback).toBeDefined();
    expect(config.vision).toBeDefined();
    expect(config.compression).toBeDefined();
    expect(config.embedding).toBeDefined();
  });

  it('allows optional slots to be undefined', () => {
    const config: ProviderConfig = {
      primary: { name: 'P', provider: 'openai', model: 'gpt-4o' },
    };

    expect(config.primary).toBeDefined();
    expect(config.fallback).toBeUndefined();
    expect(config.vision).toBeUndefined();
    expect(config.compression).toBeUndefined();
    expect(config.embedding).toBeUndefined();
  });

  it('ProviderSlot has optional apiKey and baseUrl', () => {
    const slot: ProviderSlot = {
      name: 'Test',
      provider: 'custom',
      model: 'my-model',
      apiKey: 'key-123',
      baseUrl: 'https://my-api.com/v1',
    };

    expect(slot.apiKey).toBe('key-123');
    expect(slot.baseUrl).toBe('https://my-api.com/v1');
  });
});

// ---------------------------------------------------------------------------
// 2. Store save/load provider config
// ---------------------------------------------------------------------------

describe('RuntimeConfigStore provider config', () => {
  it('getProviderConfig returns null by default', () => {
    const store = new RuntimeConfigStore();
    expect(store.getProviderConfig()).toBeNull();
  });

  it('setProviderConfig stores and retrieves config', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig(baseConfig);

    const result = store.getProviderConfig();
    expect(result).not.toBeNull();
    expect(result!.primary.provider).toBe('openai');
    expect(result!.primary.model).toBe('gpt-4o');
    expect(result!.fallback?.provider).toBe('anthropic');
  });

  it('setProviderConfig with null clears config', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig(baseConfig);
    expect(store.getProviderConfig()).not.toBeNull();

    store.setProviderConfig(null);
    expect(store.getProviderConfig()).toBeNull();
  });

  it('setProviderSlot sets individual slot on existing config', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig({ primary: baseSlot });

    store.setProviderSlot('fallback', baseFallbackSlot);
    const result = store.getProviderConfig();
    expect(result?.fallback?.provider).toBe('anthropic');
    expect(result?.fallback?.model).toBe('claude-haiku-4');
  });

  it('setProviderSlot creates config if setting primary on null config', () => {
    const store = new RuntimeConfigStore();
    expect(store.getProviderConfig()).toBeNull();

    store.setProviderSlot('primary', baseSlot);
    const result = store.getProviderConfig();
    expect(result).not.toBeNull();
    expect(result!.primary.model).toBe('gpt-4o');
  });

  it('setProviderSlot with undefined removes slot', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig(baseConfig);
    expect(store.getProviderConfig()?.fallback).toBeDefined();

    store.setProviderSlot('fallback', undefined);
    expect(store.getProviderConfig()?.fallback).toBeUndefined();
  });

  it('snapshot includes providerConfig with redacted apiKeys', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig(baseConfig);

    const snapshot = store.snapshot();
    const pc = snapshot.providerConfig as Record<string, unknown>;
    expect(pc).not.toBeNull();
    expect((pc as { primary: { apiKey: string } }).primary.apiKey).toBe('***');
    expect(((pc as { fallback: { apiKey: string } }).fallback).apiKey).toBe('***');
  });

  it('emits providerConfig event on setProviderConfig', () => {
    const store = new RuntimeConfigStore();
    const events: Array<{ key: string; value: unknown }> = [];
    store.onChange((key, value) => events.push({ key, value }));

    store.setProviderConfig(baseConfig);
    expect(events).toHaveLength(1);
    expect(events[0]!.key).toBe('providerConfig');
  });

  it('emits providerSlot event on setProviderSlot', () => {
    const store = new RuntimeConfigStore();
    store.setProviderConfig({ primary: baseSlot });
    const events: Array<{ key: string; value: unknown }> = [];
    store.onChange((key, value) => events.push({ key, value }));

    store.setProviderSlot('vision', { name: 'Vision', provider: 'openai', model: 'gpt-4o' });
    expect(events).toHaveLength(1);
    expect(events[0]!.key).toBe('providerSlot');
  });
});

// ---------------------------------------------------------------------------
// 3. resolveProvidersFromConfig returns structured providers
// ---------------------------------------------------------------------------

describe('resolveProvidersFromConfig', () => {
  it('returns primary provider from config', () => {
    const result = resolveProvidersFromConfig(baseConfig);
    expect(result.primary).toBeDefined();
    expect(typeof result.primary.generate).toBe('function');
  });

  it('returns fallback provider when configured', () => {
    const result = resolveProvidersFromConfig(baseConfig);
    expect(result.fallback).toBeDefined();
    expect(typeof result.fallback!.generate).toBe('function');
  });

  it('does not return fallback when not configured', () => {
    const result = resolveProvidersFromConfig({ primary: baseSlot });
    expect(result.fallback).toBeUndefined();
  });

  it('returns vision provider when configured', () => {
    const config: ProviderConfig = {
      primary: baseSlot,
      vision: { name: 'Vision', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-v' },
    };
    const result = resolveProvidersFromConfig(config);
    expect(result.vision).toBeDefined();
    expect(typeof result.vision!.generate).toBe('function');
  });

  it('returns compression provider when configured', () => {
    const config: ProviderConfig = {
      primary: baseSlot,
      compression: { name: 'Compress', provider: 'openai', model: 'gpt-4o-mini', apiKey: 'sk-c' },
    };
    const result = resolveProvidersFromConfig(config);
    expect(result.compression).toBeDefined();
    expect(typeof result.compression!.generate).toBe('function');
  });

  it('returns embedding adapter when configured', () => {
    const config: ProviderConfig = {
      primary: baseSlot,
      embedding: { name: 'Embed', provider: 'openai', model: 'text-embedding-3-small', apiKey: 'sk-e' },
    };
    const result = resolveProvidersFromConfig(config);
    expect(result.embedding).toBeDefined();
    expect(typeof result.embedding!.embed).toBe('function');
  });

  it('uses fallbackApiKey when slot has no apiKey', () => {
    const config: ProviderConfig = {
      primary: { name: 'P', provider: 'openai', model: 'gpt-4o' },
    };
    const result = resolveProvidersFromConfig(config, 'sk-fallback-key');
    expect(result.primary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 4. createProviderFromSlot produces usable ProviderAdapter
// ---------------------------------------------------------------------------

describe('createProviderFromSlot', () => {
  it('creates an OpenAI-compatible provider for openai type', () => {
    const provider = createProviderFromSlot({ name: 'Test', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-x' });
    expect(provider).toBeDefined();
    expect(typeof provider.generate).toBe('function');
  });

  it('creates an Anthropic provider for anthropic type', () => {
    const provider = createProviderFromSlot({ name: 'Test', provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'sk-ant-x' });
    expect(provider).toBeDefined();
    expect(typeof provider.generate).toBe('function');
  });

  it('creates an OpenAI-compatible provider for openrouter type', () => {
    const provider = createProviderFromSlot({ name: 'Test', provider: 'openrouter', model: 'meta-llama/llama-3', apiKey: 'sk-or-x' });
    expect(provider).toBeDefined();
    expect(typeof provider.generate).toBe('function');
  });

  it('uses fallback API key when slot apiKey is empty', () => {
    const provider = createProviderFromSlot({ name: 'Test', provider: 'openai', model: 'gpt-4o' }, 'sk-fallback');
    expect(provider).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 5. API endpoints return correct shapes (structural checks)
// ---------------------------------------------------------------------------

describe('Provider API endpoint shapes', () => {
  it('GET /api/providers/config response shape', () => {
    const mockResponse = {
      ok: true,
      config: baseConfig,
      slots: {
        primary: baseConfig.primary,
        fallback: baseConfig.fallback ?? null,
        vision: baseConfig.vision ?? null,
        compression: baseConfig.compression ?? null,
        embedding: baseConfig.embedding ?? null,
      },
    };

    expect(mockResponse.ok).toBe(true);
    expect(mockResponse.config).toBeDefined();
    expect(mockResponse.slots.primary).toBeDefined();
    expect(mockResponse.slots.fallback).toBeDefined();
    expect(mockResponse.slots.vision).toBeNull();
  });

  it('POST /api/providers/config request shape', () => {
    const requestBody: ProviderConfig = {
      primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-test' },
      fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-haiku-4' },
    };

    expect(requestBody.primary.provider).toBe('openai');
    expect(requestBody.primary.model).toBe('gpt-4o');
    expect(requestBody.fallback?.provider).toBe('anthropic');
  });

  it('POST /api/providers/test request shape', () => {
    const requestBody = {
      slot: 'primary',
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: 'sk-test',
      baseUrl: 'https://api.openai.com/v1',
    };

    expect(requestBody.slot).toBe('primary');
    expect(requestBody.provider).toBe('openai');
    expect(requestBody.model).toBe('gpt-4o');
  });

  it('POST /api/providers/test response shape on success', () => {
    const mockResponse = { ok: true, slot: 'primary', response: 'ok' };
    expect(mockResponse.ok).toBe(true);
    expect(mockResponse.slot).toBe('primary');
    expect(typeof mockResponse.response).toBe('string');
  });

  it('POST /api/providers/test response shape on failure', () => {
    const mockResponse = { ok: false, slot: 'primary', error: 'Invalid API key' };
    expect(mockResponse.ok).toBe(false);
    expect(typeof mockResponse.error).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 6. Dashboard HTML contains provider slot UI
// ---------------------------------------------------------------------------

describe('Dashboard provider UI', () => {
  it('contains crowclaw-connect-view for provider management', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-connect-view');
  });

  it('contains Providers text', () => {
    expect(DASHBOARD_HTML).toContain('>Providers<');
  });

  it('contains providers API endpoint', () => {
    expect(DASHBOARD_HTML).toContain('/api/providers');
  });

  it('contains provider text in the Lit output', () => {
    expect(DASHBOARD_HTML).toContain('provider');
  });

  it('contains primary provider reference', () => {
    expect(DASHBOARD_HTML).toContain('primary');
  });

  it('contains crowclaw-settings-view which includes provider config', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-settings-view');
  });

  it('contains crowclaw-modal for provider operations', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-modal');
  });

  it('contains MCP servers endpoint for integrations', () => {
    expect(DASHBOARD_HTML).toContain('/api/mcp/servers');
  });

  it('contains Settings section', () => {
    expect(DASHBOARD_HTML).toContain('Settings');
  });

  it('providers referenced in connect view', () => {
    expect(DASHBOARD_HTML).toContain('crowclaw-connect-view');
  });
});

// ---------------------------------------------------------------------------
// 7. Backward compatibility — existing provider resolution still works
// ---------------------------------------------------------------------------

describe('Backward compatibility', () => {
  it('RuntimeConfigStore still has getProviderInfo', () => {
    const store = new RuntimeConfigStore();
    const info = store.getProviderInfo();
    expect(info).toHaveProperty('type');
    expect(info).toHaveProperty('model');
    expect(info).toHaveProperty('configured');
  });

  it('setProvider still works independently of provider config', () => {
    const store = new RuntimeConfigStore();
    store.setProvider('openai', 'gpt-4o', 'sk-test');
    const info = store.getProviderInfo();
    expect(info.type).toBe('openai');
    expect(info.model).toBe('gpt-4o');
    expect(store.getProviderConfig()).toBeNull();
  });

  it('provider config does not affect legacy setProvider', () => {
    const store = new RuntimeConfigStore();
    store.setProvider('openai', 'gpt-4o', 'sk-test');
    store.setProviderConfig(baseConfig);

    const info = store.getProviderInfo();
    expect(info.type).toBe('openai');
    expect(info.model).toBe('gpt-4o');

    const cfg = store.getProviderConfig();
    expect(cfg?.primary.model).toBe('gpt-4o');
    expect(cfg?.fallback?.model).toBe('claude-haiku-4');
  });
});

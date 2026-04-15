import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveProviderFromConfig } from '../packages/runtime-node/src/provider-factory.js';
import { FileConfigStore, RuntimeConfigStore } from '../packages/runtime-node/src/config-store.js';
import { EchoProvider, OpenAICompatibleProvider, AnthropicProvider } from '@crowclaw/providers';
import { writeFile, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// resolveProviderFromConfig
// ---------------------------------------------------------------------------

describe('resolveProviderFromConfig', () => {
  it('returns OpenAICompatibleProvider when OPENAI_API_KEY is set', async () => {
    const result = await resolveProviderFromConfig({
      env: { OPENAI_API_KEY: 'sk-test-openai-key' },
      configFileContents: null,
    });

    expect(result.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(result.source).toBe('env');
    expect(result.warning).toBeUndefined();
  });

  it('returns AnthropicProvider when ANTHROPIC_API_KEY is set', async () => {
    const result = await resolveProviderFromConfig({
      env: { ANTHROPIC_API_KEY: 'sk-ant-test-key' },
      configFileContents: null,
    });

    expect(result.provider).toBeInstanceOf(AnthropicProvider);
    expect(result.source).toBe('env');
    expect(result.warning).toBeUndefined();
  });

  it('prefers CROWCLAW_API_KEY over OPENAI/ANTHROPIC keys', async () => {
    const result = await resolveProviderFromConfig({
      env: {
        CROWCLAW_API_KEY: 'sk-crowclaw-key',
        CROWCLAW_PROVIDER: 'anthropic',
        OPENAI_API_KEY: 'sk-openai-key',
        ANTHROPIC_API_KEY: 'sk-ant-key',
      },
      configFileContents: null,
    });

    expect(result.provider).toBeInstanceOf(AnthropicProvider);
    expect(result.source).toBe('env');
  });

  it('prefers ANTHROPIC_API_KEY over OPENAI_API_KEY', async () => {
    const result = await resolveProviderFromConfig({
      env: {
        ANTHROPIC_API_KEY: 'sk-ant-key',
        OPENAI_API_KEY: 'sk-openai-key',
      },
      configFileContents: null,
    });

    expect(result.provider).toBeInstanceOf(AnthropicProvider);
    expect(result.source).toBe('env');
  });

  it('reads config.json and returns correct provider for anthropic', async () => {
    const config = JSON.stringify({
      provider: 'anthropic',
      apiKey: 'sk-ant-from-config',
      baseUrl: 'https://api.anthropic.com',
      model: 'claude-sonnet-4',
      preset: 'general',
      createdAt: new Date().toISOString(),
    });

    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: config,
    });

    expect(result.provider).toBeInstanceOf(AnthropicProvider);
    expect(result.source).toBe('config-file');
  });

  it('reads config.json and returns correct provider for openai', async () => {
    const config = JSON.stringify({
      provider: 'openai',
      apiKey: 'sk-openai-from-config',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      preset: 'general',
    });

    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: config,
    });

    expect(result.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(result.source).toBe('config-file');
  });

  it('reads config.json and returns OpenAICompatible for openrouter', async () => {
    const config = JSON.stringify({
      provider: 'openrouter',
      apiKey: 'sk-or-from-config',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4',
    });

    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: config,
    });

    expect(result.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(result.source).toBe('config-file');
  });

  it('returns EchoProvider with warning when nothing is configured', async () => {
    const warnSpy = vi.fn();
    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: null,
      logger: { warn: warnSpy },
    });

    expect(result.provider).toBeInstanceOf(EchoProvider);
    expect(result.source).toBe('echo');
    expect(result.warning).toContain('No API key configured');
    expect(result.warning).toContain('crowclaw init');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('No API key configured'));
  });

  it('returns EchoProvider when config.json exists but has no apiKey', async () => {
    const warnSpy = vi.fn();
    const config = JSON.stringify({
      provider: 'openai',
      apiKey: '',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });

    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: config,
      logger: { warn: warnSpy },
    });

    expect(result.provider).toBeInstanceOf(EchoProvider);
    expect(result.source).toBe('echo');
  });

  it('returns EchoProvider when config.json is malformed', async () => {
    const warnSpy = vi.fn();
    const result = await resolveProviderFromConfig({
      env: {},
      configFileContents: '{invalid json',
      logger: { warn: warnSpy },
    });

    expect(result.provider).toBeInstanceOf(EchoProvider);
    expect(result.source).toBe('echo');
  });

  it('CROWCLAW_API_KEY with openai provider type creates OpenAICompatibleProvider', async () => {
    const result = await resolveProviderFromConfig({
      env: {
        CROWCLAW_API_KEY: 'sk-custom-key',
        CROWCLAW_PROVIDER: 'openai',
        CROWCLAW_BASE_URL: 'https://api.openai.com/v1',
        CROWCLAW_MODEL: 'gpt-4o',
      },
      configFileContents: null,
    });

    expect(result.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(result.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// FileConfigStore
// ---------------------------------------------------------------------------

describe('FileConfigStore', () => {
  let testDir: string;
  let configPath: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `crowclaw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    configPath = join(testDir, 'runtime-config.json');
  });

  afterEach(async () => {
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('starts with default empty config when file does not exist', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    expect(store.getActivePreset()).toBeNull();
    expect(store.getActiveToolset()).toBeNull();
    expect(store.getDisabledSkills()).toEqual([]);
    expect(store.getProviderInfo().type).toBe('none');
  });

  it('persists setActivePreset to disk', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    store.setActivePreset('code-expert', { role: 'coder', goal: 'Write code' });

    // Give the async write a moment to complete
    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(configPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.activePreset).toBe('code-expert');
    expect(data.agentPreset.role).toBe('coder');
  });

  it('persists setProvider to disk', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    store.setProvider('anthropic', 'claude-sonnet-4', 'sk-test');

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(configPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.providerType).toBe('anthropic');
    expect(data.model).toBe('claude-sonnet-4');
    // API key should NOT be persisted in the snapshot
    expect(data.apiKey).toBe('');
  });

  it('persists toggleSkill to disk', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    store.toggleSkill('web-search', false);

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(configPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.disabledSkills).toContain('web-search');
  });

  it('loads state from existing file on a new instance', async () => {
    // Write initial state with first instance
    const store1 = new FileConfigStore(configPath);
    await store1.load();
    store1.setActivePreset('research-analyst', { role: 'researcher', goal: 'Analyze data' });
    store1.setActiveToolset('full');
    store1.toggleSkill('coding', false);

    await new Promise((r) => setTimeout(r, 100));

    // Create second instance from same file
    const store2 = new FileConfigStore(configPath);
    await store2.load();

    expect(store2.getActivePreset()).toBe('research-analyst');
    expect(store2.getActiveToolset()).toBe('full');
    expect(store2.getDisabledSkills()).toContain('coding');
  });

  it('handles missing file gracefully (returns empty store)', async () => {
    const nonExistentPath = join(testDir, 'does-not-exist', 'config.json');
    const store = new FileConfigStore(nonExistentPath);
    await store.load();

    // Should not throw, should return defaults
    expect(store.getActivePreset()).toBeNull();
    expect(store.getProviderInfo().type).toBe('none');
  });

  it('handles corrupted file gracefully', async () => {
    await writeFile(configPath, '{corrupted json!!!', 'utf-8');

    const store = new FileConfigStore(configPath);
    await store.load();

    // Should fallback to defaults
    expect(store.getActivePreset()).toBeNull();
  });

  it('creates parent directories when persisting', async () => {
    const deepPath = join(testDir, 'a', 'b', 'c', 'config.json');
    const store = new FileConfigStore(deepPath);
    await store.load();

    store.setActiveToolset('minimal');

    await new Promise((r) => setTimeout(r, 100));

    const raw = await readFile(deepPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.activeToolset).toBe('minimal');
  });

  it('persists gateway config without leaking or round-tripping tokens', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    store.setGatewayConfig('discord', { enabled: true, token: 'test-token', webhookSecret: 'shh' });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(configPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.gatewayConfigs.discord.enabled).toBe(true);
    // Tokens and webhook secrets must never land on disk, because the previous
    // implementation persisted a '***' placeholder and then reloaded it as the
    // literal token — breaking every outbound message after a restart.
    expect(data.gatewayConfigs.discord.token).toBeUndefined();
    expect(data.gatewayConfigs.discord.webhookSecret).toBeUndefined();

    // Reloaded instance must not treat the redacted placeholder as a real token
    const store2 = new FileConfigStore(configPath);
    await store2.load();
    const reloaded = store2.getGatewayConfig('discord');
    expect(reloaded?.enabled).toBe(true);
    expect(reloaded?.token).toBeUndefined();
    expect(reloaded?.webhookSecret).toBeUndefined();
  });

  it('strips provider apiKeys before persisting', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    store.setProviderConfig({
      primary: { name: 'Primary', provider: 'openai', model: 'gpt-4o', apiKey: 'sk-plain' },
      fallback: { name: 'Fallback', provider: 'anthropic', model: 'claude-sonnet-4', apiKey: 'sk-ant' },
    });

    await new Promise((r) => setTimeout(r, 50));

    const raw = await readFile(configPath, 'utf-8');
    const data = JSON.parse(raw);
    expect(data.providerConfig.primary.provider).toBe('openai');
    expect(data.providerConfig.primary.apiKey).toBeUndefined();
    expect(data.providerConfig.fallback.apiKey).toBeUndefined();
  });

  it('onChange listeners fire on FileConfigStore mutations', async () => {
    const store = new FileConfigStore(configPath);
    await store.load();

    const changes: Array<{ key: string; value: unknown }> = [];
    store.onChange((key, value) => changes.push({ key, value }));

    store.setActivePreset('test-preset', null);
    store.setActiveToolset('full');

    expect(changes.length).toBe(2);
    expect(changes[0]!.key).toBe('activePreset');
    expect(changes[1]!.key).toBe('activeToolset');
  });

  it('implements same interface as RuntimeConfigStore', () => {
    const fileStore = new FileConfigStore(configPath);

    // Verify it's an instance of RuntimeConfigStore
    expect(fileStore).toBeInstanceOf(RuntimeConfigStore);

    // Verify all public methods exist
    expect(typeof fileStore.getActivePreset).toBe('function');
    expect(typeof fileStore.getAgentPreset).toBe('function');
    expect(typeof fileStore.getActiveToolset).toBe('function');
    expect(typeof fileStore.getDisabledSkills).toBe('function');
    expect(typeof fileStore.isSkillEnabled).toBe('function');
    expect(typeof fileStore.getMcpConnection).toBe('function');
    expect(typeof fileStore.getMcpConnections).toBe('function');
    expect(typeof fileStore.getGatewayConfig).toBe('function');
    expect(typeof fileStore.getGatewayConfigs).toBe('function');
    expect(typeof fileStore.getProviderInfo).toBe('function');
    expect(typeof fileStore.setActivePreset).toBe('function');
    expect(typeof fileStore.setActiveToolset).toBe('function');
    expect(typeof fileStore.toggleSkill).toBe('function');
    expect(typeof fileStore.setMcpConnection).toBe('function');
    expect(typeof fileStore.removeMcpConnection).toBe('function');
    expect(typeof fileStore.setGatewayConfig).toBe('function');
    expect(typeof fileStore.setProvider).toBe('function');
    expect(typeof fileStore.snapshot).toBe('function');
    expect(typeof fileStore.onChange).toBe('function');
    expect(typeof fileStore.load).toBe('function');
  });
});

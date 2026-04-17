/**
 * Provider factory — resolves the best available LLM provider from environment
 * variables and ~/.crowclaw/config.json, with EchoProvider as fallback.
 */

import type { ProviderAdapter } from '@crowclaw/core';
import { EchoProvider, OpenAICompatibleProvider, AnthropicProvider, CredentialPool, resolveApiMode } from '@crowclaw/providers';
import type { ProviderConfig, ProviderSlot } from './config-store.js';

export interface CrowClawFileConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  preset?: string;
  createdAt?: string;
}

export interface ResolvedProvider {
  provider: ProviderAdapter;
  source: 'env' | 'config-file' | 'echo';
  warning?: string;
}

export interface ResolvedProviders {
  primary: ProviderAdapter;
  fallback?: ProviderAdapter;
  vision?: ProviderAdapter;
  compression?: ProviderAdapter;
  embedding?: { embed(texts: string[]): Promise<number[][]> };
}

/**
 * Read ~/.crowclaw/config.json synchronously via a pre-loaded string,
 * or asynchronously via fs. The caller can pass the file contents
 * to avoid async in tests.
 */
function parseConfigFile(contents: string | null): CrowClawFileConfig | null {
  if (!contents) return null;
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    if (typeof parsed.provider === 'string' && typeof parsed.apiKey === 'string') {
      return parsed as unknown as CrowClawFileConfig;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Collect numbered API keys from env (e.g., CROWCLAW_API_KEY_2, CROWCLAW_API_KEY_3).
 * Returns all keys found (including the primary key).
 */
function collectNumberedKeys(env: Record<string, string | undefined>, prefix: string, primaryKey: string): string[] {
  const keys = [primaryKey];
  for (let i = 2; i <= 10; i++) {
    const numbered = env[`${prefix}_${i}`];
    if (numbered) {
      keys.push(numbered);
    }
  }
  return keys;
}

/**
 * Build a CredentialPool if multiple keys are available, otherwise return undefined.
 */
function maybeCreatePool(keys: string[]): CredentialPool | undefined {
  if (keys.length <= 1) return undefined;
  return new CredentialPool({ keys });
}

function createProviderFromType(
  providerType: string,
  apiKey: string,
  baseUrl: string,
  model: string,
  credentialPool?: CredentialPool
): ProviderAdapter {
  // Use API mode resolver when provider type is not explicit
  const resolvedMode = resolveApiMode(model, providerType !== 'openai' && providerType !== 'custom' ? providerType : undefined);

  if (providerType === 'anthropic' || resolvedMode.family === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      baseUrl: baseUrl || 'https://api.anthropic.com',
      model: model || 'claude-sonnet-4',
      ...(credentialPool ? { credentialPool } : {}),
    });
  }

  // openai, openrouter, google, custom — all OpenAI-compatible
  // Use resolved endpoint hint for base URL default
  const defaultBaseUrl = resolvedMode.family === 'google'
    ? 'https://generativelanguage.googleapis.com/v1beta/openai'
    : 'https://api.openai.com/v1';
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: baseUrl || defaultBaseUrl,
    model: model || 'gpt-4o',
    ...(credentialPool ? { credentialPool } : {}),
  });
}

export interface ResolveProviderOptions {
  /** Override env vars for testing */
  env?: Record<string, string | undefined>;
  /** Pre-loaded config file contents (skips fs read) */
  configFileContents?: string | null;
  /** Custom config file path (default: ~/.crowclaw/config.json) */
  configFilePath?: string;
  /** Logger for warnings */
  logger?: { warn: (msg: string) => void };
}

/**
 * Resolve the best available provider from environment and config file.
 *
 * Priority:
 * 1. CROWCLAW_API_KEY env var (uses CROWCLAW_PROVIDER, CROWCLAW_BASE_URL, CROWCLAW_MODEL)
 * 2. ANTHROPIC_API_KEY env var → AnthropicProvider
 * 3. OPENAI_API_KEY env var → OpenAICompatibleProvider
 * 4. ~/.crowclaw/config.json from CLI onboarding
 * 5. EchoProvider fallback with warning
 */
export async function resolveProviderFromConfig(
  options: ResolveProviderOptions = {}
): Promise<ResolvedProvider> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? console;

  // Collect all available API keys for credential pooling
  const allCrowclawKeys: string[] = [];
  const crowclawKey = env.CROWCLAW_API_KEY;
  if (crowclawKey) {
    allCrowclawKeys.push(...collectNumberedKeys(env, 'CROWCLAW_API_KEY', crowclawKey));
  }

  // 1. CROWCLAW_API_KEY — explicit framework key, highest priority
  if (crowclawKey) {
    const providerType = env.CROWCLAW_PROVIDER ?? 'openai';
    const baseUrl = env.CROWCLAW_BASE_URL ?? '';
    const model = env.CROWCLAW_MODEL ?? '';
    const pool = maybeCreatePool(allCrowclawKeys);
    return {
      provider: createProviderFromType(providerType, crowclawKey, baseUrl, model, pool),
      source: 'env',
    };
  }

  // 2. ANTHROPIC_API_KEY
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    const anthropicKeys = collectNumberedKeys(env, 'ANTHROPIC_API_KEY', anthropicKey);
    const pool = maybeCreatePool(anthropicKeys);
    return {
      provider: new AnthropicProvider({
        apiKey: anthropicKey,
        baseUrl: 'https://api.anthropic.com',
        model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4',
        ...(pool ? { credentialPool: pool } : {}),
      }),
      source: 'env',
    };
  }

  // 3. OPENAI_API_KEY
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    const openaiKeys = collectNumberedKeys(env, 'OPENAI_API_KEY', openaiKey);
    const pool = maybeCreatePool(openaiKeys);
    return {
      provider: new OpenAICompatibleProvider({
        apiKey: openaiKey,
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.OPENAI_MODEL ?? 'gpt-4o',
        ...(pool ? { credentialPool: pool } : {}),
      }),
      source: 'env',
    };
  }

  // 4. OPENROUTER_API_KEY — same shape as OpenAI (chat completions API)
  const openrouterKey = env.OPENROUTER_API_KEY;
  if (openrouterKey) {
    const openrouterKeys = collectNumberedKeys(env, 'OPENROUTER_API_KEY', openrouterKey);
    const pool = maybeCreatePool(openrouterKeys);
    return {
      provider: new OpenAICompatibleProvider({
        apiKey: openrouterKey,
        baseUrl: env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1',
        model: env.OPENROUTER_MODEL ?? 'openai/gpt-4o-mini',
        ...(pool ? { credentialPool: pool } : {}),
      }),
      source: 'env',
    };
  }

  // 4. Config file from CLI onboarding
  // Distinguish: undefined = "not provided, read from disk", null = "explicitly skip file"
  const hasExplicitConfig = 'configFileContents' in options;
  let configContents: string | null | undefined = hasExplicitConfig ? options.configFileContents : undefined;
  if (configContents === undefined && !hasExplicitConfig) {
    try {
      const { readFile } = await import('node:fs/promises');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const configPath = options.configFilePath ?? join(homedir(), '.crowclaw', 'config.json');
      configContents = await readFile(configPath, 'utf-8');
    } catch {
      configContents = null;
    }
  }

  const fileConfig = parseConfigFile(configContents ?? null);
  if (fileConfig && fileConfig.apiKey) {
    return {
      provider: createProviderFromType(
        fileConfig.provider,
        fileConfig.apiKey,
        fileConfig.baseUrl,
        fileConfig.model
      ),
      source: 'config-file',
    };
  }

  // 5. Fallback — EchoProvider with warning
  const warning =
    'No API key configured. Using echo mode. Run `crowclaw init` to set up a provider.';
  logger.warn(warning);
  return {
    provider: new EchoProvider(),
    source: 'echo',
    warning,
  };
}

// ---------------------------------------------------------------------------
// Multi-slot provider resolution from ProviderConfig
// ---------------------------------------------------------------------------

/**
 * Create a ProviderAdapter from a ProviderSlot configuration.
 * Falls back to using the primary API key if the slot doesn't have its own.
 */
export function createProviderFromSlot(
  slot: ProviderSlot,
  fallbackApiKey?: string
): ProviderAdapter {
  const apiKey = slot.apiKey || fallbackApiKey || '';
  const baseUrl = slot.baseUrl || '';
  return createProviderFromType(slot.provider, apiKey, baseUrl, slot.model);
}

/**
 * Resolve structured providers from a ProviderConfig.
 * Each slot in the config creates an appropriate provider instance.
 * The primary slot is always resolved; other slots are optional.
 */
export function resolveProvidersFromConfig(
  config: ProviderConfig,
  fallbackApiKey?: string
): ResolvedProviders {
  const result: ResolvedProviders = {
    primary: createProviderFromSlot(config.primary, fallbackApiKey),
  };

  if (config.fallback) {
    result.fallback = createProviderFromSlot(config.fallback, fallbackApiKey);
  }

  if (config.vision) {
    result.vision = createProviderFromSlot(config.vision, fallbackApiKey);
  }

  if (config.compression) {
    result.compression = createProviderFromSlot(config.compression, fallbackApiKey);
  }

  if (config.embedding) {
    // Call a real embedding endpoint. Prior versions asked the LLM to
    // "generate a numerical embedding vector" via generate(), then threw away
    // the response and used Math.sin(hash). That wasted tokens for zero signal
    // and misled callers who trusted the "semantic memory recall" claim.
    const slot = config.embedding;
    const apiKey = slot.apiKey || fallbackApiKey || '';
    const baseUrl = (slot.baseUrl ?? inferBaseUrlForProvider(slot.provider)).replace(/\/$/, '');
    const model = slot.model || 'text-embedding-3-small';
    if (!apiKey) {
      throw new Error(`Embedding slot "${slot.name}" requires an apiKey (direct or fallback).`);
    }
    result.embedding = {
      async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const res = await fetch(`${baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ input: texts, model }),
        });
        if (!res.ok) {
          throw new Error(`Embeddings API ${res.status}: ${(await res.text()).slice(0, 200)}`);
        }
        const payload = (await res.json()) as { data?: Array<{ embedding: number[] }> };
        if (!payload.data) {
          throw new Error('Embeddings API response missing `data` array');
        }
        return payload.data.map((d) => d.embedding);
      },
    };
  }

  return result;
}

function inferBaseUrlForProvider(provider: string): string {
  if (provider === 'anthropic') return 'https://api.anthropic.com/v1';
  if (provider === 'openrouter') return 'https://openrouter.ai/api/v1';
  return 'https://api.openai.com/v1';
}

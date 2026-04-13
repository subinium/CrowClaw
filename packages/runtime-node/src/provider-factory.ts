/**
 * Provider factory — resolves the best available LLM provider from environment
 * variables and ~/.crowclaw/config.json, with EchoProvider as fallback.
 */

import type { ProviderAdapter } from '@crowclaw/core';
import { EchoProvider, OpenAICompatibleProvider, AnthropicProvider } from '@crowclaw/providers';

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

function createProviderFromType(
  providerType: string,
  apiKey: string,
  baseUrl: string,
  model: string
): ProviderAdapter {
  if (providerType === 'anthropic') {
    return new AnthropicProvider({
      apiKey,
      baseUrl: baseUrl || 'https://api.anthropic.com',
      model: model || 'claude-sonnet-4',
    });
  }

  // openai, openrouter, custom — all OpenAI-compatible
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: baseUrl || 'https://api.openai.com/v1',
    model: model || 'gpt-4o',
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

  // 1. CROWCLAW_API_KEY — explicit framework key, highest priority
  const crowclawKey = env.CROWCLAW_API_KEY;
  if (crowclawKey) {
    const providerType = env.CROWCLAW_PROVIDER ?? 'openai';
    const baseUrl = env.CROWCLAW_BASE_URL ?? '';
    const model = env.CROWCLAW_MODEL ?? '';
    return {
      provider: createProviderFromType(providerType, crowclawKey, baseUrl, model),
      source: 'env',
    };
  }

  // 2. ANTHROPIC_API_KEY
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return {
      provider: new AnthropicProvider({
        apiKey: anthropicKey,
        baseUrl: 'https://api.anthropic.com',
        model: env.ANTHROPIC_MODEL ?? 'claude-sonnet-4',
      }),
      source: 'env',
    };
  }

  // 3. OPENAI_API_KEY
  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    return {
      provider: new OpenAICompatibleProvider({
        apiKey: openaiKey,
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.OPENAI_MODEL ?? 'gpt-4o',
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

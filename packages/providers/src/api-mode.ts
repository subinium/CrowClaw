/**
 * API Mode Resolver
 *
 * Resolves the correct API format (chat completions, responses, messages, etc.)
 * based on model name patterns and optional provider hints. This enables the
 * runtime to shape requests correctly for each provider's API surface.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApiMode =
  | 'openai_chat'           // /chat/completions (GPT, most open-source)
  | 'openai_responses'      // /responses (Codex, o-series reasoning)
  | 'anthropic_messages'    // /messages (Claude)
  | 'anthropic_bedrock'     // AWS Bedrock for Anthropic
  | 'google_gemini'         // Google Gemini API
  | 'echo';                 // Built-in echo (testing)

export interface ApiModeCapabilities {
  streaming: boolean;
  toolUse: boolean;
  vision: boolean;
  reasoning: boolean;       // extended thinking / chain-of-thought
  caching: boolean;         // prompt caching support
  batchApi: boolean;        // batch/async API
}

export interface ResolvedMode {
  mode: ApiMode;
  endpoint: string;         // e.g., '/chat/completions', '/messages', '/responses'
  capabilities: ApiModeCapabilities;
  family: string;           // 'openai' | 'anthropic' | 'google' | 'echo'
}

export interface ModeRequestShape {
  mode: ApiMode;
  messageFormat: 'messages' | 'input';          // messages = chat, input = responses
  toolFormat: 'tools' | 'functions' | 'none';
  streamParam: 'stream' | 'stream_options';
  systemRole: 'system' | 'developer';           // responses API uses 'developer'
}

// ---------------------------------------------------------------------------
// Internal capability presets
// ---------------------------------------------------------------------------

const ANTHROPIC_CAPABILITIES: ApiModeCapabilities = {
  streaming: true,
  toolUse: true,
  vision: true,
  reasoning: true,
  caching: true,
  batchApi: true,
};

const OPENAI_RESPONSES_CAPABILITIES: ApiModeCapabilities = {
  streaming: true,
  toolUse: true,
  vision: true,
  reasoning: true,
  caching: true,
  batchApi: true,
};

const OPENAI_CHAT_CAPABILITIES: ApiModeCapabilities = {
  streaming: true,
  toolUse: true,
  vision: true,
  reasoning: false,
  caching: true,
  batchApi: false,
};

const GOOGLE_GEMINI_CAPABILITIES: ApiModeCapabilities = {
  streaming: true,
  toolUse: true,
  vision: true,
  reasoning: false,
  caching: false,
  batchApi: false,
};

const ECHO_CAPABILITIES: ApiModeCapabilities = {
  streaming: false,
  toolUse: false,
  vision: false,
  reasoning: false,
  caching: false,
  batchApi: false,
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the API mode for a given model name.
 * Uses model name patterns to determine the correct API format.
 * An optional providerHint overrides pattern matching.
 */
export function resolveApiMode(modelName: string, providerHint?: string): ResolvedMode {
  // Echo provider — testing
  if (modelName === 'echo' || providerHint === 'echo') {
    return {
      mode: 'echo',
      endpoint: '/echo',
      capabilities: { ...ECHO_CAPABILITIES },
      family: 'echo',
    };
  }

  // Anthropic Bedrock
  if (providerHint === 'anthropic_bedrock') {
    return {
      mode: 'anthropic_bedrock',
      endpoint: '/model/invoke',
      capabilities: { ...ANTHROPIC_CAPABILITIES },
      family: 'anthropic',
    };
  }

  // Anthropic models
  if (/^claude/i.test(modelName) || providerHint === 'anthropic') {
    return {
      mode: 'anthropic_messages',
      endpoint: '/v1/messages',
      capabilities: { ...ANTHROPIC_CAPABILITIES },
      family: 'anthropic',
    };
  }

  // OpenAI Responses API models (o-series reasoning, codex)
  if (/^(o1|o3|o4|codex)/i.test(modelName) || providerHint === 'openai_responses') {
    return {
      mode: 'openai_responses',
      endpoint: '/v1/responses',
      capabilities: { ...OPENAI_RESPONSES_CAPABILITIES },
      family: 'openai',
    };
  }

  // Google Gemini
  if (/^gemini/i.test(modelName) || providerHint === 'google') {
    return {
      mode: 'google_gemini',
      endpoint: '/v1/chat/completions',
      capabilities: { ...GOOGLE_GEMINI_CAPABILITIES },
      family: 'google',
    };
  }

  // Default: OpenAI Chat Completions
  return {
    mode: 'openai_chat',
    endpoint: '/v1/chat/completions',
    capabilities: { ...OPENAI_CHAT_CAPABILITIES },
    family: 'openai',
  };
}

// ---------------------------------------------------------------------------
// Convenience helpers
// ---------------------------------------------------------------------------

/**
 * Check if a model supports a specific capability.
 */
export function modelSupports(modelName: string, capability: keyof ApiModeCapabilities): boolean {
  const resolved = resolveApiMode(modelName);
  return resolved.capabilities[capability];
}

/**
 * Get the correct endpoint path for a model.
 */
export function getEndpointForModel(modelName: string): string {
  return resolveApiMode(modelName).endpoint;
}

/**
 * List all supported API modes with their descriptions.
 */
export function listApiModes(): Array<{ mode: ApiMode; description: string; family: string }> {
  return [
    { mode: 'openai_chat', description: 'OpenAI Chat Completions API (/chat/completions)', family: 'openai' },
    { mode: 'openai_responses', description: 'OpenAI Responses API (/responses) for reasoning models', family: 'openai' },
    { mode: 'anthropic_messages', description: 'Anthropic Messages API (/messages)', family: 'anthropic' },
    { mode: 'anthropic_bedrock', description: 'AWS Bedrock for Anthropic models', family: 'anthropic' },
    { mode: 'google_gemini', description: 'Google Gemini API (OpenAI-compatible)', family: 'google' },
    { mode: 'echo', description: 'Built-in echo provider for testing', family: 'echo' },
  ];
}

// ---------------------------------------------------------------------------
// Request shape metadata
// ---------------------------------------------------------------------------

/**
 * Return metadata about how the request body should be shaped for a given API mode.
 * This tells the caller which field names and roles to use.
 */
export function getRequestShape(mode: ApiMode): ModeRequestShape {
  switch (mode) {
    case 'openai_responses':
      return { mode, messageFormat: 'input', toolFormat: 'tools', streamParam: 'stream', systemRole: 'developer' };
    case 'anthropic_messages':
      return { mode, messageFormat: 'messages', toolFormat: 'tools', streamParam: 'stream', systemRole: 'system' };
    case 'anthropic_bedrock':
      return { mode, messageFormat: 'messages', toolFormat: 'tools', streamParam: 'stream', systemRole: 'system' };
    case 'google_gemini':
      return { mode, messageFormat: 'messages', toolFormat: 'tools', streamParam: 'stream', systemRole: 'system' };
    case 'echo':
      return { mode, messageFormat: 'messages', toolFormat: 'none', streamParam: 'stream', systemRole: 'system' };
    case 'openai_chat':
    default:
      return { mode, messageFormat: 'messages', toolFormat: 'tools', streamParam: 'stream', systemRole: 'system' };
  }
}

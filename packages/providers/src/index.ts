import type { ConversationMessage, ProviderAdapter, ProviderRequest, ProviderResponse, ProviderResponseUsage, StructuredOutputRequest, StructuredOutputResponse, ToolCall, ToolManifest } from '@crowclaw/core';
import { parseSlashToolCall } from '@crowclaw/core';
import type { StreamChunk, StreamingProviderAdapter } from '@crowclaw/core/streaming';
import { collectStream } from '@crowclaw/core/streaming';
// v0.8.4 (#274) — pure-JS BPE tokenizer for ±5% token-count precision against
// tiktoken reference vectors. Pulled from `gpt-tokenizer`'s per-encoding
// subpath exports so we only ship the BPE table for the encodings we use
// (cl100k_base + o200k_base) and never depend on native `.node` bindings.
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';
import { encode as encodeO200k } from 'gpt-tokenizer/encoding/o200k_base';
// v0.8.0 (#232) — JSON repair for malformed tool-call arguments.
import { repairJson, type RepairResult } from './json-repair.js';
// v0.8.0 (#231 / #236) — reasoning-block parser. Wraps streaming text deltas so
// `<plan>...</plan>` / `<think>...</think>` regions are emitted as distinct
// chunks, and lifts `<tool_call>...</tool_call>` JSON spans out of reasoning
// regions so they can flow through the standard tool-call extractor.
import {
  parseReasoningBlocks,
  StreamingReasoningParser,
  type ReasoningBlock,
} from '@crowclaw/core/reasoning-blocks';
import {
  loadManifest,
  findModelEntry,
  type ManifestCache,
} from './model-catalog.js';

export interface OpenAICompatibleConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  credentialPool?: CredentialPool;
  /** Override the API endpoint path (default: /chat/completions). Use /responses for o-series/codex models. */
  endpointPath?: string;
  /** Issue #60: Optional remote manifest URL override for context-length lookups. */
  manifestUrl?: string;
  /** Issue #60: Optional manifest cache (in-memory map keyed by URL). */
  manifestCache?: ManifestCache;
  /**
   * v0.7.2: OAuth bearer-token hook used by the ChatGPT (Codex) backend.
   * When set, takes precedence over credentialPool / static apiKey. Called
   * before every request so a refreshed token is always used.
   */
  tokenProvider?: () => Promise<string>;
  /**
   * v0.7.2: Extra request headers (e.g., chatgpt-account-id, originator,
   * OpenAI-Beta). Merged into both /chat/completions and /responses calls.
   */
  extraHeaders?: Record<string, string>;
  /**
   * v0.7.2: Called when the upstream returns 401. Should refresh credentials
   * and resolve `true` to signal the provider to retry the request once.
   */
  onAuthFailure?: () => Promise<boolean>;
  /**
   * v0.7.2: Extra fields to merge into the JSON request body. Used by the
   * ChatGPT (Codex) backend, which requires `store: false` on every call.
   */
  extraBodyFields?: Record<string, unknown>;
  /** Default token cap for provider requests when a request does not supply one. */
  maxTokens?: number;
  /** Default temperature for non-reasoning models. Reasoning models reject this field. */
  temperature?: number;
  /** OpenAI Responses API reasoning effort for models that accept reasoning controls. */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Retry budget for transient 429/5xx provider responses. Default: 2 retries. */
  maxRetries?: number;
  /** Base delay for exponential backoff retries. Default: 250ms. Tests can set 0. */
  retryBaseDelayMs?: number;
  /** Dependency-injected sleep for retry tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional OpenAI prompt cache routing key. When omitted CrowClaw derives a stable prefix key. */
  promptCacheKey?: string;
  /** OpenAI prompt cache retention policy when supported by the endpoint. */
  promptCacheRetention?: 'in-memory' | '24h';
  /**
   * v0.7.2: When the Responses API is in use, route the system prompt to the
   * top-level `instructions` field instead of injecting a `developer` message
   * into the `input` array. Required by the ChatGPT (Codex) backend.
   */
  systemPromptAsInstructions?: boolean;
  /**
   * v0.7.2: When set, `generate()` and native structured-output requests
   * collect from `generateStream()` instead of issuing a non-streaming POST.
   * Required by the ChatGPT (Codex) backend, which rejects `stream: false`
   * calls.
   */
  requireStream?: boolean;
  /**
   * v0.8.0 (#232): Telemetry hook fired when malformed tool-call arguments are
   * recovered by the JSON repair pass. The runtime attaches this to forward
   * `tool:args_repaired` to its EventBus so the dashboard can surface chronic
   * model misbehaviour. Optional — providers without observability wired in
   * pay no cost.
   */
  onArgsRepaired?: (info: { toolName: string; originalLength: number; repairedLength: number; reason: string }) => void;
  /**
   * v0.9.0 (#330): OpenRouter response-cache opt-out. When the configured
   * `baseUrl` points at OpenRouter (`openrouter.ai/api/v1`) and this flag is
   * `true` (default), the provider attaches a top-level
   * `cache_control: { type: 'ephemeral' }` field on every request body so
   * OpenRouter's prompt-cache layer can reuse identical conversation prefixes.
   * Non-OpenRouter endpoints ignore this field. Set to `false` to suppress the
   * header (useful for backends that 400 on unknown fields).
   */
  openRouterResponseCache?: boolean;
  /**
   * v0.9.0 (#330): Audit hook fired after each OpenRouter request so the
   * runtime can record cache hits / misses. The provider extracts
   * `usage.prompt_tokens_details.cached_tokens` and `cache_write_tokens` from
   * the response — both are part of OpenRouter's documented `ResponseUsage`
   * schema. Optional; non-OpenRouter providers never fire this callback.
   */
  onCacheTelemetry?: (info: ProviderCacheTelemetry) => void;
}

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  promptCaching?: boolean;
  credentialPool?: CredentialPool;
  /** Issue #60: Optional remote manifest URL override for context-length lookups. */
  manifestUrl?: string;
  /** Issue #60: Optional manifest cache (in-memory map keyed by URL). */
  manifestCache?: ManifestCache;
  /** v0.8.0 (#232): see {@link OpenAICompatibleConfig.onArgsRepaired}. */
  onArgsRepaired?: (info: { toolName: string; originalLength: number; repairedLength: number; reason: string }) => void;
  /**
   * v0.9.0 (#336): Prompt-cache breakpoint TTL. Anthropic supports `5m`
   * (default) and `1h` on every `cache_control` block. Selecting `1h` adds the
   * `extended-cache-ttl-2025-04-11` beta header in addition to the existing
   * `prompt-caching-2024-07-31` flag. Only takes effect when
   * `promptCaching: true`.
   */
  cacheTtl?: '5m' | '1h';
  /**
   * v0.9.0 (#336): Audit hook fired after each Anthropic request. Includes the
   * TTL actually used for the breakpoints plus the cache_creation /
   * cache_read token counts surfaced by Anthropic's response so callers can
   * track real cache hits. Optional.
   */
  onCacheTelemetry?: (info: ProviderCacheTelemetry) => void;
}

/**
 * v0.9.0 (#330 / #336): Shared telemetry shape emitted by both the
 * Anthropic and OpenAI-compatible (OpenRouter) providers when a cache-related
 * request lands. Counts are best-effort — providers omit fields the upstream
 * did not surface. The runtime forwards this to its audit log so the dashboard
 * can show per-provider hit rates and TTL distribution.
 */
export interface ProviderCacheTelemetry {
  provider: 'anthropic' | 'openrouter';
  /** Anthropic only: TTL the request was configured with ('5m' | '1h'). */
  ttl?: '5m' | '1h';
  /** Tokens read from cache (cache hit). Maps to:
   *   - Anthropic: `usage.cache_read_input_tokens`
   *   - OpenRouter: `usage.prompt_tokens_details.cached_tokens` */
  cacheReadTokens: number;
  /** Tokens written to a fresh cache entry (cache miss / first warm-up). Maps to:
   *   - Anthropic: `usage.cache_creation_input_tokens`
   *   - OpenRouter: `usage.prompt_tokens_details.cache_write_tokens` */
  cacheWriteTokens: number;
  /** Whether the upstream response reported a cache hit. Convenience flag:
   *   true when `cacheReadTokens > 0`. */
  hit: boolean;
}

export interface ModelMetadata {
  id: string;
  family: 'openai-compatible' | 'anthropic';
  contextWindow: number;
  supportsTools: boolean;
  supportsPromptCaching: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
  /**
   * Issue #87: Vision capability flag. Defaults to false when omitted so
   * dispatch code (gateway) can safely treat absence as "no image support".
   */
  vision?: boolean;
  /**
   * Issue #98: Per-model request timeout (ms). Resolution precedence:
   * model-level (this) → provider-level → global default. Optional.
   */
  requestTimeoutMs?: number;
}

interface OpenAIToolCall {
  function?: {
    name?: string;
    arguments?: string;
  };
}

interface OpenAIFunctionCall {
  name?: string;
  arguments?: string;
}

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      content?:
        | null
        | string
        | Array<
            | { type?: 'text'; text?: string }
            | { type?: 'text'; text?: { value?: string } }
            | { type?: 'output_text'; text?: string }
            | { type?: 'input_text'; text?: string }
            | { type?: 'refusal'; refusal?: string; text?: string }
          >;
      refusal?: string;
      tool_calls?: OpenAIToolCall[];
      function_call?: OpenAIFunctionCall;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: {
      cached_tokens?: number;
      /** v0.9.0 (#330): OpenRouter reports a `cache_write_tokens` count
       * alongside `cached_tokens` so callers can distinguish first-warmup
       * (write) from steady-state hits (read). Other OpenAI-compatible
       * backends usually omit it. */
      cache_write_tokens?: number;
    };
  };
}

interface ChatCompletionsRequestTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      additionalProperties: boolean;
      properties: Record<string, never>;
    };
  };
}

// ---------------------------------------------------------------------------
// Anthropic API types
// ---------------------------------------------------------------------------

/**
 * v0.9.0 (#336): Anthropic's `cache_control` breakpoint marker. The same shape
 * is accepted on every cacheable content block (tools, system content, user /
 * assistant content blocks). `ttl` defaults to `5m` upstream; selecting `1h`
 * requires the `extended-cache-ttl-2025-04-11` beta header (added in the
 * fetch caller below).
 */
interface AnthropicCacheControl {
  type: 'ephemeral';
  ttl?: '5m' | '1h';
}

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
  };
  /** v0.9.0 (#336): present on the last tool when prompt-cache breakpoints are enabled. */
  cache_control?: AnthropicCacheControl;
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  /** v0.8.0 (#231): native `thinking` / `redacted_thinking` content payload. */
  thinking?: string;
}

interface AnthropicMessagesResponse {
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlockParam[];
}

type AnthropicContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function normalizeToolShortcut(toolCall: ToolCall): ToolCall {
  if (toolCall.name === 'terminal.exec' && typeof toolCall.input.raw === 'string') {
    return {
      name: toolCall.name,
      input: { command: toolCall.input.raw }
    };
  }

  return toolCall;
}

function resolveKnownTool(toolCall: ToolCall, availableTools: ToolManifest[]): ProviderResponse {
  // Match by exact name or sanitized name (e.g., web_search → web.search)
  const exactMatch = availableTools.find((tool) => tool.name === toolCall.name);
  const sanitizedMatch = !exactMatch
    ? availableTools.find((tool) => sanitizeToolName(tool.name) === toolCall.name)
    : null;
  const known = exactMatch || sanitizedMatch || availableTools.length === 0;
  if (!known) {
    return {
      assistantMessage: `Unknown tool: ${toolCall.name}`
    };
  }

  // Restore original name if matched via sanitized form
  const resolvedCall = sanitizedMatch
    ? { ...toolCall, name: sanitizedMatch.name }
    : toolCall;

  const normalized = normalizeToolShortcut(resolvedCall);
  return {
    assistantMessage: `Scheduling tool ${normalized.name}.`,
    toolCalls: [normalized]
  };
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function buildOpenAITools(availableTools: ToolManifest[]): ChatCompletionsRequestTool[] {
  return availableTools.map((tool) => ({
    type: 'function',
    function: {
      name: sanitizeToolName(tool.name),
      description: tool.description,
      parameters: (tool.inputSchema as ChatCompletionsRequestTool['function']['parameters']) ?? {
        type: 'object',
        additionalProperties: true,
        properties: {}
      }
    }
  }));
}

/**
 * v0.7.2: Responses API uses a flat tool shape
 * `{type: 'function', name, description, parameters}` rather than the nested
 * `{type: 'function', function: {...}}` of /chat/completions. Mismatching the
 * shape returns 400 with `Missing required parameter: 'tools[0].name'`.
 */
function buildResponsesApiTools(availableTools: ToolManifest[]): Array<Record<string, unknown>> {
  return availableTools.map((tool) => ({
    type: 'function',
    name: sanitizeToolName(tool.name),
    description: tool.description,
    parameters: (tool.inputSchema as ChatCompletionsRequestTool['function']['parameters']) ?? {
      type: 'object',
      additionalProperties: true,
      properties: {},
    },
  }));
}

/**
 * v0.8.0 (#232): Repair-aware JSON parse for tool-call arguments. Returns an
 * empty record on outright failure (preserving the prior behavior of
 * `JSON.parse` falling back to `{ raw }`), and emits `onRepair` telemetry when
 * the JSON repair pipeline successfully recovered from a malformed payload.
 */
function parseToolCallArgsWithRepair(
  rawArguments: string,
  toolName: string,
  onRepair?: ArgsRepairedCallback,
): Record<string, unknown> {
  try {
    const result = repairJson(rawArguments);
    emitRepairTelemetry(result, rawArguments, toolName, onRepair);
    if (result.value && typeof result.value === 'object' && !Array.isArray(result.value)) {
      return result.value as Record<string, unknown>;
    }
    // Repair returned a non-object (e.g. array). Fall back to `{ raw }` so the
    // tool sees the original payload rather than a coerced shape.
    return { raw: rawArguments };
  } catch {
    return { raw: rawArguments };
  }
}

type ArgsRepairedCallback = (info: { toolName: string; originalLength: number; repairedLength: number; reason: string }) => void;

function emitRepairTelemetry(
  result: RepairResult,
  rawArguments: string,
  toolName: string,
  onRepair?: ArgsRepairedCallback,
): void {
  if (!result.repaired || !onRepair) return;
  try {
    const repairedLength = JSON.stringify(result.value).length;
    onRepair({
      toolName,
      originalLength: rawArguments.length,
      repairedLength,
      reason: result.reason ?? 'reformatted',
    });
  } catch {
    // Never let a broken telemetry hook crash the tool-call parser.
  }
}

function parseOpenAIToolCalls(toolCalls: OpenAIToolCall[] | undefined, availableTools?: ToolManifest[], onRepair?: ArgsRepairedCallback): ToolCall[] | undefined {
  if (!toolCalls || toolCalls.length === 0) {
    return undefined;
  }

  // Build reverse map from sanitized names back to original names
  const nameMap = new Map<string, string>();
  if (availableTools) {
    for (const tool of availableTools) {
      nameMap.set(sanitizeToolName(tool.name), tool.name);
    }
  }

  return toolCalls
    .map((toolCall) => {
      const sanitizedName = toolCall.function?.name;
      if (!sanitizedName) {
        return null;
      }

      const name = nameMap.get(sanitizedName) ?? sanitizedName;
      const rawArguments = toolCall.function?.arguments ?? '{}';
      const input = parseToolCallArgsWithRepair(rawArguments, name, onRepair);

      return { name, input } satisfies ToolCall;
    })
    .filter((value): value is ToolCall => Boolean(value));
}

function parseOpenAIFunctionCall(functionCall: OpenAIFunctionCall | undefined, onRepair?: ArgsRepairedCallback): ToolCall[] | undefined {
  if (!functionCall?.name) {
    return undefined;
  }

  const rawArguments = functionCall.arguments ?? '{}';
  const input = parseToolCallArgsWithRepair(rawArguments, functionCall.name, onRepair);

  return [{ name: functionCall.name, input }];
}

function normalizeOpenAIMessageContent(
  content:
    | null
    | string
    | Array<
        | { type?: 'text'; text?: string }
        | { type?: 'text'; text?: { value?: string } }
        | { type?: 'output_text'; text?: string }
        | { type?: 'input_text'; text?: string }
        | { type?: 'refusal'; refusal?: string; text?: string }
      >
    | undefined,
  refusal?: string
): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return refusal;
  }

  const parts = content
    .map((part) => {
      if (typeof part?.text === 'string') {
        return part.text;
      }
      if (typeof part?.text === 'object' && typeof part.text?.value === 'string') {
        return part.text.value;
      }
      if ('refusal' in part && typeof part.refusal === 'string') {
        return part.refusal;
      }
      return '';
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join('\n') : refusal;
}

// ---------------------------------------------------------------------------
// v0.8.0 (#231 / #236) — Reasoning-block streaming/non-streaming helpers
// ---------------------------------------------------------------------------

/**
 * #236: scan a complete assistant turn for Hermes-style `<tool_call>` blocks
 * and return them as ToolCall objects. Used as a FALLBACK only — native
 * function-call slots (OpenAI tool_calls / Responses function_call) take
 * precedence. Resolves sanitized tool names back to the original manifest
 * names so the agent loop can dispatch them.
 *
 * The Hermes 4 hybrid contract allows tool_call blocks INSIDE `<think>`
 * regions; `parseReasoningBlocks` already returns those spans via
 * `toolCallSpans`, so this helper just consumes that view directly.
 */
function parseHermesToolCallSpans(
  text: string,
  availableTools?: ToolManifest[],
): ToolCall[] | undefined {
  if (!text || !text.includes('<tool_call>')) {
    return undefined;
  }
  const { toolCallSpans } = parseReasoningBlocks(text);
  if (toolCallSpans.length === 0) return undefined;

  const nameMap = new Map<string, string>();
  if (availableTools) {
    for (const tool of availableTools) {
      nameMap.set(sanitizeToolName(tool.name), tool.name);
    }
  }

  const calls: ToolCall[] = [];
  for (const span of toolCallSpans) {
    const json = span.json.trim();
    if (!json) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue; // malformed span — skip silently; #232 (json-repair) owns recovery
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const obj = parsed as Record<string, unknown>;
    // Hermes payload shape: { name: string, arguments: object | string }
    // Some models emit { tool: string, args: object } — accept both.
    const rawName =
      typeof obj.name === 'string' ? obj.name :
      typeof obj.tool === 'string' ? obj.tool :
      undefined;
    if (!rawName) continue;
    const resolvedName = nameMap.get(rawName) ?? rawName;
    let input: Record<string, unknown> = {};
    const rawArgs = obj.arguments ?? obj.args ?? {};
    if (typeof rawArgs === 'string') {
      try { input = JSON.parse(rawArgs) as Record<string, unknown>; } catch { input = { raw: rawArgs }; }
    } else if (rawArgs && typeof rawArgs === 'object') {
      input = rawArgs as Record<string, unknown>;
    }
    calls.push({ name: resolvedName, input });
  }
  return calls.length > 0 ? calls : undefined;
}

/**
 * #231: convert a `StreamingReasoningParser` event into the wire-shape
 * `StreamChunk` that the agent loop / runtime SSE bridge consume. Tool-call
 * spans are folded into a synthetic tool_use_{start,delta,end} sequence so
 * the existing collectStream / runStreaming logic can pick them up without
 * special casing the Hermes XML contract.
 */
function* reasoningEventsToChunks(
  events: ReturnType<StreamingReasoningParser['feed']>,
  hermesToolCallIdSeed: { count: number },
  availableTools: ToolManifest[] | undefined,
): Generator<StreamChunk, void, void> {
  const nameMap = new Map<string, string>();
  if (availableTools) {
    for (const tool of availableTools) {
      nameMap.set(sanitizeToolName(tool.name), tool.name);
    }
  }
  for (const ev of events) {
    switch (ev.type) {
      case 'text':
        if (ev.content) yield { type: 'text', text: ev.content };
        break;
      case 'reasoning_start':
        yield { type: 'reasoning_start', reasoningTag: ev.tag };
        break;
      case 'reasoning_delta':
        yield { type: 'reasoning_delta', text: ev.content };
        break;
      case 'reasoning_end':
        yield { type: 'reasoning_end', reasoningTag: ev.tag };
        break;
      case 'tool_call_span': {
        // #236: synthesize tool_use_{start,delta,end} from a complete Hermes
        // span so downstream consumers see one logical tool call. The id is
        // synthetic (`hermes-N`) and the name comes from the parsed JSON
        // payload — if parsing fails we drop the span (json-repair owns
        // recovery for partial payloads in #232).
        let name = '';
        let argsString = '{}';
        let parsed: unknown;
        try { parsed = JSON.parse(ev.json); } catch { /* keep raw */ }
        if (parsed && typeof parsed === 'object') {
          const obj = parsed as Record<string, unknown>;
          const rawName =
            typeof obj.name === 'string' ? obj.name :
            typeof obj.tool === 'string' ? obj.tool : '';
          name = nameMap.get(rawName) ?? rawName;
          const rawArgs = obj.arguments ?? obj.args ?? {};
          argsString = typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs);
        } else {
          argsString = ev.json;
        }
        if (!name) break; // can't dispatch without a name; drop silently
        const id = `hermes-${++hermesToolCallIdSeed.count}`;
        yield { type: 'tool_use_start', toolName: name, toolCallId: id };
        if (argsString) yield { type: 'tool_use_delta', toolInput: argsString, toolCallId: id };
        yield { type: 'tool_use_end', toolName: name, toolInput: argsString, toolCallId: id };
        break;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Anthropic helpers
// ---------------------------------------------------------------------------

function buildAnthropicTools(availableTools: ToolManifest[]): AnthropicTool[] {
  return availableTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: (tool.inputSchema as AnthropicTool['input_schema']) ?? {
      type: 'object' as const,
      properties: {}
    }
  }));
}

/**
 * v0.9.0 (#336): Resolve the cache_control breakpoint for an Anthropic
 * request. Returns `undefined` (no caching at all) when `promptCaching` is
 * false or omitted; otherwise returns `{ type: 'ephemeral', ttl }` with TTL
 * defaulting to `'5m'` and `'1h'` available as an opt-in. Centralised so the
 * generate / generateStream / structured-output paths all share the same
 * resolution rule.
 */
function resolveAnthropicCacheControl(
  config: AnthropicConfig,
): AnthropicCacheControl | undefined {
  if (!config.promptCaching) return undefined;
  const ttl = config.cacheTtl ?? '5m';
  return { type: 'ephemeral', ttl };
}

/**
 * v0.9.0 (#336): Stamp the last tool entry with a cache_control breakpoint so
 * Anthropic caches the (model, system, tools) prefix. Mutates in place because
 * the calling convention is `body.tools = buildAnthropicTools(...)` and the
 * builder already returns a fresh array — no aliasing risk. No-op when the
 * tools array is empty.
 */
function applyAnthropicCacheControlToTools(
  tools: AnthropicTool[],
  cacheControl: AnthropicCacheControl,
): void {
  if (tools.length === 0) return;
  const last = tools[tools.length - 1]!;
  last.cache_control = cacheControl;
}

/**
 * v0.9.0 (#336): Convert a `system` string into the array-of-content-blocks
 * form so the trailing block can carry a `cache_control` breakpoint. Anthropic
 * accepts both shapes for `system`; the array form is required for cache
 * markers because the breakpoint attaches to a content block, not a string.
 */
function buildCachedAnthropicSystem(
  systemPrompt: string,
  cacheControl: AnthropicCacheControl,
): Array<{ type: 'text'; text: string; cache_control: AnthropicCacheControl }> {
  return [
    {
      type: 'text',
      text: systemPrompt,
      cache_control: cacheControl,
    },
  ];
}

/**
 * v0.9.0 (#336): Compose the `anthropic-beta` request header. We always keep
 * the `prompt-caching-2024-07-31` flag whenever `promptCaching` is enabled,
 * and additionally enable `extended-cache-ttl-2025-04-11` when the caller
 * opted into the 1-hour TTL. Returns the joined comma-separated value (or
 * `undefined` if no beta features are needed).
 */
function buildAnthropicBetaHeader(config: AnthropicConfig): string | undefined {
  if (!config.promptCaching) return undefined;
  const flags = ['prompt-caching-2024-07-31'];
  if (config.cacheTtl === '1h') {
    flags.push('extended-cache-ttl-2025-04-11');
  }
  return flags.join(',');
}

/**
 * v0.9.0 (#336): Forward Anthropic cache-hit / -miss counts to the configured
 * audit hook. Defensive: never throws. Includes the TTL the request was
 * configured with so the dashboard can show TTL distribution and confirm
 * `1h` requests actually carried the right header.
 */
function emitAnthropicCacheTelemetry(
  config: AnthropicConfig,
  usage: AnthropicMessagesResponse['usage'] | undefined,
): void {
  if (!config.onCacheTelemetry) return;
  if (!config.promptCaching) return;
  const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
  try {
    config.onCacheTelemetry({
      provider: 'anthropic',
      ttl: config.cacheTtl ?? '5m',
      cacheReadTokens,
      cacheWriteTokens,
      hit: cacheReadTokens > 0,
    });
  } catch {
    // Swallow — telemetry is best-effort.
  }
}

function parseAnthropicToolCalls(contentBlocks: AnthropicContentBlock[] | undefined): ToolCall[] | undefined {
  if (!contentBlocks) {
    return undefined;
  }

  const toolUseBlocks = contentBlocks.filter((block) => block.type === 'tool_use');
  if (toolUseBlocks.length === 0) {
    return undefined;
  }

  return toolUseBlocks
    .map((block) => {
      if (!block.name) {
        return null;
      }
      return {
        name: block.name,
        input: (block.input ?? {}) as Record<string, unknown>
      } satisfies ToolCall;
    })
    .filter((value): value is ToolCall => Boolean(value));
}

function buildAnthropicMessages(
  messages: ProviderRequest['messages']
): AnthropicMessageParam[] {
  const result: AnthropicMessageParam[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      // System messages are handled via the top-level `system` field.
      continue;
    }

    if (message.role === 'tool') {
      // Tool results must be sent as a user message with tool_result content blocks.
      // If the previous message in result is already a user message with content blocks,
      // append to it. Otherwise create a new user message.
      const toolResultBlock: AnthropicContentBlockParam = {
        type: 'tool_result',
        tool_use_id: message.toolCallId ?? message.name ?? 'unknown',
        content: message.content
      };

      const lastResult = result[result.length - 1];
      if (lastResult && lastResult.role === 'user' && Array.isArray(lastResult.content)) {
        (lastResult.content as AnthropicContentBlockParam[]).push(toolResultBlock);
      } else {
        result.push({
          role: 'user',
          content: [toolResultBlock]
        });
      }
      continue;
    }

    if (message.role === 'assistant' || message.role === 'user') {
      result.push({
        role: message.role,
        content: message.content
      });
    }
  }

  // Anthropic requires messages to alternate user/assistant. Merge consecutive same-role messages.
  const merged: AnthropicMessageParam[] = [];
  for (const msg of result) {
    const last = merged[merged.length - 1];
    if (last && last.role === msg.role) {
      // Merge content
      if (typeof last.content === 'string' && typeof msg.content === 'string') {
        last.content = `${last.content}\n${msg.content}`;
      } else {
        // Convert to array form for merging
        const lastArr: AnthropicContentBlockParam[] = typeof last.content === 'string'
          ? [{ type: 'text', text: last.content }]
          : last.content;
        const msgArr: AnthropicContentBlockParam[] = typeof msg.content === 'string'
          ? [{ type: 'text', text: msg.content }]
          : msg.content;
        last.content = [...lastArr, ...msgArr];
      }
    } else {
      merged.push({ ...msg });
    }
  }

  return merged;
}

// ---------------------------------------------------------------------------
// Issue #56: Tool-use guidance + stale budget warning stripping
// ---------------------------------------------------------------------------

/**
 * Heuristic regex matching stale budget/iteration-limit warnings that the
 * runtime injects into earlier turns (e.g. "[BUDGET WARNING: ...]"). When
 * these accumulate in history, some models start treating them as standing
 * instructions and refuse to call tools. Strip them before sending.
 */
const STALE_BUDGET_WARNING_RE = /\b(budget|iteration limit|max_tool_iterations)\b/i;

/**
 * Filter assistant/system messages whose entire content is a stale budget
 * warning. Preserves user/tool messages and any assistant message with
 * substantive content beyond the warning.
 */
export function stripStaleBudgetWarnings(messages: ConversationMessage[]): ConversationMessage[] {
  return messages.filter((msg) => {
    if (msg.role !== 'assistant' && msg.role !== 'system') return true;
    const content = msg.content?.trim() ?? '';
    if (!content) return true;
    // Only strip if the message looks predominantly like a budget warning
    // (short, matches the heuristic). Longer messages with substantive
    // content are kept even if they incidentally mention "budget".
    if (content.length > 240) return true;
    return !STALE_BUDGET_WARNING_RE.test(content);
  });
}

// ---------------------------------------------------------------------------
// Token counting helpers
// ---------------------------------------------------------------------------

function countMessageChars(messages: ConversationMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length;
    if (msg.name) chars += msg.name.length;
    // Issue #51: Skip msg.metadata — internal bookkeeping
    // (toolCount, iteration, concurrent, budgetWarning, ok, etc.) does
    // not reach the LLM token stream. Counting it conflates "internal
    // state size" with "model context length".
  }
  return chars;
}

/**
 * v0.8.4 (#274): Per-model encoding family. Models in the GPT-4o, GPT-5,
 * o-series, and codex families use OpenAI's `o200k_base` BPE vocabulary
 * (~200k tokens, much better non-ASCII coverage). Everything else routes to
 * `cl100k_base` (GPT-3.5 / GPT-4 / GPT-4-Turbo). Unknown models fall through
 * to `cl100k` — that matches OpenAI's tokenizer playground default and gives
 * reasonable behavior for OpenAI-compatible third-party providers.
 */
function getOpenAIEncodingFamily(model: string): 'o200k' | 'cl100k' {
  const id = model.toLowerCase();
  return /^(?:gpt-4o|gpt-5|o1|o3|o4|codex)/.test(id) ? 'o200k' : 'cl100k';
}

/**
 * v0.8.4 (#274): Encode `text` with the actual `gpt-tokenizer` BPE table for
 * the given encoding family and return the token count. This replaces the
 * pre-v0.8.4 char/4 + Unicode-chunk heuristic, which drifted by 30%+ on
 * code-heavy and non-ASCII inputs.
 *
 * `gpt-tokenizer` is a pure-JS implementation — no native `.node` bindings,
 * no postinstall step that runs anything beyond the package's own dev
 * tooling — so this stays safe to ship to Workers / Bun / Deno targets and
 * to import in the browser bundle that powers the dashboard.
 */
function countEncodedTextTokens(text: string, family: 'o200k' | 'cl100k'): number {
  if (!text) return 0;
  const encode = family === 'o200k' ? encodeO200k : encodeCl100k;
  return encode(text).length;
}

function countOpenAIMessageTokens(messages: ConversationMessage[], model: string): number {
  const family = getOpenAIEncodingFamily(model);
  let total = 0;
  for (const msg of messages) {
    total += 3; // role/message framing overhead used by OpenAI chat encodings.
    total += countEncodedTextTokens(msg.role, family);
    total += countEncodedTextTokens(msg.content, family);
    if (msg.name) total += countEncodedTextTokens(msg.name, family);
  }
  return total;
}

function extractOpenAIUsage(payload: ChatCompletionsResponse): ProviderResponseUsage | undefined {
  const u = payload.usage;
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  const cachedTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: u.total_tokens ?? (inputTokens + outputTokens),
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

function extractAnthropicUsage(payload: AnthropicMessagesResponse): ProviderResponseUsage | undefined {
  const u = payload.usage;
  if (!u) return undefined;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const cachedTokens = (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(cachedTokens > 0 ? { cachedTokens } : {}),
  };
}

// ---------------------------------------------------------------------------
// Rate limit header helpers
// ---------------------------------------------------------------------------

function checkRateLimitHeaders(headers: Headers, pool: CredentialPool, key: string): void {
  // OpenAI: x-ratelimit-remaining / x-ratelimit-reset
  const remaining = headers.get('x-ratelimit-remaining');
  if (remaining !== null && parseInt(remaining, 10) === 0) {
    const resetHeader = headers.get('x-ratelimit-reset');
    if (resetHeader) {
      const resetDate = new Date(resetHeader);
      const durationMs = resetDate.getTime() - Date.now();
      if (durationMs > 0) {
        pool.cooldownKey(key, durationMs);
        return;
      }
    }
    // No valid reset header — use default cooldown
    pool.cooldownKey(key);
    return;
  }

  // Standard: retry-after (seconds or HTTP-date)
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null) {
    const seconds = parseInt(retryAfter, 10);
    if (!isNaN(seconds)) {
      pool.cooldownKey(key, seconds * 1000);
    } else {
      const retryDate = new Date(retryAfter);
      const durationMs = retryDate.getTime() - Date.now();
      if (durationMs > 0) {
        pool.cooldownKey(key, durationMs);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Structured-output helpers (#237)
// ---------------------------------------------------------------------------

/**
 * Detect whether the configured (baseUrl, model) combination supports
 * OpenAI's native `response_format: json_schema` mode. We restrict the native
 * path to api.openai.com gpt-4o / gpt-4.1 / gpt-5 / reasoning families to avoid 400s from
 * OpenAI-compatible backends (OpenRouter, NVIDIA, vLLM) that don't honour the
 * field. Everything else falls back to the schema-block envelope.
 */
function supportsNativeJsonSchema(baseUrl: string, model: string): boolean {
  if (!/api\.openai\.com/i.test(baseUrl)) return false;
  return /^(?:gpt-4o|gpt-4\.1|gpt-5|o1|o3|o4)/i.test(model);
}

function isReasoningModel(model: string): boolean {
  return /^(?:o1|o3|o4)/i.test(model);
}

function isOpenAIHosted(baseUrl: string): boolean {
  return /api\.openai\.com/i.test(baseUrl);
}

function stablePrefixHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function stableToolsForPromptCache(availableTools: ToolManifest[]): ToolManifest[] {
  return [...availableTools].sort((a, b) => a.name.localeCompare(b.name));
}

function applyPromptCacheFields(
  body: Record<string, unknown>,
  config: OpenAICompatibleConfig,
  request: ProviderRequest,
): void {
  if (!isOpenAIHosted(config.baseUrl)) return;
  const staticPrefix = JSON.stringify({
    model: config.model,
    systemPrompt: request.systemPrompt ?? '',
    tools: stableToolsForPromptCache(request.availableTools).map((tool) => ({
      name: tool.name,
      description: tool.description,
      schema: tool.inputSchema ?? null,
    })),
  });
  body.prompt_cache_key = (config.promptCacheKey ?? `crowclaw-${stablePrefixHash(staticPrefix)}`).slice(0, 512);
  if (config.promptCacheRetention) {
    body.prompt_cache_retention = config.promptCacheRetention;
  }
}

/**
 * v0.9.0 (#330): Detect whether the configured baseUrl is OpenRouter. The
 * canonical host is `openrouter.ai`; we match the host portion of the URL so
 * port / path variants (e.g. behind a corporate proxy mapped to the same
 * upstream) are caught too. Returns false on any parse failure so a malformed
 * `baseUrl` cannot accidentally enable OpenRouter-specific code paths.
 */
function isOpenRouterEndpoint(baseUrl: string): boolean {
  try {
    const u = new URL(baseUrl);
    return /(^|\.)openrouter\.ai$/i.test(u.host);
  } catch {
    return false;
  }
}

/**
 * v0.9.0 (#330): Attach OpenRouter's automatic prompt-cache header on the
 * request body. Documented at
 * https://openrouter.ai/docs/guides/best-practices/prompt-caching — when set,
 * OpenRouter caches the maximal-prefix up to the last cacheable block, with
 * the breakpoint advancing automatically as the conversation grows. Costs
 * nothing on a cache miss; saves real money on hot prefixes. Skipped for
 * non-OpenRouter endpoints so other OpenAI-compatible backends (NVIDIA, xAI,
 * etc.) don't see an unknown field.
 *
 * We also opt the request into OpenRouter's usage-accounting so the final SSE
 * chunk surfaces `prompt_tokens_details.cached_tokens` — required for the
 * cache-hit / -miss telemetry surfaced via {@link onCacheTelemetry}.
 */
function applyOpenRouterCacheFields(
  body: Record<string, unknown>,
  config: OpenAICompatibleConfig,
): void {
  if (!isOpenRouterEndpoint(config.baseUrl)) return;
  // Default is opt-in: callers explicitly setting `false` suppress the field.
  if (config.openRouterResponseCache === false) return;
  body.cache_control = { type: 'ephemeral' };
  // Streaming variants need `stream_options.include_usage` to receive the
  // final usage chunk that carries cached-tokens telemetry. Non-streaming
  // calls already get usage by default and ignore this field.
  if (body.stream === true) {
    const existing = (body.stream_options as Record<string, unknown> | undefined) ?? {};
    body.stream_options = { ...existing, include_usage: true };
    // OpenRouter follows OpenAI's `usage` extra in `extra_body` semantics too;
    // include the top-level `usage` accounting flag for parity with the
    // documented usage-accounting cookbook.
    body.usage = { include: true };
  }
}

/**
 * v0.9.0 (#330): Pull cache-hit/-miss counts out of an OpenAI-compatible
 * usage payload and forward them to the configured telemetry hook. The
 * function is host-gated so non-OpenRouter responses never produce a
 * `provider: 'openrouter'` telemetry event. Defensive: never throws — a
 * broken telemetry hook must not crash the request.
 */
function emitOpenRouterCacheTelemetry(
  config: OpenAICompatibleConfig,
  usage: ChatCompletionsResponse['usage'] | undefined,
): void {
  if (!config.onCacheTelemetry) return;
  if (!isOpenRouterEndpoint(config.baseUrl)) return;
  if (config.openRouterResponseCache === false) return;
  const details = usage?.prompt_tokens_details;
  const cacheReadTokens = details?.cached_tokens ?? 0;
  const cacheWriteTokens = details?.cache_write_tokens ?? 0;
  try {
    config.onCacheTelemetry({
      provider: 'openrouter',
      cacheReadTokens,
      cacheWriteTokens,
      hit: cacheReadTokens > 0,
    });
  } catch {
    // Swallow — telemetry is best-effort.
  }
}

function applyOpenAITokenAndSamplingFields(
  body: Record<string, unknown>,
  options: {
    model: string;
    isResponsesApi: boolean;
    maxTokens?: number;
    temperature?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
  },
): void {
  const reasoning = isReasoningModel(options.model);
  const maxTokens = options.maxTokens ?? 16384;

  if (options.isResponsesApi) {
    body.max_output_tokens = maxTokens;
    if (reasoning && options.reasoningEffort) {
      body.reasoning_effort = options.reasoningEffort;
    }
  } else if (reasoning) {
    body.max_completion_tokens = maxTokens;
  } else {
    body.max_tokens = maxTokens;
  }

  if (reasoning) {
    delete body.temperature;
    return;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }
}

function shouldRetryProviderStatus(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function parseRetryAfterMs(headers: Headers): number | null {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return null;
  const seconds = Number.parseFloat(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const retryDate = new Date(retryAfter).getTime();
  if (!Number.isNaN(retryDate)) return Math.max(0, retryDate - Date.now());
  return null;
}

function disableSameKeyRetryForCredentialPool(
  config: OpenAICompatibleConfig,
  pool?: CredentialPool,
): OpenAICompatibleConfig {
  return pool ? { ...config, maxRetries: 0 } : config;
}

async function fetchOpenAIWithRetry(
  fetcher: () => Promise<Response>,
  config: OpenAICompatibleConfig,
  signal?: AbortSignal,
): Promise<Response> {
  const maxRetries = config.maxRetries ?? 2;
  const baseDelayMs = config.retryBaseDelayMs ?? 250;
  const sleep = config.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;

  while (true) {
    const response = await fetcher();
    if (!shouldRetryProviderStatus(response.status) || attempt >= maxRetries || signal?.aborted) {
      return response;
    }
    const retryAfterMs = parseRetryAfterMs(response.headers);
    const exponentialMs = baseDelayMs * 2 ** attempt;
    const jitterMs = baseDelayMs === 0 ? 0 : Math.floor(Math.random() * Math.max(1, baseDelayMs));
    await sleep(retryAfterMs ?? (exponentialMs + jitterMs));
    attempt += 1;
  }
}

function extractResponsesOutputText(payload: Record<string, unknown>): string {
  const output = payload.output;
  if (!Array.isArray(output)) return '';
  let text = '';
  for (const item of output as Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>) {
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part.type === 'output_text' && part.text) {
        text += part.text;
      }
    }
  }
  return text;
}

/**
 * Build the schema-block envelope used by providers without a native JSON
 * mode. Keeps the prompt minimal so caller-provided messages still drive the
 * generation; the schema just specifies the *shape*.
 */
function buildSchemaSystemPrompt(schema: object, schemaDescription?: string): string {
  const lines: string[] = [
    'You are a helpful assistant that answers in JSON.',
    "Here's the json schema you must adhere to:",
    `<schema>${JSON.stringify(schema)}</schema>`,
  ];
  if (schemaDescription) {
    lines.push(`Schema notes: ${schemaDescription}`);
  }
  lines.push('Respond with only the JSON object, no prose, no code fences.');
  return lines.join('\n');
}

/**
 * Shared response finalizer: parses (with JSON repair), validates, and packs
 * the typed envelope. Used by both providers' `generateStructured` paths.
 */
function finalizeStructuredResponse<T>(
  raw: string,
  req: StructuredOutputRequest<T>,
): StructuredOutputResponse<T> {
  // Strip a leading/trailing code fence if the model emitted one despite
  // instructions (common on instruction-tuned local models).
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  let parsed: unknown;
  let repaired = false;
  try {
    const result = repairJson(trimmed.length > 0 ? trimmed : '{}');
    parsed = result.value;
    repaired = result.repaired;
  } catch (err) {
    return { ok: false, error: 'parse', details: err instanceof Error ? err.message : String(err), raw };
  }

  // Validation pass: caller-supplied validator wins; otherwise tiny inline
  // top-level required+types check (mirrors #235 depth).
  if (req.validator) {
    try {
      const value = req.validator(parsed);
      return repaired ? { ok: true, value, raw, repaired: true } : { ok: true, value, raw };
    } catch (err) {
      return { ok: false, error: 'validate', details: err instanceof Error ? err.message : String(err), raw };
    }
  }

  const valid = validateAgainstSchema(parsed, req.schema);
  if (!valid.ok) {
    return { ok: false, error: 'validate', details: valid.reason, raw };
  }

  return repaired
    ? { ok: true, value: parsed as T, raw, repaired: true }
    : { ok: true, value: parsed as T, raw };
}

/**
 * Tiny inline JSON-schema validator. Top-level only — checks `type` /
 * `required` / per-property `type`. Sufficient for the v0.8.0 contract; full
 * Ajv-grade validation is the caller's responsibility via `req.validator`.
 */
function validateAgainstSchema(value: unknown, schema: object): { ok: true } | { ok: false; reason: string } {
  const s = schema as { type?: string; required?: string[]; properties?: Record<string, { type?: string }> };
  if (s.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, reason: 'expected object at root' };
    }
    const obj = value as Record<string, unknown>;
    if (Array.isArray(s.required)) {
      for (const key of s.required) {
        if (!(key in obj)) return { ok: false, reason: `missing required property "${key}"` };
      }
    }
    if (s.properties) {
      for (const [key, propSchema] of Object.entries(s.properties)) {
        if (!(key in obj)) continue;
        const expected = propSchema?.type;
        if (!expected) continue;
        const actual = obj[key];
        if (!matchesJsonType(actual, expected)) {
          return { ok: false, reason: `property "${key}" expected ${expected}, got ${typeOfJson(actual)}` };
        }
      }
    }
    return { ok: true };
  }
  if (s.type === 'array') {
    if (!Array.isArray(value)) return { ok: false, reason: 'expected array at root' };
    return { ok: true };
  }
  // Unknown / unspecified root type — accept anything.
  return { ok: true };
}

function matchesJsonType(value: unknown, expected: string): boolean {
  if (expected === 'string') return typeof value === 'string';
  if (expected === 'number' || expected === 'integer') return typeof value === 'number';
  if (expected === 'boolean') return typeof value === 'boolean';
  if (expected === 'null') return value === null;
  if (expected === 'array') return Array.isArray(value);
  if (expected === 'object') return value !== null && typeof value === 'object' && !Array.isArray(value);
  return true;
}

function typeOfJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * Issue #175: Demo-mode configuration for EchoProvider. When `demoMode` is on,
 * `generateStream` emits 12 token-shaped chunks pacing across ~800ms with a
 * `<thinking>...</thinking>` reasoning block and a fake `[TOOL CALL: web.fetch]`
 * segment, so the chat UI exercises tool-call rendering and reasoning-scrub
 * paths without a real provider key.
 */
export interface EchoProviderOptions {
  /** Enable simulated streaming for the no-key onboarding demo path. */
  demoMode?: boolean;
  /** Total wall-clock pacing across the 12 demo chunks. Defaults to 800ms. */
  demoStreamDurationMs?: number;
  /** Override the chunk count (default: 12). Tests use 12; do not lower in prod. */
  demoChunkCount?: number;
  /**
   * Sleep function — DI for tests so we can drive the stream without
   * actually waiting 800ms. Defaults to `setTimeout`-backed promise.
   */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_DEMO_DURATION_MS = 800;
const DEFAULT_DEMO_CHUNK_COUNT = 12;

/**
 * Issue #175: 12 token-shaped fragments. Includes a `<thinking>...</thinking>`
 * reasoning block and a `[TOOL CALL: web.fetch] {url:'...'}` segment so the
 * UI's tool-call rendering and reasoning-scrub paths get exercised against
 * echo output. Total emitted text reads as a coherent assistant turn.
 */
const DEMO_STREAM_FRAGMENTS: readonly string[] = [
  '<thinking>',
  'User asked a question. ',
  'I should answer concisely',
  ' and demonstrate that streaming, tool calls, ',
  'and reasoning blocks all wire through.',
  '</thinking>',
  '\n\nGreat question! Let me ',
  'fetch a quick reference.',
  '\n\n[TOOL CALL: web.fetch]',
  " {url:'https://crowclaw.dev/docs'}",
  '\n\nThis is **DEMO mode** (no real LLM). ',
  'Set `OPENROUTER_API_KEY` for a real provider.',
];

export class EchoProvider implements ProviderAdapter, StreamingProviderAdapter {
  private readonly demoMode: boolean;
  private readonly demoStreamDurationMs: number;
  private readonly demoChunkCount: number;
  private readonly sleep: (ms: number) => Promise<void>;

  /**
   * Issue #175: Optional options bag. Backwards compatible — `new EchoProvider()`
   * still works exactly as before for unit tests and hermetic mode.
   */
  constructor(options: EchoProviderOptions = {}) {
    this.demoMode = options.demoMode ?? false;
    this.demoStreamDurationMs = options.demoStreamDurationMs ?? DEFAULT_DEMO_DURATION_MS;
    this.demoChunkCount = options.demoChunkCount ?? DEFAULT_DEMO_CHUNK_COUNT;
    this.sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Issue #72: Echo provider accepts any key (testing). */
  static validateKey(_key: string): KeyValidationResult {
    return { ok: true };
  }

  /** Issue #175: Surface demo-mode status to operators / system-status endpoints. */
  isDemoMode(): boolean {
    return this.demoMode;
  }

  /** Issue #56: Echo provider needs no nudging — testing only. */
  getToolUseGuidance(_modelId: string): string | null {
    return null;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const lastMessage = request.messages.at(-1);
    if (!lastMessage) {
      return { assistantMessage: 'CrowClaw is ready.' };
    }

    if (lastMessage.role === 'tool') {
      const toolName = lastMessage.name ?? 'tool';
      return {
        assistantMessage: `Tool ${toolName} returned:\n${lastMessage.content}`
      };
    }

    const lastUserMessage = [...request.messages].reverse().find((message) => message.role === 'user')?.content ?? '';
    const parsed = parseSlashToolCall(lastUserMessage);
    if (parsed) {
      return resolveKnownTool(parsed, request.availableTools);
    }

    return { assistantMessage: `CrowClaw received: ${lastUserMessage}` };
  }

  async *generateStream(request: ProviderRequest): AsyncGenerator<StreamChunk> {
    if (this.demoMode) {
      yield* this.generateDemoStream();
      return;
    }

    const response = await this.generate(request);
    if (response.assistantMessage) {
      yield { type: 'text', text: response.assistantMessage };
    }
    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        const inputJson = JSON.stringify(tc.input);
        yield { type: 'tool_use_start', toolName: tc.name };
        yield { type: 'tool_use_delta', toolInput: inputJson };
        yield { type: 'tool_use_end', toolName: tc.name, toolInput: inputJson };
      }
    }
    yield { type: 'done' };
  }

  /**
   * Issue #175: Simulated streaming for the no-key onboarding path. Emits
   * `demoChunkCount` (default 12) token-shaped fragments with even pacing
   * across `demoStreamDurationMs` (default 800ms). Total wall time is
   * approximately the configured duration regardless of chunk count.
   */
  private async *generateDemoStream(): AsyncGenerator<StreamChunk> {
    const fragments = DEMO_STREAM_FRAGMENTS.slice(0, this.demoChunkCount);
    const perChunkDelay = this.demoChunkCount > 0
      ? Math.max(0, Math.floor(this.demoStreamDurationMs / this.demoChunkCount))
      : 0;

    for (const fragment of fragments) {
      if (perChunkDelay > 0) {
        await this.sleep(perChunkDelay);
      }
      yield { type: 'text', text: fragment };
    }
    yield { type: 'done' };
  }
}

export class OpenAICompatibleProvider implements ProviderAdapter, StreamingProviderAdapter {
  constructor(private readonly config: OpenAICompatibleConfig) {}

  /** Issue #72: Validate an OpenAI-shaped key. Static so callers can check
   *  before constructing the provider. Subclasses (NVIDIA, xAI, Gemini) can
   *  override at the call site by using `validateProviderKey('nvidia', key)`. */
  static validateKey(key: string): KeyValidationResult {
    return validateOpenAIKey(key);
  }

  /** Create a copy with a different model (same API key and base URL) */
  withModel(model: string): OpenAICompatibleProvider {
    return new OpenAICompatibleProvider({ ...this.config, model });
  }

  getModel(): string {
    return this.config.model;
  }

  /** Resolve the API endpoint: use explicit override, or auto-detect from model name */
  private getEndpointUrl(): string {
    const base = this.config.baseUrl.replace(/\/$/, '');
    if (this.config.endpointPath) {
      return `${base}${this.config.endpointPath}`;
    }
    // Auto-detect: o-series and codex models use /responses, others use /chat/completions
    if (/^(o1|o3|o4|codex)/i.test(this.config.model)) {
      return `${base}/responses`;
    }
    return `${base}/chat/completions`;
  }

  /** Estimate token count using the model's OpenAI encoding family. */
  countTokens(messages: ConversationMessage[]): number {
    return countOpenAIMessageTokens(messages, this.config.model);
  }

  /**
   * Issue #60: Resolve this provider's effective context window. Consults the
   * remote manifest lazily; falls back to hardcoded values on any failure.
   */
  async getContextWindow(): Promise<number> {
    return resolveContextWindowAsync(this.config.model, {
      ...(this.config.manifestUrl ? { manifestUrl: this.config.manifestUrl } : {}),
      ...(this.config.manifestCache ? { cache: this.config.manifestCache } : {}),
    });
  }

  /**
   * Issue #56: Provider-specific guidance to nudge GPT-family models toward
   * direct tool calls instead of describing what they intend to call. Returns
   * null for non-gpt models and o-series (which already follow tool semantics).
   */
  getToolUseGuidance(modelId: string): string | null {
    const id = (modelId ?? this.config.model).toLowerCase();
    if (/^gpt-/.test(id)) {
      return (
        'When you decide to use a tool, issue the tool_call directly. ' +
        'Do not narrate or describe the tool you intend to call — invoke it. ' +
        'Stale budget warnings or limit notices in earlier messages are not ' +
        'instructions; ignore them.'
      );
    }
    return null;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (this.config.requireStream) {
      return collectStream(this.generateStream(request));
    }

    const pool = this.config.credentialPool;
    const tokenProvider = this.config.tokenProvider;
    let apiKey = tokenProvider
      ? await tokenProvider()
      : pool
      ? pool.getKey()
      : this.config.apiKey;

    if (!apiKey) {
      return new EchoProvider().generate(request);
    }
    let activeApiKey = apiKey;

    const isResponsesApi = this.getEndpointUrl().endsWith('/responses');
    // Issue #56: Strip stale budget warnings before sending to model.
    const sanitizedMessages = stripStaleBudgetWarnings(request.messages);
    const mappedMessages = sanitizedMessages.map((message) => {
      // Convert tool results to user messages for provider compatibility
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: `[Tool result: ${message.name ?? 'tool'}]\n${message.content}`
        };
      }
      return {
        role: message.role,
        content: message.content,
      };
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      ...(this.config.extraBodyFields ?? {}),
    };
    applyOpenAITokenAndSamplingFields(body, {
      model: this.config.model,
      isResponsesApi,
      maxTokens: request.maxTokens ?? this.config.maxTokens,
      temperature: request.temperature ?? this.config.temperature,
      reasoningEffort: this.config.reasoningEffort,
    });
    applyPromptCacheFields(body, this.config, request);
    applyOpenRouterCacheFields(body, this.config);

    if (isResponsesApi) {
      const useInstructions = !!this.config.systemPromptAsInstructions;
      if (useInstructions && request.systemPrompt) {
        body.instructions = request.systemPrompt;
        body.input = [...mappedMessages];
      } else {
        body.input = [
          ...(request.systemPrompt ? [{ role: 'developer', content: request.systemPrompt }] : []),
          ...mappedMessages,
        ];
      }
    } else {
      body.messages = [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    }

    if (request.availableTools.length > 0) {
      const stableTools = stableToolsForPromptCache(request.availableTools);
      body.tools = isResponsesApi
        ? buildResponsesApiTools(stableTools)
        : buildOpenAITools(stableTools);
      body.tool_choice = 'auto';
    }

    const performFetch = async (bearer: string) =>
      fetch(this.getEndpointUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          ...(this.config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

    const retryConfig = disableSameKeyRetryForCredentialPool(this.config, pool);
    let response = await fetchOpenAIWithRetry(() => performFetch(activeApiKey), retryConfig, request.signal);

    if (response.status === 401 && this.config.onAuthFailure) {
      const refreshed = await this.config.onAuthFailure();
      if (refreshed && tokenProvider) {
        activeApiKey = await tokenProvider();
        response = await fetchOpenAIWithRetry(() => performFetch(activeApiKey), retryConfig, request.signal);
      }
    }

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(activeApiKey, response.status);
      }
      const errBody = await response.text().catch(() => '');
      throw new Error(`Provider request failed: ${response.status} ${response.statusText}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}`);
    }

    if (pool) {
      pool.reportSuccess(activeApiKey);
      checkRateLimitHeaders(response.headers, pool, activeApiKey);
    }

    const rawPayload = (await response.json()) as Record<string, unknown>;

    // Handle Responses API format: { output: [...], usage: {...} }
    if (isResponsesApi && Array.isArray(rawPayload.output)) {
      const outputItems = rawPayload.output as Array<{ type: string; content?: Array<{ type: string; text?: string }>; name?: string; arguments?: string; call_id?: string }>;
      let text = '';
      const toolCalls: Array<{ name: string; input: Record<string, unknown>; id?: string }> = [];
      for (const item of outputItems) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && part.text) text += part.text;
          }
        }
        if (item.type === 'function_call' && item.name) {
          // v0.8.0 (#232): repair-aware parse so truncated / unquoted-key
          // payloads from /responses still feed the agent loop.
          const originalName = request.availableTools.find((t) => sanitizeToolName(t.name) === item.name)?.name ?? item.name;
          const args = parseToolCallArgsWithRepair(item.arguments ?? '{}', originalName, this.config.onArgsRepaired);
          toolCalls.push({ name: originalName, input: args, id: item.call_id });
        }
      }
      const rawUsage = rawPayload.usage as Record<string, number> | undefined;
      const usage = rawUsage ? {
        inputTokens: rawUsage.input_tokens ?? 0,
        outputTokens: rawUsage.output_tokens ?? 0,
        totalTokens: (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
        ...(((rawPayload.usage as { input_tokens_details?: { cached_tokens?: number } }).input_tokens_details?.cached_tokens ?? 0) > 0
          ? { cachedTokens: (rawPayload.usage as { input_tokens_details?: { cached_tokens?: number } }).input_tokens_details!.cached_tokens }
          : {}),
      } : undefined;
      // v0.8.0 (#231 / #236): scan the full assistant turn for reasoning
      // blocks and Hermes-style `<tool_call>` spans. Native function_call
      // outputs from the Responses API still win — XML extraction only
      // contributes additional calls if no native ones were emitted.
      const responsesParsed = text ? parseReasoningBlocks(text) : null;
      const responsesStripped = responsesParsed?.stripped ?? text;
      const responsesBlocks = responsesParsed?.blocks ?? [];
      let responsesToolCalls = toolCalls;
      if (responsesToolCalls.length === 0 && text) {
        const hermesCalls = parseHermesToolCallSpans(text, request.availableTools);
        if (hermesCalls && hermesCalls.length > 0) {
          responsesToolCalls = hermesCalls.map((c) => ({ name: c.name, input: c.input }));
        }
      }
      const responsesResp: ProviderResponse = {
        assistantMessage: responsesStripped || undefined,
        toolCalls: responsesToolCalls.length > 0 ? responsesToolCalls : undefined,
        ...(usage ? { usage } : {}),
      };
      if (responsesBlocks.length > 0) responsesResp.reasoningBlocks = responsesBlocks;
      return responsesResp;
    }

    // Standard Chat Completions format
    const payload = rawPayload as ChatCompletionsResponse;
    const message = payload.choices?.[0]?.message;
    const assistantMessage = normalizeOpenAIMessageContent(message?.content, message?.refusal);
    let parsedToolCalls = parseOpenAIToolCalls(message?.tool_calls, request.availableTools, this.config.onArgsRepaired) ?? parseOpenAIFunctionCall(message?.function_call, this.config.onArgsRepaired);
    const usage = extractOpenAIUsage(payload);
    // v0.9.0 (#330): forward OpenRouter cache-hit / -miss counts to the audit
    // log so the dashboard can show real cost savings on hot prefixes.
    emitOpenRouterCacheTelemetry(this.config, payload.usage);

    // v0.8.0 (#231): extract reasoning blocks from the assistant turn before
    // the slash-tool fallback so the slash-call regex doesn't see inner-tag text.
    const cmpParsed = assistantMessage ? parseReasoningBlocks(assistantMessage) : null;
    const cmpStripped = cmpParsed?.stripped ?? assistantMessage;
    const cmpBlocks = cmpParsed?.blocks ?? [];

    // v0.8.0 (#236): Hermes XML `<tool_call>` blocks are an ADDITIONAL fallback
    // — applied only when no native function_call slots were present.
    if ((!parsedToolCalls || parsedToolCalls.length === 0) && assistantMessage) {
      const hermesCalls = parseHermesToolCallSpans(assistantMessage, request.availableTools);
      if (hermesCalls && hermesCalls.length > 0) {
        parsedToolCalls = hermesCalls;
      }
    }

    if ((!parsedToolCalls || parsedToolCalls.length === 0) && cmpStripped) {
      const slashToolCall = parseSlashToolCall(cmpStripped.trim());
      if (slashToolCall) {
        const resolved = resolveKnownTool(slashToolCall, request.availableTools);
        const merged: ProviderResponse = usage ? { ...resolved, usage } : resolved;
        if (cmpBlocks.length > 0) merged.reasoningBlocks = cmpBlocks;
        return merged;
      }
    }

    const finalResp: ProviderResponse = {
      assistantMessage: cmpStripped,
      toolCalls: parsedToolCalls,
      ...(usage ? { usage } : {}),
    };
    if (cmpBlocks.length > 0) finalResp.reasoningBlocks = cmpBlocks;
    return finalResp;
  }

  async *generateStream(request: ProviderRequest): AsyncGenerator<StreamChunk> {
    const pool = this.config.credentialPool;
    const tokenProvider = this.config.tokenProvider;
    let apiKey = tokenProvider
      ? await tokenProvider()
      : pool
      ? pool.getKey()
      : this.config.apiKey;

    if (!apiKey) {
      const echo = new EchoProvider();
      yield* echo.generateStream(request);
      return;
    }
    let activeApiKey = apiKey;

    const isResponsesApi = this.getEndpointUrl().endsWith('/responses');
    // Issue #56: Strip stale budget warnings before sending to model.
    const sanitizedMessages = stripStaleBudgetWarnings(request.messages);
    const mappedMessages = sanitizedMessages.map((message) => {
      if (message.role === 'tool') {
        return {
          role: 'user',
          content: `[Tool result: ${message.name ?? 'tool'}]\n${message.content}`
        };
      }
      return {
        role: message.role,
        content: message.content,
      };
    });

    const body: Record<string, unknown> = {
      model: this.config.model,
      stream: true,
      ...(this.config.extraBodyFields ?? {}),
    };
    applyOpenAITokenAndSamplingFields(body, {
      model: this.config.model,
      isResponsesApi,
      maxTokens: request.maxTokens ?? this.config.maxTokens,
      temperature: request.temperature ?? this.config.temperature,
      reasoningEffort: this.config.reasoningEffort,
    });
    applyPromptCacheFields(body, this.config, request);
    applyOpenRouterCacheFields(body, this.config);

    if (isResponsesApi) {
      const useInstructions = !!this.config.systemPromptAsInstructions;
      if (useInstructions && request.systemPrompt) {
        body.instructions = request.systemPrompt;
        body.input = [...mappedMessages];
      } else {
        body.input = [
          ...(request.systemPrompt ? [{ role: 'developer', content: request.systemPrompt }] : []),
          ...mappedMessages,
        ];
      }
    } else {
      body.messages = [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    }

    if (request.availableTools.length > 0) {
      const stableTools = stableToolsForPromptCache(request.availableTools);
      body.tools = isResponsesApi
        ? buildResponsesApiTools(stableTools)
        : buildOpenAITools(stableTools);
      body.tool_choice = 'auto';
    }

    const performFetch = async (bearer: string) =>
      fetch(this.getEndpointUrl(), {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${bearer}`,
          'content-type': 'application/json',
          ...(this.config.extraHeaders ?? {}),
        },
        body: JSON.stringify(body),
        signal: request.signal,
      });

    const retryConfig = disableSameKeyRetryForCredentialPool(this.config, pool);
    let response = await fetchOpenAIWithRetry(() => performFetch(activeApiKey), retryConfig, request.signal);

    if (response.status === 401 && this.config.onAuthFailure) {
      const refreshed = await this.config.onAuthFailure();
      if (refreshed && tokenProvider) {
        activeApiKey = await tokenProvider();
        response = await fetchOpenAIWithRetry(() => performFetch(activeApiKey), retryConfig, request.signal);
      }
    }

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(activeApiKey, response.status);
      }
      const errBody = await response.text().catch(() => '');
      yield { type: 'error', error: `Provider request failed: ${response.status} ${response.statusText}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}` };
      return;
    }

    if (pool) {
      pool.reportSuccess(activeApiKey);
      checkRateLimitHeaders(response.headers, pool, activeApiKey);
    }

    if (!response.body) {
      yield { type: 'error', error: 'Response body is null' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolAccumulators = new Map<number, { name: string; args: string; id?: string }>();

    // v0.8.0 (#231 / #236): per-stream reasoning parser. Every text delta
    // flows through this state machine before being yielded so `<plan>` /
    // `<think>` regions are emitted as `reasoning_*` chunks and Hermes-style
    // `<tool_call>` payloads (inside or outside a reasoning block) are
    // promoted to synthetic tool_use_* chunks.
    const reasoningParser = new StreamingReasoningParser();
    const hermesIdSeed = { count: 0 };

    // v0.8.0 (#232): repair-aware finalization for streamed tool args. Returns
    // the (possibly-repaired) JSON string so downstream consumers parse the
    // recovered payload rather than the truncated one. Telemetry fires via
    // `config.onArgsRepaired` so the runtime can re-emit `tool:args_repaired`.
    const onArgsRepaired = this.config.onArgsRepaired;
    const finalizeStreamArgs = (toolName: string, args: string): string => {
      if (!args) return args;
      try {
        const result = repairJson(args);
        emitRepairTelemetry(result, args, toolName, onArgsRepaired);
        if (result.repaired) return JSON.stringify(result.value);
        return args;
      } catch {
        return args;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            // Drain the reasoning parser so any trailing buffered text /
            // unclosed reasoning region surfaces before we emit `done`.
            yield* reasoningEventsToChunks(reasoningParser.flush(), hermesIdSeed, request.availableTools);
            for (const [, acc] of toolAccumulators) {
              yield { type: 'tool_use_end', toolName: acc.name, toolInput: finalizeStreamArgs(acc.name, acc.args) };
            }
            toolAccumulators.clear();
            yield { type: 'done' };
            return;
          }

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          // Responses API streaming: events have { type: 'response.output_text.delta', delta: '...' }
          const eventType = parsed.type as string | undefined;
          if (isResponsesApi && eventType) {
            if (eventType === 'response.output_text.delta' && typeof parsed.delta === 'string') {
              yield* reasoningEventsToChunks(reasoningParser.feed(parsed.delta), hermesIdSeed, request.availableTools);
            } else if (eventType === 'response.function_call_arguments.delta' && typeof parsed.delta === 'string') {
              // Route delta to the correct tool accumulator by output_index
              const outputIdx = typeof parsed.output_index === 'number' ? parsed.output_index : toolAccumulators.size - 1;
              const acc = toolAccumulators.get(outputIdx) ?? [...toolAccumulators.values()].at(-1);
              if (acc) {
                acc.args += parsed.delta;
                yield { type: 'tool_use_delta', toolInput: parsed.delta };
              }
            } else if (eventType === 'response.output_item.added') {
              const item = parsed.item as { type?: string; name?: string; call_id?: string } | undefined;
              const outputIdx = typeof parsed.output_index === 'number' ? parsed.output_index : toolAccumulators.size;
              if (item?.type === 'function_call' && item.name) {
                const originalName = request.availableTools.find((t) => sanitizeToolName(t.name) === item.name)?.name ?? item.name;
                toolAccumulators.set(outputIdx, { name: originalName, args: '', id: item.call_id });
                yield { type: 'tool_use_start', toolName: originalName, toolCallId: item.call_id };
              }
            } else if (eventType === 'response.output_item.done') {
              const item = parsed.item as { type?: string } | undefined;
              const doneIdx = typeof parsed.output_index === 'number' ? parsed.output_index : undefined;
              if (item?.type === 'function_call') {
                const acc = doneIdx !== undefined ? toolAccumulators.get(doneIdx) : [...toolAccumulators.values()].at(-1);
                if (acc) {
                  yield { type: 'tool_use_end', toolName: acc.name, toolInput: finalizeStreamArgs(acc.name, acc.args) };
                  if (doneIdx !== undefined) toolAccumulators.delete(doneIdx);
                }
              }
            } else if (eventType === 'response.completed' || eventType === 'response.done') {
              yield* reasoningEventsToChunks(reasoningParser.flush(), hermesIdSeed, request.availableTools);
              for (const [, acc] of toolAccumulators) {
                yield { type: 'tool_use_end', toolName: acc.name, toolInput: finalizeStreamArgs(acc.name, acc.args) };
              }
              toolAccumulators.clear();
              yield { type: 'done' };
              return;
            }
            continue;
          }

          // Standard Chat Completions streaming
          const choices = parsed.choices as Array<Record<string, unknown>> | undefined;
          const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
          const finishReason = choices?.[0]?.finish_reason as string | undefined;

          // v0.9.0 (#330): OpenRouter (and OpenAI when `stream_options.include_usage`
          // is set) emits a trailing chunk whose `choices` array is empty but
          // whose top-level `usage` carries the cache-hit accounting. Forward
          // those numbers to the telemetry hook so the dashboard can show
          // hit / miss totals on streaming requests too.
          if (parsed.usage && (!choices || choices.length === 0)) {
            emitOpenRouterCacheTelemetry(this.config, parsed.usage as ChatCompletionsResponse['usage']);
          }

          if (delta?.content && typeof delta.content === 'string') {
            // v0.8.0 (#231): route every text delta through the reasoning
            // parser so `<plan>...</plan>` regions are emitted as
            // reasoning_* chunks instead of plain text.
            yield* reasoningEventsToChunks(reasoningParser.feed(delta.content), hermesIdSeed, request.availableTools);
          }

          if (delta?.tool_calls && Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls as Array<Record<string, unknown>>) {
              const idx = (tc.index as number) ?? 0;
              const fn = tc.function as { name?: string; arguments?: string } | undefined;
              if (fn?.name) {
                const originalName = request.availableTools.find((t) => sanitizeToolName(t.name) === fn.name)?.name ?? fn.name;
                toolAccumulators.set(idx, { name: originalName, args: '', id: tc.id as string | undefined });
                yield { type: 'tool_use_start', toolName: originalName, toolCallId: tc.id as string | undefined };
              }
              if (fn?.arguments) {
                const acc = toolAccumulators.get(idx);
                if (acc) {
                  acc.args += fn.arguments;
                  yield { type: 'tool_use_delta', toolInput: fn.arguments };
                }
              }
            }
          }

          if (finishReason === 'tool_calls' || finishReason === 'stop') {
            // v0.8.0 (#231): drain any text still buffered in the reasoning
            // parser before we emit the final tool_use_end events. Closes
            // unclosed regions cleanly so the dashboard doesn't show a
            // dangling reasoning block.
            yield* reasoningEventsToChunks(reasoningParser.flush(), hermesIdSeed, request.availableTools);
            for (const [, acc] of toolAccumulators) {
              yield { type: 'tool_use_end', toolName: acc.name, toolInput: finalizeStreamArgs(acc.name, acc.args) };
            }
            toolAccumulators.clear();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Final safety flush — covers streams that ended without [DONE] / finish_reason.
    yield* reasoningEventsToChunks(reasoningParser.flush(), hermesIdSeed, request.availableTools);
    yield { type: 'done' };
  }

  /**
   * v0.8.0 Hermes parity (#237): JSON-schema-typed generation. On
   * api.openai.com gpt-4o / gpt-4.1 / gpt-5 / reasoning family models, uses the native
   * `response_format: json_schema` mode (strict). Everything else falls back
   * to a system-prompt envelope that embeds the schema. Providers that set
   * `requireStream` (notably ChatGPT/Codex) also use the envelope path because
   * native structured-output calls are non-streaming.
   *
   * Failures are surfaced as a typed envelope (`ok: false`) rather than
   * thrown, so route handlers can render a structured error in the dashboard
   * without try/catching the whole call.
   */
  async generateStructured<T = unknown>(req: StructuredOutputRequest<T>): Promise<StructuredOutputResponse<T>> {
    const useNativeJsonSchema = supportsNativeJsonSchema(this.config.baseUrl, this.config.model);

    if (useNativeJsonSchema && !this.config.requireStream) {
      try {
        return await this.callNativeStructured<T>(req);
      } catch (err) {
        return { ok: false, error: 'provider', details: err instanceof Error ? err.message : String(err) };
      }
    }

    // Schema-block envelope path: prepend a system-prompt instruction.
    const systemMessage = buildSchemaSystemPrompt(req.schema, req.schemaDescription);
    const augmentedMessages: ConversationMessage[] = [
      { role: 'system', content: systemMessage, createdAt: new Date().toISOString() },
      ...req.messages,
    ];

    let response: ProviderResponse;
    try {
      response = await this.generate({
        messages: augmentedMessages,
        availableTools: [],
      });
    } catch (err) {
      return { ok: false, error: 'provider', details: err instanceof Error ? err.message : String(err) };
    }

    return finalizeStructuredResponse<T>(response.assistantMessage ?? '', req);
  }

  /** Native json_schema path for OpenAI gpt-4o / gpt-4.1 / gpt-5 / reasoning families. */
  private async callNativeStructured<T>(req: StructuredOutputRequest<T>): Promise<StructuredOutputResponse<T>> {
    const pool = this.config.credentialPool;
    const tokenProvider = this.config.tokenProvider;
    const apiKey = tokenProvider
      ? await tokenProvider()
      : pool
      ? pool.getKey()
      : this.config.apiKey;

    if (!apiKey) {
      // No key — fall back to the envelope path (Echo provider) so hermetic
      // / no-key flows still produce a typed response.
      const systemMessage = buildSchemaSystemPrompt(req.schema, req.schemaDescription);
      const augmentedMessages: ConversationMessage[] = [
        { role: 'system', content: systemMessage, createdAt: new Date().toISOString() },
        ...req.messages,
      ];
      const echo = new EchoProvider();
      const response = await echo.generate({ messages: augmentedMessages, availableTools: [] });
      return finalizeStructuredResponse<T>(response.assistantMessage ?? '', req);
    }

    const mappedMessages = req.messages.map((message) => ({
      role: message.role === 'tool' ? 'user' : message.role,
      content: message.role === 'tool'
        ? `[Tool result: ${message.name ?? 'tool'}]\n${message.content}`
        : message.content,
    }));

    const isResponsesApi = this.getEndpointUrl().endsWith('/responses');
    const body: Record<string, unknown> = {
      model: this.config.model,
      ...(this.config.extraBodyFields ?? {}),
    };

    applyOpenAITokenAndSamplingFields(body, {
      model: this.config.model,
      isResponsesApi,
      maxTokens: this.config.maxTokens,
      temperature: this.config.temperature,
      reasoningEffort: this.config.reasoningEffort,
    });
    applyPromptCacheFields(body, this.config, {
      messages: req.messages,
      systemPrompt: req.messages.find((message) => message.role === 'system')?.content,
      availableTools: [],
    });
    // v0.9.0 (#330): structured-output path may also target OpenRouter; the
    // request body still goes through the same OpenAI-compatible surface and
    // benefits from the same cache breakpoint.
    applyOpenRouterCacheFields(body, this.config);

    if (isResponsesApi) {
      body.input = mappedMessages;
      body.text = {
        format: {
          type: 'json_schema',
          name: 'output',
          schema: req.schema,
          strict: true,
        },
      };
    } else {
      body.messages = mappedMessages;
      body.response_format = {
        type: 'json_schema',
        json_schema: {
          name: 'output',
          schema: req.schema,
          strict: true,
        },
      };
    }

    const response = await fetch(this.getEndpointUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        ...(this.config.extraHeaders ?? {}),
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errBody = await response.text().catch(() => '');
      return { ok: false, error: 'provider', details: `${response.status} ${response.statusText}${errBody ? ` — ${errBody.slice(0, 200)}` : ''}` };
    }

    const payload = (await response.json()) as Record<string, unknown>;
    const text = isResponsesApi
      ? extractResponsesOutputText(payload)
      : normalizeOpenAIMessageContent((payload as ChatCompletionsResponse).choices?.[0]?.message?.content) ?? '';
    return finalizeStructuredResponse<T>(text, req);
  }
}

export class AnthropicProvider implements ProviderAdapter, StreamingProviderAdapter {
  constructor(private readonly config: AnthropicConfig) {}

  /** Issue #72: Validate an Anthropic key. Static so callers can check
   *  before constructing the provider. */
  static validateKey(key: string): KeyValidationResult {
    return validateAnthropicKey(key);
  }

  /** Create a copy with a different model (same API key and base URL) */
  withModel(model: string): AnthropicProvider {
    return new AnthropicProvider({ ...this.config, model });
  }

  getModel(): string {
    return this.config.model;
  }

  /** Estimate token count for messages (~3.5 chars per token for Anthropic models) */
  countTokens(messages: ConversationMessage[]): number {
    const chars = countMessageChars(messages);
    return Math.ceil(chars / 3.5);
  }

  /**
   * Issue #60: Resolve this provider's effective context window. Consults the
   * remote manifest lazily; falls back to hardcoded values on any failure.
   */
  async getContextWindow(): Promise<number> {
    return resolveContextWindowAsync(this.config.model, {
      ...(this.config.manifestUrl ? { manifestUrl: this.config.manifestUrl } : {}),
      ...(this.config.manifestCache ? { cache: this.config.manifestCache } : {}),
    });
  }

  /**
   * Issue #56: Claude already follows tool-use semantics well. Returns null
   * by default; operators can subclass to extend with their own guidance.
   */
  getToolUseGuidance(_modelId: string): string | null {
    return null;
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      return new EchoProvider().generate(request);
    }

    // Issue #56: Strip stale budget warnings before sending to model.
    const sanitizedMessages = stripStaleBudgetWarnings(request.messages);
    const anthropicMessages = buildAnthropicMessages(sanitizedMessages);

    // v0.9.0 (#336): Resolve the cache_control breakpoint once so the system
    // block and the trailing tool both carry an identical TTL marker.
    const cacheControl = resolveAnthropicCacheControl(this.config);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 4096,
      messages: anthropicMessages
    };

    if (request.systemPrompt) {
      body.system = cacheControl
        ? buildCachedAnthropicSystem(request.systemPrompt, cacheControl)
        : request.systemPrompt;
    }

    if (request.availableTools.length > 0) {
      const tools = buildAnthropicTools(request.availableTools);
      if (cacheControl) applyAnthropicCacheControlToTools(tools, cacheControl);
      body.tools = tools;
    }

    const anthropicBeta = buildAnthropicBetaHeader(this.config);
    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {})
      },
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(apiKey, response.status);
      }
      throw new Error(`Anthropic request failed: ${response.status} ${response.statusText}`);
    }

    if (pool) {
      pool.reportSuccess(apiKey);
      checkRateLimitHeaders(response.headers, pool, apiKey);
    }

    const payload = (await response.json()) as AnthropicMessagesResponse;
    const usage = extractAnthropicUsage(payload);
    // v0.9.0 (#336): forward TTL-tagged cache hit / miss counts.
    emitAnthropicCacheTelemetry(this.config, payload.usage);

    // Extract text content
    const assistantMessage = payload.content
      ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n') || undefined;

    // v0.8.0 (#231): map native Anthropic `thinking` content blocks into the
    // shared ReasoningBlock shape so the dashboard renders them identically
    // to Hermes <thinking> regions.
    const thinkingBlocks: ReasoningBlock[] = [];
    if (Array.isArray(payload.content)) {
      let cursor = 0;
      for (const part of payload.content) {
        if ((part.type === 'thinking' || part.type === 'redacted_thinking') && typeof (part as { thinking?: string }).thinking === 'string') {
          const content = (part as { thinking: string }).thinking;
          // Synthetic range — Anthropic doesn't expose offsets and we never
          // concatenated the thinking text into assistantMessage, so the
          // numbers are placeholders the dashboard can sort by.
          thinkingBlocks.push({
            tag: 'thinking',
            content,
            range: [cursor, cursor + content.length],
          });
          cursor += content.length;
        }
      }
    }

    // Extract tool_use blocks
    const toolCalls = parseAnthropicToolCalls(payload.content);

    // If the API returned native tool calls, use them
    if (toolCalls && toolCalls.length > 0) {
      const resp: ProviderResponse = {
        assistantMessage,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
      if (thinkingBlocks.length > 0) resp.reasoningBlocks = thinkingBlocks;
      return resp;
    }

    // v0.8.0 (#236): Hermes-style XML tool_call fallback. A few Claude finetunes
    // route their tool calls through `<tool_call>` blocks instead of the native
    // tool_use slot. Apply the same precedence as the OpenAI path: only run
    // when no native tool_use was emitted.
    if (assistantMessage) {
      const hermesCalls = parseHermesToolCallSpans(assistantMessage, request.availableTools);
      if (hermesCalls && hermesCalls.length > 0) {
        const resp: ProviderResponse = {
          assistantMessage,
          toolCalls: hermesCalls,
          ...(usage ? { usage } : {}),
        };
        if (thinkingBlocks.length > 0) resp.reasoningBlocks = thinkingBlocks;
        return resp;
      }
    }

    // Fallback: parse slash tool calls from text when no native tool_use blocks
    if (assistantMessage) {
      const slashToolCall = parseSlashToolCall(assistantMessage.trim());
      if (slashToolCall) {
        const resolved = resolveKnownTool(slashToolCall, request.availableTools);
        const resp: ProviderResponse = usage ? { ...resolved, usage } : resolved;
        if (thinkingBlocks.length > 0) resp.reasoningBlocks = thinkingBlocks;
        return resp;
      }
    }

    const resp: ProviderResponse = {
      assistantMessage,
      ...(usage ? { usage } : {}),
    };
    if (thinkingBlocks.length > 0) resp.reasoningBlocks = thinkingBlocks;
    return resp;
  }

  async *generateStream(request: ProviderRequest): AsyncGenerator<StreamChunk> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      const echo = new EchoProvider();
      yield* echo.generateStream(request);
      return;
    }

    // Issue #56: Strip stale budget warnings before sending to model.
    const sanitizedMessages = stripStaleBudgetWarnings(request.messages);
    const anthropicMessages = buildAnthropicMessages(sanitizedMessages);

    // v0.9.0 (#336): mirror the cache_control + beta-header resolution from
    // the non-streaming path so streaming calls benefit from the same
    // prompt-cache breakpoints.
    const cacheControl = resolveAnthropicCacheControl(this.config);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 4096,
      stream: true,
      messages: anthropicMessages
    };

    if (request.systemPrompt) {
      body.system = cacheControl
        ? buildCachedAnthropicSystem(request.systemPrompt, cacheControl)
        : request.systemPrompt;
    }

    if (request.availableTools.length > 0) {
      const tools = buildAnthropicTools(request.availableTools);
      if (cacheControl) applyAnthropicCacheControlToTools(tools, cacheControl);
      body.tools = tools;
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/messages`;
    const anthropicBeta = buildAnthropicBetaHeader(this.config);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(anthropicBeta ? { 'anthropic-beta': anthropicBeta } : {})
      },
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(apiKey, response.status);
      }
      yield { type: 'error', error: `Anthropic request failed: ${response.status} ${response.statusText}` };
      return;
    }

    if (pool) {
      pool.reportSuccess(apiKey);
      checkRateLimitHeaders(response.headers, pool, apiKey);
    }

    if (!response.body) {
      yield { type: 'error', error: 'Response body is null' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentToolName = '';
    let currentToolId = '';
    let currentToolInput = '';
    // v0.8.0 (#231): track whether the active Anthropic content block is a
    // native `thinking` block so deltas can be rerouted to reasoning_* chunks
    // and a matching reasoning_end is emitted on `content_block_stop`. We
    // deliberately do NOT run the XML reasoning parser on Anthropic streams
    // — the API already structures the data for us.
    let currentThinkingTag: string | null = null;

    // v0.8.0 (#232): repair-aware finalization for Anthropic streamed tool args.
    const onArgsRepaired = this.config.onArgsRepaired;
    const finalizeStreamArgs = (toolName: string, args: string): string => {
      if (!args) return args;
      try {
        const result = repairJson(args);
        emitRepairTelemetry(result, args, toolName, onArgsRepaired);
        if (result.repaired) return JSON.stringify(result.value);
        return args;
      } catch {
        return args;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        let currentEvent = '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7).trim();
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;
          const data = trimmed.slice(6).trim();

          let parsed: Record<string, unknown>;
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          switch (currentEvent) {
            case 'content_block_start': {
              const contentBlock = parsed.content_block as { type?: string; name?: string; id?: string; text?: string } | undefined;
              if (contentBlock?.type === 'tool_use') {
                currentToolName = contentBlock.name ?? '';
                currentToolId = contentBlock.id ?? '';
                currentToolInput = '';
                yield { type: 'tool_use_start', toolName: currentToolName, toolCallId: currentToolId };
              } else if (contentBlock?.type === 'thinking' || contentBlock?.type === 'redacted_thinking') {
                // v0.8.0 (#231): native Anthropic reasoning content. Surface
                // it under the `thinking` tag so the dashboard reasoning-block
                // component renders it identically to Hermes <thinking>.
                currentThinkingTag = 'thinking';
                yield { type: 'reasoning_start', reasoningTag: 'thinking' };
              }
              break;
            }

            case 'content_block_delta': {
              const delta = parsed.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text', text: delta.text };
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                currentToolInput += delta.partial_json;
                yield { type: 'tool_use_delta', toolInput: delta.partial_json };
              } else if ((delta?.type === 'thinking_delta' || delta?.type === 'redacted_thinking_delta') && currentThinkingTag) {
                // Anthropic emits thinking content as either `delta.thinking`
                // (text) or `delta.partial_json` (rare for redacted blocks).
                const text = delta.thinking ?? delta.partial_json ?? '';
                if (text) yield { type: 'reasoning_delta', text };
              }
              break;
            }

            case 'content_block_stop': {
              if (currentToolName) {
                yield { type: 'tool_use_end', toolName: currentToolName, toolInput: finalizeStreamArgs(currentToolName, currentToolInput), toolCallId: currentToolId };
                currentToolName = '';
                currentToolId = '';
                currentToolInput = '';
              } else if (currentThinkingTag) {
                yield { type: 'reasoning_end', reasoningTag: currentThinkingTag };
                currentThinkingTag = null;
              }
              break;
            }

            case 'message_start': {
              // v0.9.0 (#336): Anthropic delivers cache_creation /
              // cache_read counts on the `message_start` event for streaming
              // requests. Forward to telemetry once per stream so the
              // dashboard can record per-request TTL + hit metadata.
              const startMsg = parsed.message as { usage?: AnthropicMessagesResponse['usage'] } | undefined;
              emitAnthropicCacheTelemetry(this.config, startMsg?.usage);
              break;
            }

            case 'message_stop': {
              yield { type: 'done' };
              return;
            }

            case 'error': {
              const errorObj = parsed.error as { message?: string } | undefined;
              yield { type: 'error', error: errorObj?.message ?? 'Anthropic stream error' };
              return;
            }

            default:
              // message_delta, ping — skip
              break;
          }

          currentEvent = '';
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  }

  /**
   * v0.8.0 Hermes parity (#237): JSON-schema-typed generation. Anthropic has
   * no native JSON-schema mode, so we always inject a schema-block envelope
   * via the system prompt.
   */
  async generateStructured<T = unknown>(req: StructuredOutputRequest<T>): Promise<StructuredOutputResponse<T>> {
    const systemMessage = buildSchemaSystemPrompt(req.schema, req.schemaDescription);
    const augmentedMessages: ConversationMessage[] = [
      { role: 'system', content: systemMessage, createdAt: new Date().toISOString() },
      ...req.messages,
    ];

    let response: ProviderResponse;
    try {
      response = await this.generate({
        messages: augmentedMessages,
        availableTools: [],
      });
    } catch (err) {
      return { ok: false, error: 'provider', details: err instanceof Error ? err.message : String(err) };
    }

    return finalizeStructuredResponse<T>(response.assistantMessage ?? '', req);
  }
}

export interface ProviderChainOptions {
  providers: ProviderAdapter[];
  shouldFallbackOnError?: (error: unknown, providerIndex: number) => boolean;
}

export class ProviderChain implements ProviderAdapter {
  private readonly providers: ProviderAdapter[];
  private readonly shouldFallbackOnError: (error: unknown, providerIndex: number) => boolean;

  constructor(options: ProviderChainOptions) {
    this.providers = options.providers;
    this.shouldFallbackOnError = options.shouldFallbackOnError ?? (() => true);
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    let lastError: unknown;
    for (let index = 0; index < this.providers.length; index += 1) {
      const provider = this.providers[index]!;
      try {
        return await provider.generate(request);
      } catch (error) {
        lastError = error;
        if (!this.shouldFallbackOnError(error, index)) {
          throw error;
        }
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'Provider chain failed.'));
  }
}

// ---------------------------------------------------------------------------
// Model metadata catalog (50+ models)
// ---------------------------------------------------------------------------

const modelMetadataCatalog: Record<string, ModelMetadata> = {
  // ---- OpenAI ----
  'gpt-4.1': {
    id: 'gpt-4.1',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2,
    outputCostPerMillion: 8
  },
  'gpt-4.1-mini': {
    id: 'gpt-4.1-mini',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.4,
    outputCostPerMillion: 1.6
  },
  'gpt-4.1-nano': {
    id: 'gpt-4.1-nano',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.4
  },
  'gpt-4o': {
    id: 'gpt-4o',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10
  },
  'gpt-4o-mini': {
    id: 'gpt-4o-mini',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6
  },
  'gpt-4-turbo': {
    id: 'gpt-4-turbo',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 10,
    outputCostPerMillion: 30
  },
  'gpt-3.5-turbo': {
    id: 'gpt-3.5-turbo',
    family: 'openai-compatible',
    contextWindow: 16_385,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.5,
    outputCostPerMillion: 1.5
  },
  'o1': {
    id: 'o1',
    family: 'openai-compatible',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 15,
    outputCostPerMillion: 60
  },
  'o1-mini': {
    id: 'o1-mini',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 3,
    outputCostPerMillion: 12
  },
  'o1-pro': {
    id: 'o1-pro',
    family: 'openai-compatible',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 150,
    outputCostPerMillion: 600
  },
  'o3': {
    id: 'o3',
    family: 'openai-compatible',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 10,
    outputCostPerMillion: 40
  },
  'o3-mini': {
    id: 'o3-mini',
    family: 'openai-compatible',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 1.1,
    outputCostPerMillion: 4.4
  },
  'o4-mini': {
    id: 'o4-mini',
    family: 'openai-compatible',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 1.1,
    outputCostPerMillion: 4.4
  },

  // ---- Anthropic ----
  'claude-opus-4': {
    id: 'claude-opus-4',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 15,
    outputCostPerMillion: 75
  },
  'claude-sonnet-4': {
    id: 'claude-sonnet-4',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15
  },
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15
  },
  'claude-haiku-3-5': {
    id: 'claude-haiku-3-5',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 0.8,
    outputCostPerMillion: 4
  },
  'claude-3-5-sonnet': {
    id: 'claude-3-5-sonnet',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15
  },
  'claude-3-5-haiku': {
    id: 'claude-3-5-haiku',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 0.8,
    outputCostPerMillion: 4
  },
  'claude-3-opus': {
    id: 'claude-3-opus',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: true,
    inputCostPerMillion: 15,
    outputCostPerMillion: 75
  },
  'claude-3-sonnet': {
    id: 'claude-3-sonnet',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 3,
    outputCostPerMillion: 15
  },
  'claude-3-haiku': {
    id: 'claude-3-haiku',
    family: 'anthropic',
    contextWindow: 200_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.25,
    outputCostPerMillion: 1.25
  },

  // ---- Google Gemini ----
  'gemini-2.5-pro': {
    id: 'gemini-2.5-pro',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 10
  },
  'gemini-2.5-flash': {
    id: 'gemini-2.5-flash',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6
  },
  'gemini-2.0-flash': {
    id: 'gemini-2.0-flash',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.4
  },
  'gemini-1.5-pro': {
    id: 'gemini-1.5-pro',
    family: 'openai-compatible',
    contextWindow: 2_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 1.25,
    outputCostPerMillion: 5
  },
  'gemini-1.5-flash': {
    id: 'gemini-1.5-flash',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.075,
    outputCostPerMillion: 0.3
  },

  // ---- Meta Llama ----
  'llama-3.3-70b': {
    id: 'llama-3.3-70b',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'llama-3.1-405b': {
    id: 'llama-3.1-405b',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'llama-3.1-70b': {
    id: 'llama-3.1-70b',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'llama-3.1-8b': {
    id: 'llama-3.1-8b',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'llama-4-maverick': {
    id: 'llama-4-maverick',
    family: 'openai-compatible',
    contextWindow: 1_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'llama-4-scout': {
    id: 'llama-4-scout',
    family: 'openai-compatible',
    contextWindow: 10_000_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },

  // ---- Mistral ----
  'mistral-large': {
    id: 'mistral-large',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2,
    outputCostPerMillion: 6
  },
  'mistral-small': {
    id: 'mistral-small',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.1,
    outputCostPerMillion: 0.3
  },
  'mistral-medium': {
    id: 'mistral-medium',
    family: 'openai-compatible',
    contextWindow: 32_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2.7,
    outputCostPerMillion: 8.1
  },
  'codestral': {
    id: 'codestral',
    family: 'openai-compatible',
    contextWindow: 256_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.3,
    outputCostPerMillion: 0.9
  },
  'mixtral-8x22b': {
    id: 'mixtral-8x22b',
    family: 'openai-compatible',
    contextWindow: 65_536,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },

  // ---- DeepSeek ----
  'deepseek-v3': {
    id: 'deepseek-v3',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.27,
    outputCostPerMillion: 1.1
  },
  'deepseek-r1': {
    id: 'deepseek-r1',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.55,
    outputCostPerMillion: 2.19
  },
  'deepseek-coder': {
    id: 'deepseek-coder',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.14,
    outputCostPerMillion: 0.28
  },

  // ---- Qwen ----
  'qwen-3-235b': {
    id: 'qwen-3-235b',
    family: 'openai-compatible',
    contextWindow: 131_072,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'qwen-2.5-72b': {
    id: 'qwen-2.5-72b',
    family: 'openai-compatible',
    contextWindow: 131_072,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'qwen-2.5-coder-32b': {
    id: 'qwen-2.5-coder-32b',
    family: 'openai-compatible',
    contextWindow: 131_072,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },

  // ---- Cohere ----
  'command-r-plus': {
    id: 'command-r-plus',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2.5,
    outputCostPerMillion: 10
  },
  'command-r': {
    id: 'command-r',
    family: 'openai-compatible',
    contextWindow: 128_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0.15,
    outputCostPerMillion: 0.6
  },

  // ---- Other ----
  'phi-4': {
    id: 'phi-4',
    family: 'openai-compatible',
    contextWindow: 16_384,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'dbrx': {
    id: 'dbrx',
    family: 'openai-compatible',
    contextWindow: 32_768,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'yi-large': {
    id: 'yi-large',
    family: 'openai-compatible',
    contextWindow: 32_768,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 0,
    outputCostPerMillion: 0
  },
  'jamba-1.5-large': {
    id: 'jamba-1.5-large',
    family: 'openai-compatible',
    contextWindow: 256_000,
    supportsTools: true,
    supportsPromptCaching: false,
    inputCostPerMillion: 2,
    outputCostPerMillion: 8
  }
};

/**
 * Issue #87: Set of model ids known to accept image inputs. Used by
 * `modelSupportsVision` and to enrich `ModelMetadata.vision` at lookup time
 * without rewriting every catalog entry.
 */
const VISION_CAPABLE_MODELS = new Set<string>([
  // OpenAI
  'gpt-4.1',
  'gpt-4.1-mini',
  'gpt-4.1-nano',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4-turbo',
  // Anthropic
  'claude-opus-4',
  'claude-sonnet-4',
  'claude-sonnet-4-5',
  'claude-haiku-3-5',
  'claude-3-5-sonnet',
  'claude-3-5-haiku',
  'claude-3-opus',
  // Google
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-pro',
  'gemini-1.5-flash',
  // Meta Llama 4 (multimodal)
  'llama-4-maverick',
  'llama-4-scout',
]);

export function getModelMetadata(model: string): ModelMetadata | null {
  const meta = modelMetadataCatalog[model];
  if (!meta) return null;
  // Issue #87: enrich descriptor with vision capability when known.
  return meta.vision === undefined && VISION_CAPABLE_MODELS.has(meta.id)
    ? { ...meta, vision: true }
    : meta;
}

export function listKnownModelMetadata(): ModelMetadata[] {
  return Object.values(modelMetadataCatalog).map((m) =>
    m.vision === undefined && VISION_CAPABLE_MODELS.has(m.id) ? { ...m, vision: true } : m,
  );
}

/**
 * Issue #87: Native multimodal vision routing.
 * Returns true when the given model id is known to accept image content blocks.
 * Falls back to pattern-matching on common vision-capable model name fragments.
 */
export function modelSupportsVision(model: string): boolean {
  if (VISION_CAPABLE_MODELS.has(model)) return true;
  const lower = model.toLowerCase();
  // Conservative fallback patterns — only positive matches for families that
  // are uniformly vision-capable. o-series is text-only; do not match.
  if (/^(gpt-4o|gpt-4\.1)/.test(lower)) return true;
  if (/^claude-(opus-4|sonnet-4|haiku-3-5|3-5|3-opus)/.test(lower)) return true;
  if (/^gemini-(1\.5|2\.0|2\.5)/.test(lower)) return true;
  if (/^llama-4/.test(lower)) return true;
  return false;
}

/**
 * Issue #87: Lightweight detector for image content in a ProviderRequest's
 * messages. CrowClaw's `ConversationMessage.content` is a string today, but
 * callers may attach image references via `metadata.attachments` or embed
 * provider-shaped content blocks via JSON. This helper checks both:
 *   1. `message.metadata.attachments` array containing entries of type 'image'.
 *   2. Inline content that parses as a JSON array containing `{ type: 'image' }`
 *      or `{ type: 'image_url' }` blocks (provider-native shape).
 * Returns true on the first hit.
 */
export function requestContainsImage(messages: ConversationMessage[]): boolean {
  for (const msg of messages) {
    const attachments = (msg.metadata as { attachments?: Array<{ type?: string }> } | undefined)?.attachments;
    if (Array.isArray(attachments) && attachments.some((a) => a?.type === 'image')) {
      return true;
    }
    const content = msg.content;
    if (typeof content === 'string' && content.length > 1 && (content.startsWith('[') || content.startsWith('{'))) {
      try {
        const parsed = JSON.parse(content) as unknown;
        if (Array.isArray(parsed)) {
          for (const block of parsed) {
            if (
              block && typeof block === 'object' &&
              ((block as { type?: string }).type === 'image' || (block as { type?: string }).type === 'image_url')
            ) {
              return true;
            }
          }
        }
      } catch {
        // Not JSON — ignore.
      }
    }
  }
  return false;
}

/**
 * Issue #98: Resolve the effective request timeout (ms) for a model.
 * Precedence: model-level → provider-level → global default.
 * Returns `undefined` when no level configures one (caller decides).
 */
export function resolveRequestTimeoutMs(
  model: string,
  providerDefaultMs?: number,
  globalDefaultMs?: number,
): number | undefined {
  const meta = getModelMetadata(model);
  if (meta?.requestTimeoutMs !== undefined) return meta.requestTimeoutMs;
  if (providerDefaultMs !== undefined) return providerDefaultMs;
  return globalDefaultMs;
}

/**
 * Issue #72: Per-provider API key schema validators. Each adapter exports a
 * static `validateKey` so the gateway and CLI can reject obviously wrong keys
 * up front instead of paying a network round-trip just to receive 401.
 */
export interface KeyValidationResult {
  ok: boolean;
  reason?: string;
}

export function validateAnthropicKey(key: string): KeyValidationResult {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!/^sk-ant-/.test(key)) {
    return { ok: false, reason: 'Anthropic keys must start with "sk-ant-"' };
  }
  return { ok: true };
}

export function validateOpenAIKey(key: string): KeyValidationResult {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!/^sk-/.test(key)) {
    return { ok: false, reason: 'OpenAI keys must start with "sk-"' };
  }
  // Reject Anthropic keys leaking into OpenAI config.
  if (/^sk-ant-/.test(key)) {
    return { ok: false, reason: 'This looks like an Anthropic key (sk-ant-…), not an OpenAI key' };
  }
  return { ok: true };
}

export function validateGeminiKey(key: string): KeyValidationResult {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!/^AIza/.test(key)) {
    return { ok: false, reason: 'Gemini keys must start with "AIza"' };
  }
  return { ok: true };
}

export function validateNvidiaKey(key: string): KeyValidationResult {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!/^nvapi-/.test(key)) {
    return { ok: false, reason: 'NVIDIA keys must start with "nvapi-"' };
  }
  return { ok: true };
}

export function validateXaiKey(key: string): KeyValidationResult {
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  if (!/^xai-/.test(key)) {
    return { ok: false, reason: 'xAI keys must start with "xai-"' };
  }
  return { ok: true };
}

/**
 * Validate a key against a provider name. Unknown providers (e.g. local
 * Ollama, custom OpenAI-compatible endpoints) accept any non-empty string.
 */
export function validateProviderKey(provider: string, key: string): KeyValidationResult {
  const p = provider.toLowerCase();
  if (p === 'anthropic') return validateAnthropicKey(key);
  if (p === 'openai') return validateOpenAIKey(key);
  if (p === 'gemini' || p === 'google') return validateGeminiKey(key);
  if (p === 'nvidia') return validateNvidiaKey(key);
  if (p === 'xai') return validateXaiKey(key);
  if (typeof key !== 'string' || key.length === 0) {
    return { ok: false, reason: 'API key is empty' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// resolveContextWindow
// ---------------------------------------------------------------------------

export function resolveContextWindow(model: string): number {
  // Check metadata catalog first
  const meta = modelMetadataCatalog[model];
  if (meta) {
    return meta.contextWindow;
  }

  // Fallback: pattern matching on model name
  const lower = model.toLowerCase();

  if (lower.includes('gemini-1.5-pro')) return 2_000_000;
  if (lower.includes('gemini') || lower.includes('llama-4-scout')) return 1_000_000;
  if (lower.includes('gpt-4.1')) return 1_000_000;
  if (lower.includes('claude')) return 200_000;
  if (lower.includes('o1') || lower.includes('o3') || lower.includes('o4')) return 200_000;
  if (lower.includes('codestral')) return 256_000;
  if (lower.includes('qwen')) return 131_072;
  if (lower.includes('gpt-4')) return 128_000;
  if (lower.includes('llama') || lower.includes('mistral') || lower.includes('deepseek') || lower.includes('command-r')) return 128_000;
  if (lower.includes('mixtral')) return 65_536;
  if (lower.includes('gpt-3.5')) return 16_385;
  if (lower.includes('phi')) return 16_384;

  // Default fallback
  return 128_000;
}

// ---------------------------------------------------------------------------
// Issue #60: Manifest-aware context window resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a model's context window by consulting the remote manifest first,
 * then falling back to the hardcoded `resolveContextWindow` lookup. Use this
 * when the caller can be async; sync callers keep using `resolveContextWindow`.
 *
 * Fail-open: any manifest fetch error degrades silently to the hardcoded
 * fallback, so this is safe to call from agent loops.
 */
export async function resolveContextWindowAsync(
  model: string,
  options?: { manifestUrl?: string; cache?: ManifestCache },
): Promise<number> {
  const manifest = await loadManifest(options?.manifestUrl, options?.cache);
  const entry = findModelEntry(manifest, model);
  if (entry) return entry.contextLength;
  return resolveContextWindow(model);
}

// ---------------------------------------------------------------------------
// Smart model routing
// ---------------------------------------------------------------------------

const COMPLEX_KEYWORDS = [
  'debug', 'implement', 'refactor', 'analyze', 'architecture',
  'migrate', 'deploy', 'optimize', 'security', 'review', 'design'
];

export function classifyQueryComplexity(message: string): 'simple' | 'complex' {
  // Multi-line messages are complex
  if (message.includes('\n')) {
    return 'complex';
  }

  // Messages with code markers are complex
  if (message.includes('```') || message.includes('``')) {
    return 'complex';
  }

  // Messages with URLs are complex
  if (/https?:\/\//.test(message)) {
    return 'complex';
  }

  // Long messages are complex
  if (message.length > 160) {
    return 'complex';
  }

  const wordCount = message.trim().split(/\s+/).length;
  if (wordCount > 28) {
    return 'complex';
  }

  // Messages containing complex keywords are complex
  const lower = message.toLowerCase();
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword)) {
      return 'complex';
    }
  }

  return 'simple';
}

export interface RoutingAnalysis {
  complexity: 'simple' | 'complex';
  hasTools: boolean;
  signals: string[];
  requiredCapabilities: string[];
  selectedTier: 'primary' | 'cheap';
  fallbackTier: 'primary' | 'cheap';
  recommendedModels: Array<{
    id: string;
    family: string;
    contextWindow: number;
    supportsTools: boolean;
    rationale: string;
  }>;
}

function analyzeRoutingSignals(message: string): string[] {
  const signals: string[] = [];
  const lower = message.toLowerCase();
  if (message.includes('\n')) signals.push('multi-line');
  if (message.includes('```') || message.includes('``')) signals.push('code-block');
  if (/https?:\/\//.test(message)) signals.push('url');
  if (message.length > 160) signals.push('long-message');
  if (message.trim().split(/\s+/).length > 28) signals.push('high-word-count');
  for (const keyword of COMPLEX_KEYWORDS) {
    if (lower.includes(keyword)) {
      signals.push(`keyword:${keyword}`);
    }
  }
  if (/\b(test|pytest|tsc|vitest|stack trace|traceback)\b/i.test(message)) {
    signals.push('debug-artifact');
  }
  if (/\b(tool|browser|terminal|mcp|workspace)\b/i.test(message)) {
    signals.push('tool-oriented');
  }
  return [...new Set(signals)];
}

function inferRequiredCapabilities(message: string, hasTools: boolean): string[] {
  const required = new Set<string>();
  if (hasTools) required.add('tools');
  if (/\b(code|debug|refactor|implement|test|typescript|python|terminal)\b/i.test(message)) {
    required.add('reasoning');
  }
  if (/\b(vision|image|screenshot)\b/i.test(message)) {
    required.add('vision');
  }
  if (/https?:\/\//.test(message) || /\bweb\b/i.test(message)) {
    required.add('long-context');
  }
  return [...required];
}

function recommendModelsForRouting(complexity: 'simple' | 'complex', requiredCapabilities: string[]): RoutingAnalysis['recommendedModels'] {
  const known = listKnownModelMetadata()
    .filter((item) => !requiredCapabilities.includes('tools') || item.supportsTools)
    .sort((a, b) => b.contextWindow - a.contextWindow);

  const preferred = complexity === 'complex'
    ? ['gpt-4.1', 'claude-3-7-sonnet', 'claude-3-5-sonnet', 'gpt-4o']
    : ['gpt-4o-mini', 'claude-3-5-haiku', 'gemini-2.5-flash', 'gpt-4o'];

  const picks = preferred
    .map((id) => known.find((item) => item.id === id))
    .filter((item): item is ModelMetadata => Boolean(item))
    .slice(0, 3);

  return picks.map((item) => ({
    id: item.id,
    family: item.family,
    contextWindow: item.contextWindow,
    supportsTools: item.supportsTools,
    rationale: complexity === 'complex'
      ? 'Prioritized for harder reasoning or larger context.'
      : 'Prioritized for lower-latency or lower-cost routing.'
  }));
}

export class SmartModelRouter {
  constructor(
    private primaryProvider: ProviderAdapter,
    private cheapProvider: ProviderAdapter
  ) {}

  routeRequest(request: ProviderRequest): ProviderAdapter {
    return this.explainRoute(request).selectedTier === 'primary'
      ? this.primaryProvider
      : this.cheapProvider;
  }

  explainRoute(request: ProviderRequest): RoutingAnalysis {
    const lastUserMessage = [...request.messages]
      .reverse()
      .find((m) => m.role === 'user')?.content ?? '';

    const complexity = classifyQueryComplexity(lastUserMessage);
    const hasTools = request.availableTools.length > 0;
    const signals = analyzeRoutingSignals(lastUserMessage);
    const requiredCapabilities = inferRequiredCapabilities(lastUserMessage, hasTools);
    const selectedTier = complexity === 'complex' || hasTools ? 'primary' : 'cheap';
    const fallbackTier = selectedTier === 'primary' ? 'cheap' : 'primary';
    return {
      complexity,
      hasTools,
      signals,
      requiredCapabilities,
      selectedTier,
      fallbackTier,
      recommendedModels: recommendModelsForRouting(complexity, requiredCapabilities)
    };
  }
}

// ---------------------------------------------------------------------------
// Credential pool with failover
// ---------------------------------------------------------------------------

export interface CredentialPoolOptions {
  keys: string[];
  strategy?: 'round-robin' | 'random'; // default: 'round-robin'
  cooldownMs?: number; // How long to cool down a key after rate limit (default: 60000)
  maxFailures?: number; // Max consecutive failures before key is disabled (default: 3)
}

interface KeyState {
  key: string;
  failures: number;
  cooldownUntil: Date | null;
  active: boolean;
  lastUsed: Date;
}

function maskKey(key: string): string {
  if (key.length <= 4) return '****';
  return `****${key.slice(-4)}`;
}

export class CredentialPool {
  private readonly keys: KeyState[];
  private readonly strategy: 'round-robin' | 'random';
  private readonly cooldownMs: number;
  private readonly maxFailures: number;
  private roundRobinIndex: number;

  constructor(options: CredentialPoolOptions) {
    if (options.keys.length === 0) {
      throw new Error('CredentialPool requires at least one key');
    }
    this.keys = options.keys.map((key) => ({
      key,
      failures: 0,
      cooldownUntil: null,
      active: true,
      lastUsed: new Date(0),
    }));
    this.strategy = options.strategy ?? 'round-robin';
    this.cooldownMs = options.cooldownMs ?? 60_000;
    this.maxFailures = options.maxFailures ?? 3;
    this.roundRobinIndex = 0;
  }

  /** Get next available key */
  getKey(): string {
    const now = new Date();
    const available = this.keys.filter((k) => {
      if (!k.active) return false;
      if (k.cooldownUntil && k.cooldownUntil > now) return false;
      return true;
    });

    if (available.length === 0) {
      const total = this.keys.length;
      const disabled = this.keys.filter((k) => !k.active).length;
      const coolingDown = this.keys.filter(
        (k) => k.active && k.cooldownUntil && k.cooldownUntil > now
      ).length;
      throw new Error(
        `All credential pool keys exhausted (${total} total, ${disabled} disabled, ${coolingDown} cooling down)`
      );
    }

    let selected: KeyState;
    if (this.strategy === 'random') {
      selected = available[Math.floor(Math.random() * available.length)]!;
    } else {
      // Round-robin: find the next key from the full ordered list that is available
      let picked: KeyState | null = null;
      for (let i = 0; i < this.keys.length; i++) {
        const idx = (this.roundRobinIndex + i) % this.keys.length;
        const candidate = this.keys[idx]!;
        if (available.includes(candidate)) {
          picked = candidate;
          this.roundRobinIndex = (idx + 1) % this.keys.length;
          break;
        }
      }
      selected = picked!;
    }

    selected.lastUsed = now;
    return selected.key;
  }

  /** Report a key failure (429, 503, auth error) */
  reportFailure(key: string, statusCode?: number): void {
    const state = this.keys.find((k) => k.key === key);
    if (!state) return;

    // Auth errors: immediately disable
    if (statusCode === 401 || statusCode === 403) {
      state.active = false;
      state.failures += 1;
      return;
    }

    state.failures += 1;

    // Check if max failures reached
    if (state.failures >= this.maxFailures) {
      state.active = false;
      return;
    }

    // Rate limit / server errors: set cooldown
    if (statusCode === 429 || statusCode === 503) {
      state.cooldownUntil = new Date(Date.now() + this.cooldownMs);
    }
  }

  /** Report successful use of a key */
  reportSuccess(key: string): void {
    const state = this.keys.find((k) => k.key === key);
    if (!state) return;
    state.failures = 0;
    state.cooldownUntil = null;
  }

  /** Proactively cool down a key (e.g., when x-ratelimit-remaining is 0) */
  cooldownKey(key: string, durationMs?: number): void {
    const state = this.keys.find((k) => k.key === key);
    if (!state) return;
    state.cooldownUntil = new Date(Date.now() + (durationMs ?? this.cooldownMs));
  }

  /** Get pool status (for monitoring). Keys are masked for security. */
  getStatus(): Array<{ key: string; active: boolean; failures: number; cooldownUntil?: string }> {
    return this.keys.map((k) => ({
      key: maskKey(k.key),
      active: k.active,
      failures: k.failures,
      ...(k.cooldownUntil ? { cooldownUntil: k.cooldownUntil.toISOString() } : {}),
    }));
  }

  /** Number of currently active keys (not disabled, ignores cooldown) */
  activeCount(): number {
    return this.keys.filter((k) => k.active).length;
  }

  summary(): {
    strategy: 'round-robin' | 'random';
    total: number;
    active: number;
    coolingDown: number;
    disabled: number;
    status: Array<{ key: string; active: boolean; failures: number; cooldownUntil?: string }>;
  } {
    const now = new Date();
    const status = this.getStatus();
    const active = this.activeCount();
    const coolingDown = this.keys.filter((key) => key.active && key.cooldownUntil && key.cooldownUntil > now).length;
    return {
      strategy: this.strategy,
      total: this.keys.length,
      active,
      coolingDown,
      disabled: this.keys.length - active,
      status
    };
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export { buildOpenAITools, normalizeOpenAIMessageContent, parseOpenAIFunctionCall, parseOpenAIToolCalls, countMessageChars };
export { collectStream } from '@crowclaw/core/streaming';
export type { StreamChunk, StreamingProviderAdapter } from '@crowclaw/core/streaming';

// v0.8.0 (#232): JSON repair for malformed tool-call arguments.
export { repairJson, type RepairResult } from './json-repair.js';

// Issue #60: Model manifest API
export {
  loadManifest,
  findModelEntry,
  resolveContextLengthFromManifest,
  resetManifestCache,
  DEFAULT_MANIFEST_URL,
  FALLBACK_MANIFEST,
} from './model-catalog.js';
export type {
  ModelManifest,
  ModelManifestEntry,
  ManifestCache,
  ManifestCacheEntry,
} from './model-catalog.js';

// Issue #81: Plugin manifest cold-read for fast startup
export {
  hasPluginManifestModelCatalog,
  readPluginManifestModelCatalog,
  seedManifestCacheFromPlugin,
} from './model-catalog.js';
export type { PluginManifestModelCatalog } from './model-catalog.js';

// Issue #61: Local embedding provider with tunable context size
export { LocalEmbeddingProvider } from './local-embedding-provider.js';
export type { LocalEmbeddingProviderConfig } from './local-embedding-provider.js';

// ---------------------------------------------------------------------------
// Model override abstraction
// ---------------------------------------------------------------------------

export interface ModelOverridable {
  withModel(model: string): ProviderAdapter;
  getModel(): string;
}

export function isModelOverridable(provider: ProviderAdapter): provider is ProviderAdapter & ModelOverridable {
  return 'withModel' in provider && typeof (provider as unknown as ModelOverridable).withModel === 'function';
}

// ---------------------------------------------------------------------------
// API mode resolver
// ---------------------------------------------------------------------------

export { resolveApiMode, modelSupports, getEndpointForModel, listApiModes, getRequestShape } from './api-mode.js';
export type { ApiMode, ApiModeCapabilities, ResolvedMode, ModeRequestShape } from './api-mode.js';

// ---------------------------------------------------------------------------
// v0.6.0 issue surface
// ---------------------------------------------------------------------------
// (Symbols defined above — re-listed here purely to advertise the public API.)
// Exported names are already on the module scope; no re-export needed.

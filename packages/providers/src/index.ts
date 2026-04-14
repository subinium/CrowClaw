import type { ConversationMessage, ProviderAdapter, ProviderRequest, ProviderResponse, ProviderResponseUsage, ToolCall, ToolManifest } from '@crowclaw/core';
import { parseSlashToolCall } from '@crowclaw/core';
import type { StreamChunk, StreamingProviderAdapter } from '@crowclaw/core/streaming';
import { collectStream } from '@crowclaw/core/streaming';

export interface OpenAICompatibleConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  credentialPool?: CredentialPool;
  /** Override the API endpoint path (default: /chat/completions). Use /responses for o-series/codex models. */
  endpointPath?: string;
}

export interface AnthropicConfig {
  apiKey?: string;
  baseUrl: string;
  model: string;
  promptCaching?: boolean;
  credentialPool?: CredentialPool;
}

export interface ModelMetadata {
  id: string;
  family: 'openai-compatible' | 'anthropic';
  contextWindow: number;
  supportsTools: boolean;
  supportsPromptCaching: boolean;
  inputCostPerMillion?: number;
  outputCostPerMillion?: number;
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

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
  };
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
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

function parseOpenAIToolCalls(toolCalls: OpenAIToolCall[] | undefined, availableTools?: ToolManifest[]): ToolCall[] | undefined {
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
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(rawArguments) as Record<string, unknown>;
      } catch {
        input = { raw: rawArguments };
      }

      return { name, input } satisfies ToolCall;
    })
    .filter((value): value is ToolCall => Boolean(value));
}

function parseOpenAIFunctionCall(functionCall: OpenAIFunctionCall | undefined): ToolCall[] | undefined {
  if (!functionCall?.name) {
    return undefined;
  }

  const rawArguments = functionCall.arguments ?? '{}';
  let input: Record<string, unknown> = {};
  try {
    input = JSON.parse(rawArguments) as Record<string, unknown>;
  } catch {
    input = { raw: rawArguments };
  }

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
// Token counting helpers
// ---------------------------------------------------------------------------

function countMessageChars(messages: ConversationMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    chars += msg.content.length;
    if (msg.name) chars += msg.name.length;
    if (msg.metadata) {
      const meta = msg.metadata;
      // Count tool call arguments stored in metadata
      for (const value of Object.values(meta)) {
        if (typeof value === 'string') {
          chars += value.length;
        } else if (typeof value === 'object' && value !== null) {
          chars += JSON.stringify(value).length;
        }
      }
    }
  }
  return chars;
}

function extractOpenAIUsage(payload: ChatCompletionsResponse): ProviderResponseUsage | undefined {
  const u = payload.usage;
  if (!u) return undefined;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: u.total_tokens ?? (inputTokens + outputTokens),
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
// Providers
// ---------------------------------------------------------------------------

export class EchoProvider implements ProviderAdapter, StreamingProviderAdapter {
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
}

export class OpenAICompatibleProvider implements ProviderAdapter, StreamingProviderAdapter {
  constructor(private readonly config: OpenAICompatibleConfig) {}

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

  /** Estimate token count for messages (~4 chars per token for OpenAI models) */
  countTokens(messages: ConversationMessage[]): number {
    const chars = countMessageChars(messages);
    return Math.ceil(chars / 4);
  }

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      return new EchoProvider().generate(request);
    }

    const isResponsesApi = this.getEndpointUrl().endsWith('/responses');
    const mappedMessages = request.messages.map((message) => {
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
    };

    if (isResponsesApi) {
      // Responses API: use `input` instead of `messages`, `developer` instead of `system`
      body.input = [
        ...(request.systemPrompt ? [{ role: 'developer', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    } else {
      body.messages = [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    }

    if (request.availableTools.length > 0) {
      body.tools = buildOpenAITools(request.availableTools);
      body.tool_choice = 'auto';
    }

    const response = await fetch(this.getEndpointUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(apiKey, response.status);
      }
      throw new Error(`Provider request failed: ${response.status} ${response.statusText}`);
    }

    if (pool) {
      pool.reportSuccess(apiKey);
      checkRateLimitHeaders(response.headers, pool, apiKey);
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
          let args: Record<string, unknown> = {};
          try { args = JSON.parse(item.arguments ?? '{}') as Record<string, unknown>; } catch { /* ignore */ }
          const originalName = request.availableTools.find((t) => sanitizeToolName(t.name) === item.name)?.name ?? item.name;
          toolCalls.push({ name: originalName, input: args, id: item.call_id });
        }
      }
      const rawUsage = rawPayload.usage as Record<string, number> | undefined;
      const usage = rawUsage ? {
        inputTokens: rawUsage.input_tokens ?? 0,
        outputTokens: rawUsage.output_tokens ?? 0,
        totalTokens: (rawUsage.input_tokens ?? 0) + (rawUsage.output_tokens ?? 0),
      } : undefined;
      return {
        assistantMessage: text || undefined,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        ...(usage ? { usage } : {}),
      };
    }

    // Standard Chat Completions format
    const payload = rawPayload as ChatCompletionsResponse;
    const message = payload.choices?.[0]?.message;
    const assistantMessage = normalizeOpenAIMessageContent(message?.content, message?.refusal);
    const parsedToolCalls = parseOpenAIToolCalls(message?.tool_calls, request.availableTools) ?? parseOpenAIFunctionCall(message?.function_call);
    const usage = extractOpenAIUsage(payload);

    if ((!parsedToolCalls || parsedToolCalls.length === 0) && assistantMessage) {
      const slashToolCall = parseSlashToolCall(assistantMessage.trim());
      if (slashToolCall) {
        const resolved = resolveKnownTool(slashToolCall, request.availableTools);
        return usage ? { ...resolved, usage } : resolved;
      }
    }

    return {
      assistantMessage,
      toolCalls: parsedToolCalls,
      ...(usage ? { usage } : {}),
    };
  }

  async *generateStream(request: ProviderRequest): AsyncGenerator<StreamChunk> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      const echo = new EchoProvider();
      yield* echo.generateStream(request);
      return;
    }

    const isResponsesApi = this.getEndpointUrl().endsWith('/responses');
    const mappedMessages = request.messages.map((message) => {
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
    };

    if (isResponsesApi) {
      // Responses API: use `input` instead of `messages`, `developer` instead of `system`
      body.input = [
        ...(request.systemPrompt ? [{ role: 'developer', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    } else {
      body.messages = [
        ...(request.systemPrompt ? [{ role: 'system', content: request.systemPrompt }] : []),
        ...mappedMessages,
      ];
    }

    if (request.availableTools.length > 0) {
      body.tools = buildOpenAITools(request.availableTools);
      body.tool_choice = 'auto';
    }

    const response = await fetch(this.getEndpointUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify(body),
      signal: request.signal
    });

    if (!response.ok) {
      if (pool) {
        pool.reportFailure(apiKey, response.status);
      }
      yield { type: 'error', error: `Provider request failed: ${response.status} ${response.statusText}` };
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
    const toolAccumulators = new Map<number, { name: string; args: string; id?: string }>();

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
            // Flush any remaining tool accumulators
            for (const [, acc] of toolAccumulators) {
              yield { type: 'tool_use_end', toolName: acc.name, toolInput: acc.args };
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
              yield { type: 'text', text: parsed.delta };
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
                  yield { type: 'tool_use_end', toolName: acc.name, toolInput: acc.args };
                  if (doneIdx !== undefined) toolAccumulators.delete(doneIdx);
                }
              }
            } else if (eventType === 'response.completed' || eventType === 'response.done') {
              for (const [, acc] of toolAccumulators) {
                yield { type: 'tool_use_end', toolName: acc.name, toolInput: acc.args };
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

          if (delta?.content && typeof delta.content === 'string') {
            yield { type: 'text', text: delta.content };
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
            for (const [, acc] of toolAccumulators) {
              yield { type: 'tool_use_end', toolName: acc.name, toolInput: acc.args };
            }
            toolAccumulators.clear();
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: 'done' };
  }
}

export class AnthropicProvider implements ProviderAdapter, StreamingProviderAdapter {
  constructor(private readonly config: AnthropicConfig) {}

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

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      return new EchoProvider().generate(request);
    }

    const anthropicMessages = buildAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 4096,
      messages: anthropicMessages
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.availableTools.length > 0) {
      body.tools = buildAnthropicTools(request.availableTools);
    }

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(this.config.promptCaching ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {})
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

    // Extract text content
    const assistantMessage = payload.content
      ?.filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text as string)
      .join('\n') || undefined;

    // Extract tool_use blocks
    const toolCalls = parseAnthropicToolCalls(payload.content);

    // If the API returned native tool calls, use them
    if (toolCalls && toolCalls.length > 0) {
      return {
        assistantMessage,
        toolCalls,
        ...(usage ? { usage } : {}),
      };
    }

    // Fallback: parse slash tool calls from text when no native tool_use blocks
    if (assistantMessage) {
      const slashToolCall = parseSlashToolCall(assistantMessage.trim());
      if (slashToolCall) {
        const resolved = resolveKnownTool(slashToolCall, request.availableTools);
        return usage ? { ...resolved, usage } : resolved;
      }
    }

    return {
      assistantMessage,
      ...(usage ? { usage } : {}),
    };
  }

  async *generateStream(request: ProviderRequest): AsyncGenerator<StreamChunk> {
    const pool = this.config.credentialPool;
    const apiKey = pool ? pool.getKey() : this.config.apiKey;

    if (!apiKey) {
      const echo = new EchoProvider();
      yield* echo.generateStream(request);
      return;
    }

    const anthropicMessages = buildAnthropicMessages(request.messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      max_tokens: 4096,
      stream: true,
      messages: anthropicMessages
    };

    if (request.systemPrompt) {
      body.system = request.systemPrompt;
    }

    if (request.availableTools.length > 0) {
      body.tools = buildAnthropicTools(request.availableTools);
    }

    const url = `${this.config.baseUrl.replace(/\/$/, '')}/messages`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        ...(this.config.promptCaching ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {})
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
              }
              break;
            }

            case 'content_block_delta': {
              const delta = parsed.delta as { type?: string; text?: string; partial_json?: string } | undefined;
              if (delta?.type === 'text_delta' && delta.text) {
                yield { type: 'text', text: delta.text };
              } else if (delta?.type === 'input_json_delta' && delta.partial_json) {
                currentToolInput += delta.partial_json;
                yield { type: 'tool_use_delta', toolInput: delta.partial_json };
              }
              break;
            }

            case 'content_block_stop': {
              if (currentToolName) {
                yield { type: 'tool_use_end', toolName: currentToolName, toolInput: currentToolInput, toolCallId: currentToolId };
                currentToolName = '';
                currentToolId = '';
                currentToolInput = '';
              }
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
              // message_start, message_delta, ping — skip
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

export function getModelMetadata(model: string): ModelMetadata | null {
  return modelMetadataCatalog[model] ?? null;
}

export function listKnownModelMetadata(): ModelMetadata[] {
  return Object.values(modelMetadataCatalog);
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

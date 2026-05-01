import type { ProviderRequest, ProviderResponse } from './index.js';

// ---------------------------------------------------------------------------
// Stream chunk types
// ---------------------------------------------------------------------------

export interface StreamChunk {
  type:
    | 'text'
    | 'tool_use_start'
    | 'tool_use_delta'
    | 'tool_use_end'
    | 'reasoning_start'
    | 'reasoning_delta'
    | 'reasoning_end'
    | 'done'
    | 'error';
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolCallId?: string;
  /**
   * v0.8.0 (#231): tag name for reasoning_start / reasoning_end (e.g. 'plan',
   * 'reasoning', 'reflection', 'thinking', 'think'). Lower-cased — Hermes 3 and
   * Hermes 4 mix casing and the parser normalises both forms.
   */
  reasoningTag?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Streaming provider interface
// ---------------------------------------------------------------------------

export interface StreamingProviderAdapter {
  generateStream(request: ProviderRequest): AsyncIterable<StreamChunk>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Collect a full ProviderResponse from a stream of chunks.
 * Accumulates text and tool calls, parsing tool JSON on tool_use_end.
 */
export async function collectStream(stream: AsyncIterable<StreamChunk>): Promise<ProviderResponse> {
  let text = '';
  const toolCalls: Array<{ name: string; input: Record<string, unknown> }> = [];
  let currentTool: { name: string; input: string; id?: string } | null = null;

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text':
        text += chunk.text ?? '';
        break;
      case 'tool_use_start':
        currentTool = { name: chunk.toolName ?? '', input: '', id: chunk.toolCallId };
        break;
      case 'tool_use_delta':
        if (currentTool) currentTool.input += chunk.toolInput ?? '';
        break;
      case 'tool_use_end':
        if (currentTool) {
          try {
            toolCalls.push({ name: currentTool.name, input: JSON.parse(currentTool.input || '{}') as Record<string, unknown> });
          } catch {
            toolCalls.push({ name: currentTool.name, input: { raw: currentTool.input } });
          }
          currentTool = null;
        }
        break;
      case 'reasoning_start':
      case 'reasoning_delta':
      case 'reasoning_end':
        // v0.8.0 (#231): reasoning chunks are routed by upstream consumers
        // (agent loop / runtime SSE bridge) — collectStream just discards
        // them so the final `assistantMessage` stays clean of <plan>/<think>
        // text the user shouldn't see in a turn-style response.
        break;
      case 'error':
        throw new Error(chunk.error ?? 'Stream error');
      case 'done':
        break;
    }
  }

  return {
    assistantMessage: text || undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Create a simple text stream from a string, yielding chunks of `chunkSize` characters.
 */
export async function* textStream(text: string, chunkSize?: number): AsyncGenerator<StreamChunk> {
  const size = chunkSize ?? 20;
  for (let i = 0; i < text.length; i += size) {
    yield { type: 'text', text: text.slice(i, i + size) };
  }
  yield { type: 'done' };
}

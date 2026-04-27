/**
 * #83: Provider switch hygiene.
 *
 * Different providers emit reasoning differently:
 * - DeepSeek / Anthropic-style: `<think>...</think>` blocks inside content.
 * - OpenAI o1 / Hermes: separate `reasoning_content` field captured in metadata.
 *
 * On a mid-session provider switch (fork, steer, fallback, manual switch) the
 * receiving provider may reject these blocks with a 400 (DeepSeek, Kimi). We
 * scrub them so the next provider sees clean conversation history. Mirrors
 * Hermes PR #16500.
 *
 * Scrubbing rules:
 * - Always strip on switch (the receiving provider may not understand the
 *   format). When `from === to` we still scrub if the message metadata flags
 *   it as foreign — cheap to do, prevents drift.
 * - Only assistant messages are touched. User / tool / system messages are
 *   left intact (a tool result that mentions "<think>" is data, not reasoning).
 * - Reasoning trapped inside `metadata.reasoningContent` is dropped; in-content
 *   `<think>...</think>` blocks (and the `<reasoning>` variant Hermes uses)
 *   are removed via regex. The visible answer that follows the closing tag is
 *   preserved.
 */
import type { ConversationMessage } from './index.js';

/** Regex for `<think>...</think>` and `<reasoning>...</reasoning>` blocks.
 *  Multiline + dotall via [\s\S]. Non-greedy so multiple blocks in one
 *  message are each removed individually. */
const REASONING_BLOCK_RE = /<(?:think|reasoning)>[\s\S]*?<\/(?:think|reasoning)>\s*/gi;

/** Detect bare `<think>` / `<reasoning>` (open tag w/ no close — provider
 *  truncated). Strip from the open tag to the end of the message. */
const REASONING_OPEN_TRAILING_RE = /<(?:think|reasoning)>[\s\S]*$/i;

export interface StripReasoningOptions {
  /** When true, also scrub on same-provider switches (idempotent). Default: true. */
  alwaysScrub?: boolean;
}

/**
 * Strip provider-specific reasoning content from message history when the
 * active provider changes. Returns a new array; does not mutate the input.
 *
 * @param messages    Conversation history.
 * @param fromProvider Identifier of the previously active provider (e.g. "deepseek").
 *                    Pass `undefined` if the previous provider is unknown.
 * @param toProvider  Identifier of the provider about to receive the messages.
 */
export function stripReasoningContent(
  messages: ConversationMessage[],
  fromProvider: string | undefined,
  toProvider: string,
  options: StripReasoningOptions = {},
): ConversationMessage[] {
  const alwaysScrub = options.alwaysScrub ?? true;
  // Cheap exit: same provider, scrub disabled.
  if (!alwaysScrub && fromProvider && fromProvider === toProvider) {
    return messages;
  }

  let mutated = false;
  const out = messages.map((msg) => {
    if (msg.role !== 'assistant') return msg;

    let content = msg.content;
    let metadata = msg.metadata;

    // 1. Drop reasoning_content trapped in metadata.
    if (metadata && 'reasoningContent' in metadata) {
      const { reasoningContent: _drop, ...rest } = metadata;
      void _drop;
      metadata = rest;
      mutated = true;
    }

    // 2. Strip well-formed <think>/<reasoning> blocks.
    if (REASONING_BLOCK_RE.test(content)) {
      content = content.replace(REASONING_BLOCK_RE, '');
      mutated = true;
    }

    // 3. Strip trailing unclosed open tag (provider truncation).
    if (REASONING_OPEN_TRAILING_RE.test(content)) {
      content = content.replace(REASONING_OPEN_TRAILING_RE, '');
      mutated = true;
    }

    if (content !== msg.content || metadata !== msg.metadata) {
      return { ...msg, content: content.trimStart(), metadata };
    }
    return msg;
  });

  return mutated ? out : messages;
}

/**
 * Best-effort detection of whether a single message likely contains
 * provider-specific reasoning blocks. Used by callers that want to log
 * scrubbing events.
 */
export function hasReasoningContent(msg: ConversationMessage): boolean {
  if (msg.role !== 'assistant') return false;
  if (msg.metadata && 'reasoningContent' in msg.metadata) return true;
  return /<(?:think|reasoning)>/i.test(msg.content);
}

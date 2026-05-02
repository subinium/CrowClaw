import type { ConversationMessage } from './index.js';

export interface ToolCallPair {
  callIndex: number;
  resultIndex: number;
  toolName: string;
}

/**
 * Identify tool-call / tool-result pairs in a message array.
 * A pair is an assistant message with tool_calls metadata followed by
 * a tool-role message. Returns indices of paired messages.
 */
export function identifyToolPairs(messages: ConversationMessage[]): ToolCallPair[] {
  const pairs: ToolCallPair[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const msg = messages[i];
    const next = messages[i + 1];
    if (!msg || !next) {
      continue;
    }
    if (msg.role === 'assistant' && next.role === 'tool') {
      pairs.push({
        callIndex: i,
        resultIndex: i + 1,
        toolName: next.name ?? 'unknown',
      });
    }
  }
  return pairs;
}

/**
 * Split messages into compressible and protected groups,
 * ensuring tool-call/result pairs are never split.
 *
 * Protected messages: system prefix, last N messages, and any
 * tool-call/result pairs that overlap the boundary.
 */
export function splitWithPairPreservation(
  messages: ConversationMessage[],
  keepLastN: number,
): { toCompress: ConversationMessage[]; toKeep: ConversationMessage[] } {
  if (keepLastN <= 0) {
    // Even with keepLastN=0, preserve pair integrity at the very end
    const pairs = identifyToolPairs(messages);
    if (pairs.length > 0) {
      const lastPair = pairs[pairs.length - 1];
      if (lastPair && lastPair.resultIndex === messages.length - 1) {
        // The final message is part of a pair — keep the pair
        return {
          toCompress: messages.slice(0, lastPair.callIndex),
          toKeep: messages.slice(lastPair.callIndex),
        };
      }
    }
    return { toCompress: [...messages], toKeep: [] };
  }

  // Separate system prefix
  let systemEnd = 0;
  while (systemEnd < messages.length) {
    const message = messages[systemEnd];
    if (!message || message.role !== 'system') {
      break;
    }
    systemEnd++;
  }

  const nonSystem = messages.slice(systemEnd);

  if (nonSystem.length <= keepLastN) {
    // Everything is protected
    return { toCompress: [], toKeep: [...messages] };
  }

  // Initial boundary: keep the last N non-system messages
  let boundaryIndex = nonSystem.length - keepLastN;

  // Identify tool pairs in non-system messages and expand boundary
  // to include complete pairs that cross the boundary
  const pairs = identifyToolPairs(nonSystem);
  for (const pair of pairs) {
    // If the result is in the keep zone but the call is in the compress zone,
    // expand the keep zone to include the call
    if (pair.callIndex < boundaryIndex && pair.resultIndex >= boundaryIndex) {
      boundaryIndex = pair.callIndex;
    }
  }

  const systemPrefix = messages.slice(0, systemEnd);
  const toCompress = nonSystem.slice(0, boundaryIndex);
  const toKeep = [...systemPrefix, ...nonSystem.slice(boundaryIndex)];

  return { toCompress, toKeep };
}

/**
 * Extract key facts from messages that should be flushed to memory
 * before compression (preflight flush).
 * Looks for: decisions, user preferences, important results, errors resolved.
 */
export function extractPreflightFacts(messages: ConversationMessage[]): string[] {
  const facts: string[] = [];

  for (const msg of messages) {
    const content = msg.content ?? '';

    // Tool results with content
    if (msg.role === 'tool' && content.length > 0) {
      const preview = content.slice(0, 200);
      facts.push(`Tool ${msg.name ?? 'unknown'}: ${preview}`);
    }

    // Assistant decisions/conclusions (short, definitive statements)
    if (msg.role === 'assistant' && content.length < 300 && content.length > 20) {
      if (/\b(decided|chose|confirmed|set|created|updated|fixed)\b/i.test(content)) {
        facts.push(content.slice(0, 200));
      }
    }
  }

  return facts.slice(0, 10);
}

export interface ChildSessionResult {
  childSessionId: string;
  parentSessionId: string;
  compressedMessages: ConversationMessage[];
  archivedMessageCount: number;
  preflightFacts: string[];
}

/**
 * Create a child session from compression.
 * The parent session's messages are archived (kept intact).
 * The child session gets: system prompt + compression summary + recent messages.
 */
export function createCompressionChild(
  parentSessionId: string,
  messages: ConversationMessage[],
  summary: string,
  keepLastN: number,
): ChildSessionResult {
  const childSessionId = `${parentSessionId}__c${Date.now()}`;
  const { toCompress, toKeep } = splitWithPairPreservation(messages, keepLastN);
  const preflightFacts = extractPreflightFacts(toCompress);

  // Build child messages: system + summary + kept messages
  const systemMsg = messages.find((m) => m.role === 'system');
  const compressedMessages: ConversationMessage[] = [];

  if (systemMsg) {
    compressedMessages.push(systemMsg);
  }

  compressedMessages.push({
    role: 'system',
    content: `[Compression summary from parent session ${parentSessionId}]\n${summary}`,
    createdAt: new Date().toISOString(),
    metadata: {
      compressionChild: true,
      parentSessionId,
      archivedMessageCount: toCompress.length,
    },
  });

  // Add kept messages, but skip any system messages already added
  for (const msg of toKeep) {
    if (msg.role === 'system' && msg === systemMsg) {
      continue;
    }
    compressedMessages.push(msg);
  }

  return {
    childSessionId,
    parentSessionId,
    compressedMessages,
    archivedMessageCount: toCompress.length,
    preflightFacts,
  };
}

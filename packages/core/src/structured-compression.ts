import type { ConversationMessage } from './index.js';

export interface StructuredSummary {
  resolved: string[];
  pending: string[];
  remainingWork: string[];
  keyFacts: string[];
  toolsUsed: string[];
}

export interface StructuredCompressionResult {
  messages: ConversationMessage[];
  summary: StructuredSummary;
  compressedCount: number;
}

export interface StructuredCompressionOptions {
  protectFirstMessages?: number;
  protectLastMessages?: number;
}

const TODO_PATTERN = /\b(?:todo|next|later|remaining|follow[- ]?up)\b/i;

function extractResolved(messages: ConversationMessage[]): string[] {
  const resolved: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.metadata?.ok === true) {
      const label = msg.name ?? 'tool';
      const snippet = msg.content.slice(0, 120);
      resolved.push(`${label}: ${snippet}`);
    }

    if (msg.role === 'assistant') {
      // Heuristic: assistant messages that follow a user question are answers.
      // Keep a short excerpt as a resolved item.
      const snippet = msg.content.slice(0, 120);
      if (snippet.length > 0) {
        resolved.push(`answer: ${snippet}`);
      }
    }
  }

  return resolved;
}

function extractPending(
  messages: ConversationMessage[],
  allMessages: ConversationMessage[],
): string[] {
  const pending: string[] = [];

  // Unanswered user questions: user messages with '?' that have no subsequent assistant reply
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'user' || !msg.content.includes('?')) continue;

    const globalIdx = allMessages.indexOf(msg);
    const hasAnswer = allMessages
      .slice(globalIdx + 1)
      .some((m) => m.role === 'assistant');

    if (!hasAnswer) {
      pending.push(`unanswered: ${msg.content.slice(0, 120)}`);
    }
  }

  // Failed tool calls without a subsequent retry of the same tool
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'tool') continue;
    if (msg.metadata?.ok !== false) continue;

    const toolName = msg.name ?? 'tool';
    const retried = messages
      .slice(i + 1)
      .some((m) => m.role === 'tool' && (m.name ?? 'tool') === toolName);

    if (!retried) {
      pending.push(`failed (no retry): ${toolName} - ${msg.content.slice(0, 100)}`);
    }
  }

  return pending;
}

function extractRemainingWork(messages: ConversationMessage[]): string[] {
  const remaining: string[] = [];

  for (const msg of messages) {
    if (TODO_PATTERN.test(msg.content)) {
      const snippet = msg.content.slice(0, 120);
      remaining.push(`${msg.role}: ${snippet}`);
    }
  }

  return remaining;
}

function extractKeyFacts(messages: ConversationMessage[]): string[] {
  const facts: string[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      facts.push(msg.content.slice(0, 200));
    }
  }

  return facts;
}

function extractToolsUsed(messages: ConversationMessage[]): string[] {
  const tools = new Set<string>();

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.name) {
      tools.add(msg.name);
    }
  }

  return [...tools];
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function formatStructuredSummary(summary: StructuredSummary): string {
  const sections: string[] = [];

  if (summary.resolved.length > 0) {
    sections.push(
      `## Resolved\n${summary.resolved.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  if (summary.pending.length > 0) {
    sections.push(
      `## Pending\n${summary.pending.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  if (summary.remainingWork.length > 0) {
    sections.push(
      `## Remaining Work\n${summary.remainingWork.map((r) => `- ${r}`).join('\n')}`,
    );
  }

  if (summary.keyFacts.length > 0) {
    sections.push(
      `## Key Facts\n${summary.keyFacts.map((f) => `- ${f}`).join('\n')}`,
    );
  }

  if (summary.toolsUsed.length > 0) {
    sections.push(`## Tools Used\n${summary.toolsUsed.join(', ')}`);
  }

  return sections.join('\n\n');
}

export function mergeStructuredSummaries(
  existing: StructuredSummary,
  incoming: StructuredSummary,
): StructuredSummary {
  const resolvedSet = new Set([...existing.resolved, ...incoming.resolved]);

  // Items that moved to resolved should be removed from pending/remaining
  const isResolved = (item: string) =>
    [...resolvedSet].some((r) => item.includes(r) || r.includes(item));

  const pending = dedupe([...existing.pending, ...incoming.pending]).filter(
    (p) => !isResolved(p),
  );

  const remainingWork = dedupe([
    ...existing.remainingWork,
    ...incoming.remainingWork,
  ]).filter((r) => !isResolved(r));

  return {
    resolved: dedupe([...resolvedSet]),
    pending,
    remainingWork,
    keyFacts: dedupe([...existing.keyFacts, ...incoming.keyFacts]),
    toolsUsed: dedupe([...existing.toolsUsed, ...incoming.toolsUsed]),
  };
}

export function compressWithStructure(
  messages: ConversationMessage[],
  options: StructuredCompressionOptions = {},
): StructuredCompressionResult {
  const protectFirst = options.protectFirstMessages ?? 2;
  const protectLast = options.protectLastMessages ?? 6;

  // Not enough messages to compress
  if (messages.length <= protectFirst + protectLast) {
    return {
      messages,
      summary: {
        resolved: [],
        pending: [],
        remainingWork: [],
        keyFacts: [],
        toolsUsed: [],
      },
      compressedCount: 0,
    };
  }

  const headCount = Math.min(protectFirst, messages.length);
  const tailCount = Math.min(protectLast, messages.length - headCount);

  const head = messages.slice(0, headCount);
  const tail = messages.slice(messages.length - tailCount);
  const middle = messages.slice(headCount, messages.length - tailCount);

  if (middle.length === 0) {
    return {
      messages,
      summary: {
        resolved: [],
        pending: [],
        remainingWork: [],
        keyFacts: [],
        toolsUsed: [],
      },
      compressedCount: 0,
    };
  }

  const summary: StructuredSummary = {
    resolved: extractResolved(middle),
    pending: extractPending(middle, messages),
    remainingWork: extractRemainingWork(middle),
    keyFacts: extractKeyFacts(middle),
    toolsUsed: extractToolsUsed(middle),
  };

  const summaryText = formatStructuredSummary(summary);

  const summaryMessage: ConversationMessage = {
    role: 'system',
    content: `Structured conversation summary (${middle.length} messages compressed):\n\n${summaryText}`,
    createdAt: new Date().toISOString(),
    metadata: {
      compressedCount: middle.length,
      compressionMethod: 'structured-compression',
      summary,
    },
  };

  return {
    messages: [...head, summaryMessage, ...tail],
    summary,
    compressedCount: middle.length,
  };
}

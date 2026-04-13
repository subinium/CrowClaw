// ---------------------------------------------------------------------------
// SessionController — manage active session lifecycle (abort, compact, steer)
// ---------------------------------------------------------------------------

import type { SessionState, ConversationMessage } from '@crowclaw/core';
import type { EventBus } from './event-bus.js';

export interface ActiveSession {
  sessionId: string;
  abortController: AbortController;
  startedAt: string;
  status: 'running' | 'aborting' | 'idle';
}

export interface CompactResult {
  originalMessageCount: number;
  compactedMessageCount: number;
  summary: string;
}

export interface SteerResult {
  sessionId: string;
  injectedPrompt: string;
  timestamp: string;
}

/**
 * Tracks running sessions and provides abort/compact/steer operations.
 *
 * - **abort**: signals the AbortController so the agent loop can bail out.
 * - **compact**: compresses older messages into a single summary message
 *   while keeping the system prompt and the most recent N messages.
 * - **steer**: injects a system-level directive that takes effect on the
 *   next agent turn.
 */
export class SessionController {
  private activeSessions = new Map<string, ActiveSession>();

  constructor(private eventBus?: EventBus) {}

  // -- Registration --------------------------------------------------------

  /** Track a running session. Returns the AbortController whose signal should
   *  be forwarded to the provider / tool execution layer. */
  registerSession(sessionId: string): AbortController {
    const abortController = new AbortController();
    this.activeSessions.set(sessionId, {
      sessionId,
      abortController,
      startedAt: new Date().toISOString(),
      status: 'running',
    });

    this.eventBus?.emit('session:updated', {
      sessionId,
      action: 'registered',
    });

    return abortController;
  }

  /** Remove a session from tracking (call when the run completes). */
  unregisterSession(sessionId: string): void {
    this.activeSessions.delete(sessionId);

    this.eventBus?.emit('session:updated', {
      sessionId,
      action: 'unregistered',
    });
  }

  // -- Queries -------------------------------------------------------------

  /** Snapshot of all currently tracked sessions. */
  getActiveSessions(): ActiveSession[] {
    return [...this.activeSessions.values()];
  }

  /** Whether a session is currently registered (running or aborting). */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // -- Abort ---------------------------------------------------------------

  /** Signal abort for a running session. Returns `{ aborted: true }` on
   *  success, or `{ aborted: false, reason }` if the session is not active. */
  abort(sessionId: string): { aborted: boolean; reason?: string } {
    const entry = this.activeSessions.get(sessionId);
    if (!entry) {
      return { aborted: false, reason: 'Session is not active' };
    }

    entry.abortController.abort();
    entry.status = 'aborting';

    this.eventBus?.emit('session:updated', {
      sessionId,
      action: 'aborted',
    });

    return { aborted: true };
  }

  // -- Compact -------------------------------------------------------------

  /**
   * Compress older messages into a single summary message.
   *
   * Keeps:
   *  1. The first system message (if any)
   *  2. The last `keepLastN` messages
   *
   * Everything in between is replaced by a summary message with role
   * `system`.
   */
  compact(
    session: SessionState,
    options?: { keepLastN?: number; summaryMaxLength?: number },
  ): CompactResult {
    const keepLastN = options?.keepLastN ?? 10;
    const summaryMaxLength = options?.summaryMaxLength ?? 2000;
    const messages = session.messages;
    const originalMessageCount = messages.length;

    // Nothing to compact
    if (messages.length <= keepLastN + 1) {
      return {
        originalMessageCount,
        compactedMessageCount: messages.length,
        summary: '',
      };
    }

    // Separate system prefix from the rest
    const hasSystemPrefix = messages.length > 0 && messages[0].role === 'system';
    const systemMessage = hasSystemPrefix ? messages[0] : undefined;
    const conversationMessages = hasSystemPrefix ? messages.slice(1) : messages;

    // If there are not enough non-system messages to compact, return as-is
    if (conversationMessages.length <= keepLastN) {
      return {
        originalMessageCount,
        compactedMessageCount: messages.length,
        summary: '',
      };
    }

    const toCompress = conversationMessages.slice(0, conversationMessages.length - keepLastN);
    const toKeep = conversationMessages.slice(conversationMessages.length - keepLastN);

    const rawSummary = this.buildSummary(toCompress);
    const summary = rawSummary.length > summaryMaxLength
      ? rawSummary.slice(0, summaryMaxLength) + '...'
      : rawSummary;

    const summaryMessage: ConversationMessage = {
      role: 'system',
      content: `[Compressed conversation summary]\n${summary}`,
      createdAt: new Date().toISOString(),
      metadata: {
        compressed: true,
        compressedMessageCount: toCompress.length,
      },
    };

    const compacted: ConversationMessage[] = [];
    if (systemMessage) {
      compacted.push(systemMessage);
    }
    compacted.push(summaryMessage, ...toKeep);

    session.messages = compacted;

    this.eventBus?.emit('session:updated', {
      sessionId: session.sessionId,
      action: 'compacted',
      originalMessageCount,
      compactedMessageCount: compacted.length,
    });

    return {
      originalMessageCount,
      compactedMessageCount: compacted.length,
      summary,
    };
  }

  // -- Steer ---------------------------------------------------------------

  /**
   * Inject a system-level directive into the session.
   * The directive is appended as a system message so it takes effect on the
   * next agent turn.
   */
  steer(session: SessionState, directive: string): SteerResult {
    const timestamp = new Date().toISOString();

    const steerMessage: ConversationMessage = {
      role: 'system',
      content: `[Operator directive] ${directive}`,
      createdAt: timestamp,
      metadata: { steer: true },
    };

    session.messages.push(steerMessage);

    this.eventBus?.emit('session:updated', {
      sessionId: session.sessionId,
      action: 'steered',
      directive,
    });

    return {
      sessionId: session.sessionId,
      injectedPrompt: steerMessage.content,
      timestamp,
    };
  }

  // -- Internals -----------------------------------------------------------

  /** Build a plain-text summary from a list of messages. */
  private buildSummary(messages: ConversationMessage[]): string {
    const lines: string[] = [];
    for (const msg of messages) {
      const content = msg.content ?? '';
      const tag = msg.role === 'user' ? 'User' : msg.role === 'assistant' ? 'Assistant' : msg.role;
      const preview = content.length > 200
        ? content.slice(0, 200) + '...'
        : content;
      lines.push(`${tag}: ${preview}`);
    }
    return lines.join('\n');
  }
}

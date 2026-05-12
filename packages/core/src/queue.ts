// ---------------------------------------------------------------------------
// #314 — Per-session queue of pending user-turn messages
//
// Hermes v0.13 (#18114, #20279, #20296, #20433) added `/queue` so an IDE
// plugin can stash follow-up turns while the agent is mid-iteration. The
// queue drains into the next user-turn message after the current iteration
// completes — distinct from `/steer`, which fires at iteration *start* as
// a one-shot system nudge.
//
// Semantics (mirrors the Hermes contract):
//   * `enqueue` appends a user message to the per-session pending queue.
//   * `drain` returns + clears the queue. Caller concatenates each entry
//     into the next user-turn message with `OPERATOR_QUEUE_SEPARATOR`.
//   * The queue MUST persist across session restore (issue acceptance
//     criterion: "Session restart preserves queue"). See
//     `serializeQueue` / `restoreQueue` for the atomic-write helpers.
//
// Design choice: keep the queue surface as a pure data primitive in this
// file. AgentLoop wires it into the iteration loop without owning the
// storage contract — that way scheduler / ACP / WS / dashboard can all
// `enqueue` against the same primitive.
// ---------------------------------------------------------------------------

import type { ConversationMessage } from './index.js';

/**
 * One pending message awaiting drain into the next user turn. The shape
 * is intentionally narrow — we don't carry tool calls or assistant text
 * because the queue is exclusively a *user-turn* primitive.
 */
export interface QueuedUserMessage {
  /** The user-supplied content. Concatenated into the next turn. */
  content: string;
  /** ISO timestamp when the message was queued. Used for ordering on
   *  drain and for audit-log timeline correlation. */
  queuedAt: string;
  /** Optional source label (`'acp.queue'`, `'ws.queue'`, `'rest.queue'`).
   *  The drain serializer prefixes the separator with this so an
   *  operator reviewing the next-turn message can tell which channel
   *  contributed which fragment. */
  source?: string;
  /** Optional opaque id for round-trip acknowledgements over ACP. */
  id?: string;
}

/**
 * Operator separator inserted between queued fragments when draining into
 * the next user-turn message. Mirrors the `[OPERATOR STEER]` marker on
 * the steer side — operators reading transcripts can grep for these
 * tags to see exactly where injected text begins.
 */
export const OPERATOR_QUEUE_SEPARATOR = '\n\n[OPERATOR QUEUE]\n';

/**
 * Single source of truth for the in-memory queue. Plain `Map` so callers
 * (AgentLoop, ACP server, REST handler) can share one instance without a
 * wrapper class. Storage adapters serialize via `serializeQueue` /
 * `restoreQueue`.
 */
export type PendingQueueStore = Map<string, QueuedUserMessage[]>;

/**
 * Build a fresh, empty queue store. Hosts wire one instance per AgentLoop.
 */
export function createPendingQueueStore(): PendingQueueStore {
  return new Map();
}

/**
 * Append a message to the per-session queue. Empty or whitespace-only
 * content is dropped silently — same contract as `AgentLoop.steer`.
 *
 * Returns `true` when the message was queued, `false` when it was empty
 * and dropped. ACP callers use the return value to send the right ack.
 */
export function enqueueMessage(
  store: PendingQueueStore,
  sessionId: string,
  message: QueuedUserMessage,
): boolean {
  if (!message.content || !message.content.trim()) return false;
  const existing = store.get(sessionId);
  if (existing) {
    existing.push(message);
  } else {
    store.set(sessionId, [message]);
  }
  return true;
}

/**
 * Drain and return all pending messages for `sessionId` in queue order
 * (oldest first). The slot is removed from the store after drain so the
 * same messages aren't re-applied on a subsequent iteration / restart.
 */
export function drainPendingQueue(
  store: PendingQueueStore,
  sessionId: string,
): QueuedUserMessage[] {
  const queue = store.get(sessionId);
  if (!queue || queue.length === 0) return [];
  store.delete(sessionId);
  return queue;
}

/**
 * Peek at the pending queue without draining. Useful for the dashboard
 * "show pending messages" view and for the ACP `acp.queue.list` method
 * (issue #314 follow-up — not in scope here, but the primitive supports it).
 */
export function peekPendingQueue(
  store: PendingQueueStore,
  sessionId: string,
): QueuedUserMessage[] {
  return [...(store.get(sessionId) ?? [])];
}

/**
 * Number of pending messages for a session. Cheap O(1) check used by the
 * iteration-end branch in AgentLoop to decide whether to drain.
 */
export function pendingQueueLength(
  store: PendingQueueStore,
  sessionId: string,
): number {
  return store.get(sessionId)?.length ?? 0;
}

/**
 * Concatenate drained queue messages into the next-turn user content.
 * Each fragment is preceded by `OPERATOR_QUEUE_SEPARATOR` so the model
 * sees a clearly-marked sequence of operator additions.
 *
 * The first fragment is joined onto `baseContent` without an additional
 * separator when `baseContent` is non-empty — operators expect their
 * queued text to be appended to the natural next-turn message.
 */
export function assembleNextUserMessage(
  baseContent: string,
  drained: QueuedUserMessage[],
): string {
  if (drained.length === 0) return baseContent;
  const fragments = drained
    .map((m) => `${OPERATOR_QUEUE_SEPARATOR}${m.content.trim()}`)
    .join('');
  return baseContent ? `${baseContent}${fragments}` : fragments.trimStart();
}

/**
 * Build a `system`-role conversation message that wraps the drained queue
 * for inspection in transcripts. Returned alongside the merged user turn
 * so persistence captures both: the natural user message AND a system
 * annotation explaining why the user-turn content was augmented.
 *
 * Returns `null` when nothing was drained — callers should skip the
 * annotation in that case.
 */
export function buildQueueAnnotation(
  drained: QueuedUserMessage[],
): ConversationMessage | null {
  if (drained.length === 0) return null;
  const detail = drained
    .map((m, i) => {
      const src = m.source ? ` source=${m.source}` : '';
      return `[${i + 1}/${drained.length}${src} queuedAt=${m.queuedAt}]`;
    })
    .join(' ');
  return {
    role: 'system',
    content: `[OPERATOR QUEUE DRAINED ${drained.length}] ${detail}`,
    createdAt: new Date().toISOString(),
    metadata: {
      queueDrained: true,
      count: drained.length,
      ephemeral: false,
    },
  };
}

// ---------------------------------------------------------------------------
// Persistence helpers — atomic snapshot of the per-session queue
//
// Storage adapters (file store, Durable Object, etc.) call `serializeQueue`
// at the same moment they serialize the rest of session state, and call
// `restoreQueue` on rehydrate. The pair is round-trip safe — drained
// messages do not re-appear after a restart.
// ---------------------------------------------------------------------------

export interface SerializedQueueEntry {
  sessionId: string;
  messages: QueuedUserMessage[];
}

export function serializeQueue(store: PendingQueueStore): SerializedQueueEntry[] {
  const out: SerializedQueueEntry[] = [];
  for (const [sessionId, messages] of store) {
    if (messages.length === 0) continue;
    out.push({ sessionId, messages: [...messages] });
  }
  return out;
}

export function restoreQueue(
  store: PendingQueueStore,
  data: SerializedQueueEntry[] | null | undefined,
): void {
  if (!data) return;
  for (const entry of data) {
    if (!entry.sessionId || !Array.isArray(entry.messages)) continue;
    if (entry.messages.length === 0) continue;
    store.set(entry.sessionId, [...entry.messages]);
  }
}

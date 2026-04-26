import type { ConversationMessage, SessionState, ToolExecutionResult } from './index.js';

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  iteration: number;
  createdAt: string;
  /** Snapshot of session.messages at checkpoint time. Held as a shallow array
   *  copy (slice) instead of a deep clone — the agent loop only appends to
   *  session.messages, so message objects themselves are never mutated and
   *  shallow snapshots are safe. Use messageCursor to reconstruct the
   *  historical view from a live session.messages without storing the array. */
  messages: ConversationMessage[];
  /** #45: Length of session.messages at save time. With an append-only history
   *  this is sufficient to recover the historical view via
   *  session.messages.slice(0, messageCursor) without cloning the full array. */
  messageCursor: number;
  toolResults: ToolExecutionResult[];
  metadata: {
    agentId: string;
    messageCount: number;
    toolCallCount: number;
    trigger: CheckpointTrigger;
    label?: string;
  };
  loopState?: {
    currentIteration: number;
    pendingToolCalls?: Array<{ name: string; input: Record<string, unknown> }>;
    systemPrompt?: string;
    agentPreset?: { role: string; goal: string; backstory?: string };
  };
}

export type CheckpointTrigger =
  | 'iteration'      // Auto-saved at each tool loop iteration
  | 'manual'         // User-requested
  | 'pre-dangerous'  // Before executing a dangerous tool
  | 'error'          // After a tool error
  | 'completion';    // At end of successful run

export interface CheckpointStore {
  save(checkpoint: SessionCheckpoint): Promise<void>;
  get(id: string): Promise<SessionCheckpoint | null>;
  listBySession(sessionId: string): Promise<SessionCheckpoint[]>;
  getLatest(sessionId: string): Promise<SessionCheckpoint | null>;
  delete(id: string): Promise<boolean>;
  deleteBySession(sessionId: string): Promise<number>;
}

export interface InMemoryCheckpointStoreOptions {
  /** Cap total checkpoints held in memory. FIFO eviction by insertion order
   *  keeps the newest N. Unbounded by default to preserve prior behavior,
   *  but production callers should always set this — a long-running server
   *  with autoCheckpoint on accumulates one checkpoint per iteration forever. */
  maxCheckpoints?: number;
}

export class InMemoryCheckpointStore implements CheckpointStore {
  private readonly store = new Map<string, SessionCheckpoint>();
  /** #46: Per-session secondary index of checkpoint ids in save order.
   *  Avoids O(total_checkpoints) scan + sort + clone in listBySession/getLatest. */
  private readonly bySession = new Map<string, string[]>();
  private readonly maxCheckpoints: number | undefined;

  constructor(options?: InMemoryCheckpointStoreOptions) {
    this.maxCheckpoints = options?.maxCheckpoints;
  }

  async save(checkpoint: SessionCheckpoint): Promise<void> {
    this.store.set(checkpoint.id, structuredClone(checkpoint));
    const ids = this.bySession.get(checkpoint.sessionId);
    if (ids) {
      ids.push(checkpoint.id);
    } else {
      this.bySession.set(checkpoint.sessionId, [checkpoint.id]);
    }
    // FIFO eviction: Map iteration order preserves insertion order, so
    // the first entry is always the oldest. Keep bySession in sync.
    if (this.maxCheckpoints !== undefined && this.store.size > this.maxCheckpoints) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) {
        const evicted = this.store.get(oldest);
        this.store.delete(oldest);
        if (evicted) {
          const sessionIds = this.bySession.get(evicted.sessionId);
          if (sessionIds) {
            const idx = sessionIds.indexOf(oldest);
            if (idx !== -1) sessionIds.splice(idx, 1);
            if (sessionIds.length === 0) this.bySession.delete(evicted.sessionId);
          }
        }
      }
    }
  }

  async get(id: string): Promise<SessionCheckpoint | null> {
    const cp = this.store.get(id);
    return cp ? structuredClone(cp) : null;
  }

  async listBySession(sessionId: string): Promise<SessionCheckpoint[]> {
    const ids = this.bySession.get(sessionId);
    if (!ids || ids.length === 0) return [];
    // Sort by iteration to preserve callers' previous ordering guarantees.
    // Per-session list size is small relative to total store size, so this
    // is a meaningful improvement over scanning every entry.
    const checkpoints: SessionCheckpoint[] = [];
    for (const id of ids) {
      const cp = this.store.get(id);
      if (cp) checkpoints.push(cp);
    }
    return checkpoints
      .sort((a, b) => a.iteration - b.iteration)
      .map(cp => structuredClone(cp));
  }

  async getLatest(sessionId: string): Promise<SessionCheckpoint | null> {
    const ids = this.bySession.get(sessionId);
    if (!ids || ids.length === 0) return null;
    // O(per-session) max iteration scan — much smaller than full-store walk.
    let bestId: string | undefined;
    let bestIteration = -Infinity;
    for (const id of ids) {
      const cp = this.store.get(id);
      if (!cp) continue;
      if (cp.iteration >= bestIteration) {
        bestIteration = cp.iteration;
        bestId = id;
      }
    }
    if (!bestId) return null;
    const cp = this.store.get(bestId);
    return cp ? structuredClone(cp) : null;
  }

  async delete(id: string): Promise<boolean> {
    const cp = this.store.get(id);
    const removed = this.store.delete(id);
    if (removed && cp) {
      const ids = this.bySession.get(cp.sessionId);
      if (ids) {
        const idx = ids.indexOf(id);
        if (idx !== -1) ids.splice(idx, 1);
        if (ids.length === 0) this.bySession.delete(cp.sessionId);
      }
    }
    return removed;
  }

  async deleteBySession(sessionId: string): Promise<number> {
    const ids = this.bySession.get(sessionId);
    if (!ids) return 0;
    let count = 0;
    for (const id of ids) {
      if (this.store.delete(id)) count++;
    }
    this.bySession.delete(sessionId);
    return count;
  }

  get size(): number {
    return this.store.size;
  }
}

/** Create a checkpoint from current session state.
 *
 *  #45 perf: replaces per-iteration `structuredClone(session.messages)` with
 *  a length-cursor + shallow array slice. The agent loop only appends to
 *  session.messages (never mutates earlier entries in place), so a slice of
 *  the array is a stable historical snapshot — message *objects* are still
 *  shared with the live session, but that's safe because they're treated as
 *  immutable conversation entries. `messageCursor` records the exact length
 *  for callers that want to recover the historical view from a live session
 *  via `session.messages.slice(0, messageCursor)`. `toolResults` is still
 *  deep-cloned because callers pass through accumulator arrays that they
 *  may continue to mutate after createCheckpoint returns.
 */
export function createCheckpoint(
  session: SessionState,
  toolResults: ToolExecutionResult[],
  iteration: number,
  trigger: CheckpointTrigger,
  label?: string,
  loopState?: SessionCheckpoint['loopState'],
): SessionCheckpoint {
  const messageCursor = session.messages.length;
  return {
    id: `cp-${session.sessionId}-${iteration}-${trigger}-${Date.now().toString(36)}`,
    sessionId: session.sessionId,
    iteration,
    createdAt: new Date().toISOString(),
    messages: session.messages.slice(0, messageCursor),
    messageCursor,
    toolResults: structuredClone(toolResults),
    metadata: {
      agentId: session.agentId,
      messageCount: messageCursor,
      toolCallCount: toolResults.length,
      trigger,
      label,
    },
    loopState: loopState ? structuredClone(loopState) : undefined,
  };
}

export interface RestoredSession {
  session: SessionState;
  toolResults: ToolExecutionResult[];
  loopState?: SessionCheckpoint['loopState'];
}

/** Restore a session from a checkpoint.
 *
 *  #45 perf: when the checkpoint carries a `messageCursor` and the live
 *  session.messages has at least that many entries, slice from the live
 *  session — this avoids paying the deep-clone cost again on restore for
 *  the in-memory hot path. Falls back to cloning the checkpoint's stored
 *  messages snapshot when the live session has been truncated/replaced
 *  (e.g., after compression or for a file-store round-trip).
 */
export function restoreFromCheckpoint(
  checkpoint: SessionCheckpoint,
  session: SessionState,
): RestoredSession {
  const cursor = checkpoint.messageCursor ?? checkpoint.messages.length;
  const restoredMessages = session.messages.length >= cursor
    ? session.messages.slice(0, cursor)
    : structuredClone(checkpoint.messages);
  return {
    session: {
      ...session,
      messages: restoredMessages,
      updatedAt: new Date().toISOString(),
      lineage: {
        ...(session.lineage ?? { rootSessionId: session.sessionId, compressionCount: 0 }),
        lastCompressedAt: new Date().toISOString(),
      },
    },
    toolResults: structuredClone(checkpoint.toolResults),
    loopState: checkpoint.loopState ? structuredClone(checkpoint.loopState) : undefined,
  };
}

/** Diff two checkpoints to see what changed */
export function diffCheckpoints(
  earlier: SessionCheckpoint,
  later: SessionCheckpoint,
): CheckpointDiff {
  const newMessages = later.messages.slice(earlier.messages.length);
  const newToolResults = later.toolResults.slice(earlier.toolResults.length);

  return {
    earlierId: earlier.id,
    laterId: later.id,
    iterationRange: [earlier.iteration, later.iteration],
    addedMessages: newMessages.length,
    addedToolCalls: newToolResults.length,
    newMessages,
    newToolResults,
  };
}

export interface CheckpointDiff {
  earlierId: string;
  laterId: string;
  iterationRange: [number, number];
  addedMessages: number;
  addedToolCalls: number;
  newMessages: ConversationMessage[];
  newToolResults: ToolExecutionResult[];
}

/** Replay: take a checkpoint and create a new session for re-running from that point */
export function createReplaySession(
  checkpoint: SessionCheckpoint,
  newSessionId?: string,
): SessionState {
  const sid = newSessionId ?? `replay-${checkpoint.sessionId}-${Date.now().toString(36)}`;
  return {
    agentId: checkpoint.metadata.agentId,
    sessionId: sid,
    messages: structuredClone(checkpoint.messages),
    updatedAt: new Date().toISOString(),
    lineage: {
      rootSessionId: checkpoint.sessionId,
      compressionCount: 0,
    },
  };
}

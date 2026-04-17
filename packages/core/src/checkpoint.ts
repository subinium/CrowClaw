import type { ConversationMessage, SessionState, ToolExecutionResult } from './index.js';

export interface SessionCheckpoint {
  id: string;
  sessionId: string;
  iteration: number;
  createdAt: string;
  messages: ConversationMessage[];
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
  private readonly maxCheckpoints: number | undefined;

  constructor(options?: InMemoryCheckpointStoreOptions) {
    this.maxCheckpoints = options?.maxCheckpoints;
  }

  async save(checkpoint: SessionCheckpoint): Promise<void> {
    this.store.set(checkpoint.id, structuredClone(checkpoint));
    // FIFO eviction: Map iteration order preserves insertion order, so
    // the first entry is always the oldest.
    if (this.maxCheckpoints !== undefined && this.store.size > this.maxCheckpoints) {
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  async get(id: string): Promise<SessionCheckpoint | null> {
    const cp = this.store.get(id);
    return cp ? structuredClone(cp) : null;
  }

  async listBySession(sessionId: string): Promise<SessionCheckpoint[]> {
    return [...this.store.values()]
      .filter(cp => cp.sessionId === sessionId)
      .sort((a, b) => a.iteration - b.iteration)
      .map(cp => structuredClone(cp));
  }

  async getLatest(sessionId: string): Promise<SessionCheckpoint | null> {
    const checkpoints = await this.listBySession(sessionId);
    return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  async deleteBySession(sessionId: string): Promise<number> {
    let count = 0;
    for (const [id, cp] of this.store) {
      if (cp.sessionId === sessionId) {
        this.store.delete(id);
        count++;
      }
    }
    return count;
  }

  get size(): number {
    return this.store.size;
  }
}

/** Create a checkpoint from current session state */
export function createCheckpoint(
  session: SessionState,
  toolResults: ToolExecutionResult[],
  iteration: number,
  trigger: CheckpointTrigger,
  label?: string,
  loopState?: SessionCheckpoint['loopState'],
): SessionCheckpoint {
  return {
    id: `cp-${session.sessionId}-${iteration}-${trigger}-${Date.now().toString(36)}`,
    sessionId: session.sessionId,
    iteration,
    createdAt: new Date().toISOString(),
    messages: structuredClone(session.messages),
    toolResults: structuredClone(toolResults),
    metadata: {
      agentId: session.agentId,
      messageCount: session.messages.length,
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

/** Restore a session from a checkpoint */
export function restoreFromCheckpoint(
  checkpoint: SessionCheckpoint,
  session: SessionState,
): RestoredSession {
  return {
    session: {
      ...session,
      messages: structuredClone(checkpoint.messages),
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

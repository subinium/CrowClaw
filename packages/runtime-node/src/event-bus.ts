// ---------------------------------------------------------------------------
// EventBus — publish/subscribe for real-time SSE events
// ---------------------------------------------------------------------------

export type RuntimeEventType =
  | 'chat:message'
  | 'chat:stream'
  | 'chat:complete'
  | 'chat:error'
  | 'gateway:inbound'
  | 'gateway:outbound'
  | 'gateway:error'
  | 'gateway:status'
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'session:created'
  | 'session:updated'
  // #147: discriminated lifecycle events. Previously all session lifecycle
  // changes were squashed into `session:updated` with an untyped `action`
  // discriminant — the dashboard's `onEvent` handler couldn't dispatch on
  // them and silently dropped every non-heartbeat frame. These let the UI
  // refresh the session list / inject timeline markers in real time.
  | 'session:steered'
  | 'session:aborted'
  | 'session:forked'
  | 'session:compacted'
  // v0.7 (#179) — surface tool execution to the dashboard so operators can
  // audit what the agent actually did. `tool:start` fires before the worker
  // executes; `tool:complete` fires after with `durationMs` + `ok`. Emitted
  // by the EventBus-observing wrapper around the configured ToolRegistry in
  // `createConfiguredAgent` so direct routes (e.g. /api/web/fetch) stay
  // untouched.
  | 'tool:start'
  | 'tool:complete'
  // v0.7 (#180) — surface the memory pipeline. `memory:captured` fires after
  // a session-summary write; `memory:recalled` fires after `MemoryService.recall`
  // returns. Both are wired at the agent-loop integration site only, so the
  // dashboard's MemoryStream component can show capture/recall in real time
  // without modifying every gateway/scheduler dispatch handler.
  | 'memory:captured'
  | 'memory:recalled'
  // v0.8.0 (#231) — reasoning-block extraction. `reasoning:emitted` fires when
  // a `<plan>` / `<reflection>` / `<thinking>` block is parsed from the model
  // output; carries the tag name and text. Lets the dashboard render the
  // model's reasoning lifecycle as distinct surfaces from regular assistant text.
  | 'reasoning:emitted'
  | 'plan:emitted'
  | 'reflection:emitted'
  // v0.8.0 (#232) — JSON repair telemetry. Fires when malformed tool-call args
  // are recovered by the repair pass. Lets observability track repair frequency
  // and surface chronically-malformed model behaviour.
  | 'tool:args_repaired'
  // v0.8.0 (#234) — code.execute pipeline tool lifecycle. `code:start` /
  // `code:tool_called` / `code:complete` mirror the existing `tool:*` events
  // but at sandbox granularity so the dashboard's code-execute trace can show
  // sub-tools called from within a single sandboxed run.
  | 'code:start'
  | 'code:tool_called'
  | 'code:complete'
  // v0.8.0 (#235) — structured tool-error envelope. `tool:validation_failed`
  // fires when args fail input-schema validation (no tool execution attempted).
  // `tool:repeated_failure` fires when the same (toolName, errorCode) pair has
  // failed three iterations in a row, signalling the harness exit path.
  | 'tool:validation_failed'
  | 'tool:repeated_failure'
  // v0.8.0 (#238) — self-improvement loop. Skill drafts captured / promoted
  // / agent-proposed / revised lifecycle so the dashboard's drafts tab can
  // live-update.
  | 'learning:draft_captured'
  | 'learning:draft_promoted'
  | 'learning:agent_proposed'
  | 'learning:skill_revised'
  // v0.8.0 (#239) — agent termination reason discriminator. Fires once per
  // `AgentLoop.run` exit with `{ reason: 'natural'|'budget_exhausted_with_synthesis'|'tool_error_terminal'|'aborted' }`
  // so observability can distinguish "model stopped" from "harness stopped".
  | 'agent:terminated';

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: RuntimeEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Publish an event to all subscribers. */
  emit(type: RuntimeEventType, data: Record<string, unknown>): void {
    const event: RuntimeEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Never let a broken listener crash the emitter
      }
    }
  }

  /** Number of active subscribers. */
  get subscriberCount(): number {
    return this.listeners.size;
  }
}

// ---------------------------------------------------------------------------
// EventBus — publish/subscribe for real-time SSE events
// ---------------------------------------------------------------------------

import { getTelemetryHooks, type TelemetrySpan } from '@crowclaw/core';

export type RuntimeEventType =
  | 'chat:message'
  | 'chat:stream'
  | 'chat:complete'
  | 'chat:error'
  | 'gateway:inbound'
  | 'gateway:outbound'
  | 'gateway:error'
  | 'gateway:policy_denied'
  | 'gateway:acl_denied'
  | 'gateway:status'
  | 'job:start'
  | 'job:complete'
  | 'job:error'
  | 'iteration:start'
  | 'iteration:end'
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
  | 'session:resumed'
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
  | 'memory:scoped_write'
  | 'context:assemble_start'
  | 'context:assemble_end'
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
  | 'agent:terminated'
  // v0.8.4 (#181) — per-turn skill matching results. Fires once per user
  // message after `matchSkillManifests` runs in the agent loop, with the
  // matched skill names + triggers + reasons + tools so the dashboard can
  // render a "why this skill fired" chip row above the next assistant
  // message and aggregate per-skill activation counters.
  | 'skill:matched';

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  data: Record<string, unknown>;
}

type Listener = (event: RuntimeEvent) => void;

export class EventBus {
  private listeners = new Set<Listener>();
  private sessionSpans = new Map<string, TelemetrySpan>();
  private iterationSpans = new Map<string, TelemetrySpan>();
  private toolSpans = new Map<string, TelemetrySpan>();
  private contextSpans = new Map<string, TelemetrySpan>();

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Publish an event to all subscribers. */
  emit(type: RuntimeEventType, data: Record<string, unknown>): void {
    this.observe(type, data);
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

  private observe(type: RuntimeEventType, data: Record<string, unknown>): void {
    const telemetry = getTelemetryHooks();
    if (!telemetry) return;

    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
    if ((type === 'chat:message' || type === 'chat:stream') && sessionId && !this.sessionSpans.has(sessionId)) {
      const span = telemetry.startSpan('crowclaw.harness.run', {
        'crowclaw.session.id': sessionId,
        'crowclaw.event.type': type,
      });
      if (span) this.sessionSpans.set(sessionId, span);
      return;
    }

    if ((type === 'chat:complete' || type === 'chat:error' || type === 'agent:terminated') && sessionId) {
      const span = this.sessionSpans.get(sessionId);
      if (span) {
        if (type === 'chat:error' && typeof data.error === 'string') span.setAttribute('crowclaw.error', data.error);
        span.setAttribute('crowclaw.event.type', type);
        span.end();
        this.sessionSpans.delete(sessionId);
      }
      return;
    }

    if (type === 'iteration:start' && sessionId) {
      const iteration = typeof data.iteration === 'number' ? data.iteration : -1;
      const key = `${sessionId}:${iteration}`;
      const span = telemetry.startSpan('crowclaw.tool.loop', {
        'crowclaw.session.id': sessionId,
        'crowclaw.iteration.index': iteration,
      });
      if (span) this.iterationSpans.set(key, span);
      return;
    }

    if (type === 'iteration:end' && sessionId) {
      const iteration = typeof data.iteration === 'number' ? data.iteration : -1;
      const key = `${sessionId}:${iteration}`;
      const span = this.iterationSpans.get(key);
      if (span) {
        if (typeof data.toolCount === 'number') span.setAttribute('crowclaw.tool.count', data.toolCount);
        span.end();
        this.iterationSpans.delete(key);
      }
      return;
    }

    if (type === 'tool:start') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      const toolName = typeof data.toolName === 'string' ? data.toolName : 'unknown';
      if (!callId) return;
      const span = telemetry.startSpan('crowclaw.exec', {
        'crowclaw.tool.name': toolName,
        ...(sessionId ? { 'crowclaw.session.id': sessionId } : {}),
      });
      if (span) this.toolSpans.set(callId, span);
      return;
    }

    if (type === 'tool:complete') {
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      if (!callId) return;
      const span = this.toolSpans.get(callId);
      if (span) {
        if (typeof data.ok === 'boolean') span.setAttribute('crowclaw.tool.ok', data.ok);
        if (typeof data.durationMs === 'number') span.setAttribute('crowclaw.tool.duration_ms', data.durationMs);
        span.end();
        this.toolSpans.delete(callId);
      }
      return;
    }

    if (type === 'context:assemble_start' && sessionId) {
      const span = telemetry.startSpan('crowclaw.context.assemble', {
        'crowclaw.session.id': sessionId,
      });
      if (span) this.contextSpans.set(sessionId, span);
      return;
    }

    if (type === 'context:assemble_end' && sessionId) {
      const span = this.contextSpans.get(sessionId);
      if (span) {
        if (typeof data.memoryCount === 'number') span.setAttribute('crowclaw.context.memory_count', data.memoryCount);
        if (typeof data.durationMs === 'number') span.setAttribute('crowclaw.context.duration_ms', data.durationMs);
        span.end();
        this.contextSpans.delete(sessionId);
      }
      return;
    }

    if (type === 'gateway:outbound') {
      const span = telemetry.startSpan('crowclaw.outbound.deliver', {
        ...(typeof data.platform === 'string' ? { 'crowclaw.outbound.platform': data.platform } : {}),
        ...(typeof data.contentLength === 'number' ? { 'crowclaw.outbound.content_length': data.contentLength } : {}),
      });
      span?.end();
    }
  }
}

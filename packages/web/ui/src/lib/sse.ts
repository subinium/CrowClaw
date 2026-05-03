/**
 * SSE streaming client for CrowClaw chat.
 * Ported from vanilla JS sndStream() + handleStreamEvent().
 */

import { getCurrentLocale } from './i18n.js';

export interface StreamEvent {
  type:
    | 'text-delta'
    | 'tool-start'
    | 'tool-end'
    // v0.8.1 (#242): runtime EventBus tool lifecycle bridged into the
    // per-session SSE stream. `tool-start` (extended below with `args` /
    // `startedAt`) fires when the instrumented ToolRegistry begins a call;
    // `tool-complete` fires when it returns. Distinct from `tool-end` which
    // is emitted by core's runStreaming() — both flow through this stream so
    // clients can pick whichever fits their UI (tool-end is per-step in the
    // model loop, tool-complete is per-execution from the worker).
    | 'tool-complete'
    | 'iteration-start'
    // v0.8.0 (#231): Hermes-style reasoning lifecycle. Emitted by the runtime
    // SSE bridge once the orchestrator forwards `reasoning_*` chunks from the
    // provider into the per-session event stream.
    | 'reasoning-start'
    | 'reasoning-delta'
    | 'reasoning-end'
    // v0.8.4 (#181): per-turn skill matching results from `matchSkillManifests`.
    // Forwarded so the chat-view can render a "why this skill fired" chip row
    // above the next assistant message.
    | 'skill-matched'
    | 'error'
    | 'done';
  content?: string;
  toolName?: string;
  toolCallId?: string;
  input?: Record<string, unknown>;
  // tool-end fields — match the wire format emitted by core (AgentLoop)
  result?: string;
  ok?: boolean;
  durationMs?: number;
  iteration?: number;
  error?: string;
  /** v0.8.0 (#231): tag name for `reasoning-start` / `reasoning-end`. */
  reasoningTag?: string;
  /** v0.8.1 (#242): args echoed by the ToolRegistry wrapper on `tool-start`. */
  args?: unknown;
  /** v0.8.1 (#242): ISO timestamp captured when the worker began the call. */
  startedAt?: string;
  /** v0.8.1 (#242): truncated tool output on `tool-complete`. */
  output?: string;
  /** v0.8.1 (#242): security-audit log id correlated with the tool call. */
  auditId?: string;
  /**
   * v0.8.4 (#181): on `skill-matched`, the user query that matched and the
   * full per-skill explanation (skillSlug, name, score, matchedTriggers,
   * matchedTools, reasons). Forwarded as-is from the runtime EventBus.
   */
  matches?: unknown;
  query?: string;
}

export interface StreamCallbacks {
  onTextDelta: (content: string) => void;
  onToolStart: (toolName: string, toolCallId: string, input?: Record<string, unknown>) => void;
  onToolEnd: (toolCallId: string, output: string, success: boolean) => void;
  onIterationStart: (iteration: number) => void;
  onDone: () => void;
  onError: (error: string) => void;
  /**
   * v0.8.0 (#231): reasoning-block lifecycle. Optional — clients that don't
   * render reasoning surfaces (legacy CLI, embeds) can omit them and the
   * dispatcher silently drops the corresponding events.
   */
  onReasoningStart?: (tag: string) => void;
  onReasoningDelta?: (content: string) => void;
  onReasoningEnd?: (tag: string) => void;
  /**
   * v0.8.1 (#242): runtime tool-execution lifecycle bridged from the EventBus.
   * Optional — existing clients that only consume core's `tool-start` /
   * `tool-end` events keep working unchanged. `onToolStart` is invoked for
   * BOTH the core `tool-start` (with `input`) and the runtime `tool-start`
   * (with `args` echoed back from the worker); `onToolComplete` is the
   * runtime-side counterpart and carries the durationMs, audit id, etc.
   */
  onToolComplete?: (toolCallId: string, ok: boolean, output?: string, durationMs?: number, auditId?: string, error?: string) => void;
  /**
   * v0.8.4 (#181): per-turn skill matching results. Optional — existing
   * clients that don't render the chip row simply ignore this callback.
   * `matches` is the raw runtime payload (array of
   * `{ skillSlug, name, score, matchedTriggers, matchedTools, reasons }`).
   */
  onSkillMatched?: (matches: unknown, query?: string) => void;
}

/**
 * Send a message and stream the response via SSE.
 * Returns an AbortController to cancel the stream.
 */
export const streamMessage = (
  sessionId: string,
  message: string,
  callbacks: StreamCallbacks,
): AbortController => {
  const controller = new AbortController();

  fetch(`${location.origin}/api/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-crowclaw-locale': getCurrentLocale(),
    },
    credentials: 'same-origin',
    body: JSON.stringify({ message }),
    signal: controller.signal,
  })
    .then((response) => {
      if (!response.ok || !response.body) {
        callbacks.onError(`HTTP ${response.status}`);
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      const pump = (): void => {
        reader
          .read()
          .then(({ done, value }) => {
            if (done) {
              callbacks.onDone();
              return;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            for (const line of lines) {
              if (!line.startsWith('data: ')) continue;
              const payload = line.slice(6).trim();
              if (payload === '[DONE]') {
                callbacks.onDone();
                return;
              }

              try {
                const event = JSON.parse(payload) as StreamEvent;
                dispatchEvent(event, callbacks);
              } catch {
                // Skip malformed events
              }
            }

            pump();
          })
          .catch((err: unknown) => {
            if (err instanceof Error && err.name === 'AbortError') return;
            callbacks.onError(err instanceof Error ? err.message : 'Stream error');
          });
      };

      pump();
    })
    .catch((err: unknown) => {
      if (err instanceof Error && err.name === 'AbortError') return;
      callbacks.onError(err instanceof Error ? err.message : 'Connection error');
    });

  return controller;
};

const dispatchEvent = (event: StreamEvent, callbacks: StreamCallbacks): void => {
  switch (event.type) {
    case 'text-delta':
      callbacks.onTextDelta(event.content ?? '');
      break;
    case 'tool-start':
      callbacks.onToolStart(
        event.toolName ?? 'unknown',
        event.toolCallId ?? '',
        // v0.8.1 (#242): runtime EventBus emits `args`; core runStreaming
        // emits `input`. Forward whichever is populated so callers see the
        // tool input regardless of which pipeline produced the event.
        event.input ?? (event.args as Record<string, unknown> | undefined),
      );
      break;
    case 'tool-end':
      callbacks.onToolEnd(
        event.toolCallId ?? '',
        event.result ?? '',
        event.ok ?? true,
      );
      break;
    case 'tool-complete':
      callbacks.onToolComplete?.(
        event.toolCallId ?? '',
        event.ok ?? true,
        event.output,
        event.durationMs,
        event.auditId,
        event.error,
      );
      break;
    case 'iteration-start':
      callbacks.onIterationStart(event.iteration ?? 0);
      break;
    case 'reasoning-start':
      callbacks.onReasoningStart?.(event.reasoningTag ?? 'reasoning');
      break;
    case 'reasoning-delta':
      callbacks.onReasoningDelta?.(event.content ?? '');
      break;
    case 'reasoning-end':
      callbacks.onReasoningEnd?.(event.reasoningTag ?? 'reasoning');
      break;
    case 'skill-matched':
      callbacks.onSkillMatched?.(event.matches, event.query);
      break;
    case 'error':
      callbacks.onError(event.error ?? 'Unknown error');
      break;
    case 'done':
      callbacks.onDone();
      break;
  }
};

/**
 * Connect to the global SSE event stream for real-time updates.
 * Returns a cleanup function to close the connection.
 */
export const connectEventStream = (callbacks: {
  onHeartbeat?: (data: { sessions?: number }) => void;
  onStatus?: (data: { type: string }) => void;
  onOpen?: () => void;
  onError?: () => void;
}): (() => void) => {
  // EventSource sends cookies on same-origin by default — no need to put the
  // token in the URL (which would leak it to access logs / referer headers).
  const source = new EventSource(`${location.origin}/api/events`, { withCredentials: true });

  source.onopen = () => {
    callbacks.onOpen?.();
  };

  source.addEventListener('heartbeat', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data);
      callbacks.onHeartbeat?.(data);
    } catch { /* ignore */ }
  });

  source.addEventListener('status', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data);
      callbacks.onStatus?.(data);
    } catch { /* ignore */ }
  });

  source.onerror = () => {
    callbacks.onError?.();
  };

  return () => source.close();
};

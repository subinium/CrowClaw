/**
 * SSE streaming client for CrowClaw chat.
 * Ported from vanilla JS sndStream() + handleStreamEvent().
 */

export interface StreamEvent {
  type:
    | 'text-delta'
    | 'tool-start'
    | 'tool-end'
    | 'iteration-start'
    // v0.8.0 (#231): Hermes-style reasoning lifecycle. Emitted by the runtime
    // SSE bridge once the orchestrator forwards `reasoning_*` chunks from the
    // provider into the per-session event stream.
    | 'reasoning-start'
    | 'reasoning-delta'
    | 'reasoning-end'
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
    headers: { 'content-type': 'application/json' },
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
        event.input,
      );
      break;
    case 'tool-end':
      callbacks.onToolEnd(
        event.toolCallId ?? '',
        event.result ?? '',
        event.ok ?? true,
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

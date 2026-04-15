/**
 * SSE streaming client for CrowClaw chat.
 * Ported from vanilla JS sndStream() + handleStreamEvent().
 */

import { getAuthToken } from './api.js';

export interface StreamEvent {
  type: 'text-delta' | 'tool-start' | 'tool-end' | 'iteration-start' | 'error' | 'done';
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
}

export interface StreamCallbacks {
  onTextDelta: (content: string) => void;
  onToolStart: (toolName: string, toolCallId: string, input?: Record<string, unknown>) => void;
  onToolEnd: (toolCallId: string, output: string, success: boolean) => void;
  onIterationStart: (iteration: number) => void;
  onDone: () => void;
  onError: (error: string) => void;
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
  const authToken = getAuthToken();

  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  fetch(`${location.origin}/api/sessions/${sessionId}/stream`, {
    method: 'POST',
    headers,
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

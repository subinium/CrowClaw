/**
 * WebSocket client for CrowClaw real-time dashboard events.
 * Falls back to SSE after repeated connection failures.
 */

import { connectEventStream } from './sse.js';

export interface WsCallbacks {
  onEvent: (event: { type: string; data: Record<string, unknown> }) => void;
  onOpen?: () => void;
  onClose?: () => void;
  onError?: (error: Event) => void;
  /**
   * Fired the moment the client gives up on WebSocket and switches to the
   * SSE fallback. The dashboard uses this to surface a banner and to switch
   * the chat-view from streaming to non-streaming mode (issue #141).
   */
  onFallback?: () => void;
  /**
   * Fired when the user manually triggers a WS reconnect via the banner
   * button. The transport is reset to a clean state and `connect()` runs
   * again from scratch.
   */
  onReconnect?: () => void;
}

export interface WsClient {
  send: (message: { type: string; [key: string]: unknown }) => void;
  close: () => void;
  isConnected: () => boolean;
  /** Whether the client has fallen back to the SSE fire-and-forget channel. */
  isFallback: () => boolean;
  /**
   * Force a clean reconnect attempt. Closes any active WS/SSE, resets
   * the failure counter, and schedules an immediate connection. The
   * `onReconnect` callback fires before the new connection starts.
   */
  reconnect: () => void;
}

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_FAILURES_BEFORE_FALLBACK = 3;

const buildWsUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  // Same-origin WebSocket carries the HttpOnly auth cookie automatically.
  // We intentionally do NOT append `?token=...` — query strings leak into
  // access logs and the Referer header even when the connection is TLS.
  return `${protocol}//${location.host}/ws`;
};

export const connectWebSocket = (callbacks: WsCallbacks): WsClient => {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let sseFallbackCleanup: (() => void) | null = null;
  let fallbackActive = false;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const fallbackToSse = () => {
    if (sseFallbackCleanup || closed) return;
    fallbackActive = true;
    sseFallbackCleanup = connectEventStream({
      onOpen: () => callbacks.onOpen?.(),
      onHeartbeat: (data) => callbacks.onEvent({ type: 'heartbeat', data: data as Record<string, unknown> }),
      onStatus: (data) => callbacks.onEvent({ type: 'status', data: data as Record<string, unknown> }),
      onError: () => callbacks.onClose?.(),
    });
    callbacks.onFallback?.();
  };

  const connect = () => {
    if (closed) return;

    if (consecutiveFailures >= MAX_FAILURES_BEFORE_FALLBACK) {
      fallbackToSse();
      return;
    }

    try {
      ws = new WebSocket(buildWsUrl());
    } catch {
      consecutiveFailures++;
      scheduleReconnect();
      return;
    }

    ws.onopen = () => {
      consecutiveFailures = 0;
      reconnectDelay = INITIAL_RECONNECT_DELAY;
      // If we recovered from SSE fallback, mark the transport as healthy
      // again so the UI can drop the banner.
      if (fallbackActive) {
        fallbackActive = false;
        if (sseFallbackCleanup) {
          sseFallbackCleanup();
          sseFallbackCleanup = null;
        }
      }
      callbacks.onOpen?.();

      // Empty channels array = subscribe to all events (server treats non-array as "all")
      send({ type: 'subscribe' });
    };

    ws.onmessage = (event: MessageEvent) => {
      let parsed: { type?: string; data?: Record<string, unknown> };
      try {
        parsed = JSON.parse(typeof event.data === 'string' ? event.data : '');
      } catch {
        return;
      }

      if (!parsed || typeof parsed.type !== 'string') return;

      if (parsed.type === 'ping') {
        send({ type: 'pong' });
        return;
      }

      callbacks.onEvent({
        type: parsed.type,
        data: (parsed.data ?? parsed) as Record<string, unknown>,
      });
    };

    ws.onclose = () => {
      ws = null;
      if (!closed) {
        callbacks.onClose?.();
        consecutiveFailures++;
        scheduleReconnect();
      }
    };

    ws.onerror = (err: Event) => {
      callbacks.onError?.(err);
    };
  };

  const scheduleReconnect = () => {
    if (closed) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      connect();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  };

  const send = (message: { type: string; [key: string]: unknown }) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  };

  const close = () => {
    closed = true;
    clearReconnectTimer();
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    if (sseFallbackCleanup) {
      sseFallbackCleanup();
      sseFallbackCleanup = null;
    }
    fallbackActive = false;
  };

  const isConnected = (): boolean => {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  };

  const isFallback = (): boolean => fallbackActive;

  const reconnect = (): void => {
    if (closed) return;
    callbacks.onReconnect?.();
    clearReconnectTimer();
    if (sseFallbackCleanup) {
      sseFallbackCleanup();
      sseFallbackCleanup = null;
    }
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.close();
      ws = null;
    }
    fallbackActive = false;
    consecutiveFailures = 0;
    reconnectDelay = INITIAL_RECONNECT_DELAY;
    connect();
  };

  connect();

  return { send, close, isConnected, isFallback, reconnect };
};

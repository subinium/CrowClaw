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
}

export interface WsClient {
  send: (message: { type: string; [key: string]: unknown }) => void;
  close: () => void;
  isConnected: () => boolean;
}

const MAX_RECONNECT_DELAY = 30_000;
const INITIAL_RECONNECT_DELAY = 1_000;
const MAX_FAILURES_BEFORE_FALLBACK = 3;

const buildWsUrl = (): string => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/ws`;
};

export const connectWebSocket = (callbacks: WsCallbacks): WsClient => {
  let ws: WebSocket | null = null;
  let closed = false;
  let reconnectDelay = INITIAL_RECONNECT_DELAY;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let consecutiveFailures = 0;
  let sseFallbackCleanup: (() => void) | null = null;

  const clearReconnectTimer = () => {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  const fallbackToSse = () => {
    if (sseFallbackCleanup || closed) return;
    sseFallbackCleanup = connectEventStream({
      onOpen: () => callbacks.onOpen?.(),
      onHeartbeat: (data) => callbacks.onEvent({ type: 'heartbeat', data: data as Record<string, unknown> }),
      onStatus: (data) => callbacks.onEvent({ type: 'status', data: data as Record<string, unknown> }),
      onError: () => callbacks.onClose?.(),
    });
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
  };

  const isConnected = (): boolean => {
    return ws !== null && ws.readyState === WebSocket.OPEN;
  };

  connect();

  return { send, close, isConnected };
};

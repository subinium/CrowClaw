// ---------------------------------------------------------------------------
// WebSocketManager — WebSocket transport for real-time dashboard events
// ---------------------------------------------------------------------------

import type { EventBus, RuntimeEvent, RuntimeEventType } from './event-bus.js';

export interface WsMessage {
  type: string;
  [key: string]: unknown;
}

export interface WsSubscribeMessage {
  type: 'subscribe';
  channels: string[];
}

export interface WsPingMessage {
  type: 'ping';
}

export interface WsSessionAbortMessage {
  type: 'session:abort';
  sessionId: string;
}

type ClientMessage = WsSubscribeMessage | WsPingMessage | WsSessionAbortMessage;

interface TrackedConnection {
  ws: WebSocket;
  channels: Set<string> | null; // null = subscribed to all
  alive: boolean;
}

export type AbortHandler = (sessionId: string) => void;

export class WebSocketManager {
  private connections = new Map<WebSocket, TrackedConnection>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEventBus: (() => void) | null = null;
  private abortHandler: AbortHandler | null = null;

  get connectionCount(): number {
    return this.connections.size;
  }

  onAbort(handler: AbortHandler): void {
    this.abortHandler = handler;
  }

  start(eventBus: EventBus): void {
    this.unsubscribeEventBus = eventBus.subscribe((event: RuntimeEvent) => {
      this.broadcast(event.type, { ...event.data, timestamp: event.timestamp });
    });

    this.heartbeatInterval = setInterval(() => {
      const now = new Date().toISOString();
      for (const [ws, conn] of this.connections) {
        if (!conn.alive) {
          this.removeConnection(ws);
          continue;
        }
        conn.alive = false;
        this.sendTo(ws, { type: 'ping', timestamp: now });
      }
    }, 15_000);
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
    if (this.unsubscribeEventBus) {
      this.unsubscribeEventBus();
      this.unsubscribeEventBus = null;
    }
    for (const [ws] of this.connections) {
      try { ws.close(1001, 'server shutting down'); } catch { /* already closed */ }
    }
    this.connections.clear();
  }

  addConnection(ws: WebSocket): void {
    const conn: TrackedConnection = { ws, channels: null, alive: true };
    this.connections.set(ws, conn);

    ws.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(ws, event);
    });

    ws.addEventListener('close', () => {
      this.removeConnection(ws);
    });

    ws.addEventListener('error', () => {
      this.removeConnection(ws);
    });

    this.sendTo(ws, {
      type: 'connected',
      timestamp: new Date().toISOString(),
    });
  }

  removeConnection(ws: WebSocket): void {
    this.connections.delete(ws);
    try { ws.close(); } catch { /* already closed */ }
  }

  broadcast(type: RuntimeEventType | string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ type, data });
    for (const [ws, conn] of this.connections) {
      if (conn.channels !== null && !conn.channels.has(type)) {
        continue;
      }
      try {
        ws.send(message);
      } catch {
        this.removeConnection(ws);
      }
    }
  }

  private sendTo(ws: WebSocket, payload: Record<string, unknown>): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      this.removeConnection(ws);
    }
  }

  private handleMessage(ws: WebSocket, event: MessageEvent): void {
    const conn = this.connections.get(ws);
    if (!conn) return;

    conn.alive = true;

    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof event.data === 'string' ? event.data : '') as ClientMessage;
    } catch {
      return;
    }

    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'subscribe': {
        const channels = (msg as WsSubscribeMessage).channels;
        if (Array.isArray(channels)) {
          conn.channels = new Set(channels);
        }
        break;
      }
      case 'ping': {
        this.sendTo(ws, { type: 'pong', timestamp: new Date().toISOString() });
        break;
      }
      case 'session:abort': {
        const sessionId = (msg as WsSessionAbortMessage).sessionId;
        if (typeof sessionId === 'string' && sessionId.length > 0 && this.abortHandler) {
          this.abortHandler(sessionId);
        }
        break;
      }
    }
  }
}

export const createWebSocketResponse = (
  request: Request,
  manager: WebSocketManager,
): Response => {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  server.accept();
  manager.addConnection(server);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
};

export const handleWebSocketUpgrade = (
  request: Request,
  eventBus: EventBus,
  manager: WebSocketManager,
): Response => {
  return createWebSocketResponse(request, manager);
};

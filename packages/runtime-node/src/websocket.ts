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
  authenticated: boolean;
}

export type AbortHandler = (sessionId: string) => void;

const MAX_CONNECTIONS = 100;
const MAX_CHANNELS = 50;

export class WebSocketManager {
  private connections = new Map<WebSocket, TrackedConnection>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEventBus: (() => void) | null = null;
  private abortHandler: AbortHandler | null = null;
  private statsProvider: (() => { sessions: number; subscribers: number }) | null = null;

  get connectionCount(): number {
    return this.connections.size;
  }

  onAbort(handler: AbortHandler): void {
    this.abortHandler = handler;
  }

  /** Provide live stats for the heartbeat payload. Dashboard reads these
   *  to render "N clients connected" badges. Previously WS only sent `ping`
   *  while SSE sent `heartbeat` — UI count was stuck at 0 on WS deployments. */
  setStatsProvider(provider: () => { sessions: number; subscribers: number }): void {
    this.statsProvider = provider;
  }

  start(eventBus: EventBus): void {
    this.unsubscribeEventBus = eventBus.subscribe((event: RuntimeEvent) => {
      this.broadcast(event.type, { ...event.data, timestamp: event.timestamp });
    });

    this.heartbeatInterval = setInterval(() => {
      const now = new Date().toISOString();
      const stats = this.statsProvider?.() ?? { sessions: 0, subscribers: this.connections.size };
      const toRemove: WebSocket[] = [];
      for (const [ws, conn] of this.connections) {
        if (!conn.alive) {
          toRemove.push(ws);
          continue;
        }
        conn.alive = false;
        this.sendTo(ws, { type: 'ping', timestamp: now });
        this.sendTo(ws, { type: 'heartbeat', timestamp: now, sessions: stats.sessions, subscribers: stats.subscribers });
      }
      for (const ws of toRemove) {
        this.removeConnection(ws);
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

  addConnection(ws: WebSocket, authenticated = false): boolean {
    if (this.connections.size >= MAX_CONNECTIONS) {
      try { ws.close(1013, 'max connections reached'); } catch { /* ignore */ }
      return false;
    }

    const conn: TrackedConnection = { ws, channels: null, alive: true, authenticated };
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

    return true;
  }

  removeConnection(ws: WebSocket): void {
    if (!this.connections.has(ws)) return;
    this.connections.delete(ws);
    try { ws.close(); } catch { /* already closed */ }
  }

  broadcast(type: RuntimeEventType | string, data: Record<string, unknown>): void {
    const message = JSON.stringify({ type, data });
    const toRemove: WebSocket[] = [];
    for (const [ws, conn] of this.connections) {
      // Only broadcast to authenticated connections
      if (!conn.authenticated) continue;
      if (conn.channels !== null && !conn.channels.has(type)) {
        continue;
      }
      try {
        ws.send(message);
      } catch {
        toRemove.push(ws);
      }
    }
    for (const ws of toRemove) {
      this.removeConnection(ws);
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
        if (Array.isArray(channels) && channels.length > 0) {
          conn.channels = new Set(channels.slice(0, MAX_CHANNELS));
        } else {
          conn.channels = null; // subscribe to all
        }
        break;
      }
      case 'ping': {
        this.sendTo(ws, { type: 'pong', timestamp: new Date().toISOString() });
        break;
      }
      case 'session:abort': {
        if (!conn.authenticated) break; // abort requires auth
        const sessionId = (msg as WsSessionAbortMessage).sessionId;
        if (typeof sessionId === 'string' && sessionId.length > 0 && this.abortHandler) {
          this.abortHandler(sessionId);
        }
        break;
      }
    }
  }
}

/**
 * Handle WebSocket upgrade using the WebSocketPair API (Cloudflare Workers / WinterCG).
 * For Node.js HTTP servers, the upgrade must be handled at the HTTP server level
 * using the `ws` library. This function works with Bun.serve() and Cloudflare Workers.
 */
export const createWebSocketResponse = (
  request: Request,
  manager: WebSocketManager,
  authenticated = false,
): Response => {
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return new Response('Expected WebSocket upgrade', { status: 426 });
  }

  // WebSocketPair is available in Cloudflare Workers and Bun
  if (typeof (globalThis as Record<string, unknown>).WebSocketPair === 'undefined') {
    return new Response('WebSocket upgrade not supported in this runtime', { status: 501 });
  }

  const pair = new WebSocketPair();
  const [client, server] = [pair[0], pair[1]];

  server.accept();
  const added = manager.addConnection(server, authenticated);
  if (!added) {
    return new Response('Too many connections', { status: 503 });
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
};

export const handleWebSocketUpgrade = (
  request: Request,
  _eventBus: EventBus,
  manager: WebSocketManager,
  authenticated = false,
): Response => {
  return createWebSocketResponse(request, manager, authenticated);
};

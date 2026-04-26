// ---------------------------------------------------------------------------
// WebSocketManager — WebSocket transport for real-time dashboard events
// ---------------------------------------------------------------------------

import type { EventBus, RuntimeEvent, RuntimeEventType } from './event-bus.js';
import type { Logger } from './logger.js';

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

/**
 * Per-subscriber outbound queue. Decouples the broadcast producer from slow
 * consumers: a saturated subscriber drops its oldest queued frames instead of
 * stalling the loop for fast subscribers (see issue #52).
 */
interface SubscriberQueue {
  ws: WebSocket;
  queue: string[];
  flushing: boolean;
  dropped: number; // counter for observability
}

export type AbortHandler = (sessionId: string) => void;

const MAX_CONNECTIONS = 100;
const MAX_CHANNELS = 50;
const MAX_QUEUE_PER_SUBSCRIBER = 100; // drop oldest beyond this
const FLUSH_BATCH_SIZE = 32; // process up to N items per microtask

export class WebSocketManager {
  private connections = new Map<WebSocket, TrackedConnection>();
  private outboundQueues = new Map<WebSocket, SubscriberQueue>();
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private unsubscribeEventBus: (() => void) | null = null;
  private abortHandler: AbortHandler | null = null;
  private statsProvider: (() => { sessions: number; subscribers: number }) | null = null;
  private logger: Logger | null = null;

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

  /** Optional logger for transport-level errors (dead subscribers, send
   *  failures). Kept optional so existing call sites that construct the
   *  manager without a logger continue to work. */
  setLogger(logger: Logger): void {
    this.logger = logger;
  }

  /** Aggregate stats across all per-subscriber outbound queues. Hookable for
   *  future observability — e.g. dashboard can render "frames dropped". */
  getStats(): { subscribers: number; totalDropped: number } {
    let totalDropped = 0;
    for (const q of this.outboundQueues.values()) {
      totalDropped += q.dropped;
    }
    return { subscribers: this.outboundQueues.size, totalDropped };
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
    this.outboundQueues.clear();
  }

  addConnection(ws: WebSocket, authenticated = false): boolean {
    if (this.connections.size >= MAX_CONNECTIONS) {
      try { ws.close(1013, 'max connections reached'); } catch { /* ignore */ }
      return false;
    }

    const conn: TrackedConnection = { ws, channels: null, alive: true, authenticated };
    this.connections.set(ws, conn);
    this.outboundQueues.set(ws, { ws, queue: [], flushing: false, dropped: 0 });

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
    // Best-effort drain: synchronously flush any queued frames so the client
    // receives an in-flight broadcast before we close the socket. If a send
    // fails here we just stop draining — the close below cleans up regardless.
    const sub = this.outboundQueues.get(ws);
    if (sub) {
      while (sub.queue.length > 0) {
        const next = sub.queue.shift();
        if (next === undefined) break;
        try { ws.send(next); } catch { break; }
      }
      this.outboundQueues.delete(ws);
    }
    try { ws.close(); } catch { /* already closed */ }
  }

  broadcast(type: RuntimeEventType | string, data: Record<string, unknown>): void {
    // Single JSON.stringify reused across all subscribers (already in place).
    const message = JSON.stringify({ type, data });
    for (const [ws, conn] of this.connections) {
      // Only broadcast to authenticated connections
      if (!conn.authenticated) continue;
      if (conn.channels !== null && !conn.channels.has(type)) {
        continue;
      }
      const sub = this.outboundQueues.get(ws);
      if (!sub) continue;
      // Drop-on-overflow: when a slow consumer's queue is saturated, evict
      // the oldest frame so the producer (broadcast) is never blocked.
      if (sub.queue.length >= MAX_QUEUE_PER_SUBSCRIBER) {
        sub.queue.shift();
        sub.dropped += 1;
      }
      sub.queue.push(message);
      if (!sub.flushing) {
        sub.flushing = true;
        queueMicrotask(() => { void this.flush(sub); });
      }
    }
  }

  /**
   * Drain a subscriber's outbound queue. Awaits each `ws.send` so a slow
   * subscriber never blocks broadcast for fast subscribers — they each have
   * their own queue + microtask. Yields between batches via queueMicrotask
   * so other tasks can interleave on long backlogs.
   */
  private async flush(sub: SubscriberQueue): Promise<void> {
    try {
      while (sub.queue.length > 0) {
        // If the connection was removed between scheduling and flushing, bail.
        if (!this.outboundQueues.has(sub.ws)) return;
        const batch = sub.queue.splice(0, FLUSH_BATCH_SIZE);
        for (const msg of batch) {
          try {
            await sub.ws.send(msg);
          } catch (err: unknown) {
            this.logger?.warn('ws send failed; removing subscriber', {
              error: err instanceof Error ? err.message : String(err),
              dropped: sub.dropped,
            });
            this.removeConnection(sub.ws);
            return;
          }
        }
        // Yield to the microtask queue between batches if more remain.
        if (sub.queue.length > 0) {
          await new Promise<void>((resolve) => { queueMicrotask(resolve); });
        }
      }
    } finally {
      sub.flushing = false;
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

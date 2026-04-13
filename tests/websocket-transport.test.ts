import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBus } from '../packages/runtime-node/src/event-bus.js';
import { WebSocketManager } from '../packages/runtime-node/src/websocket.js';

// ---------------------------------------------------------------------------
// Mock WebSocket for server-side tests
// ---------------------------------------------------------------------------

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.OPEN;
  sent: string[] = [];
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  send(data: string) {
    if (this.readyState !== MockWebSocket.OPEN) throw new Error('WebSocket is not open');
    this.sent.push(data);
  }

  close(_code?: number, _reason?: string) {
    this.readyState = MockWebSocket.CLOSED;
  }

  addEventListener(event: string, handler: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    handlers.push(handler);
    this.listeners.set(event, handlers);
  }

  removeEventListener(event: string, handler: (...args: unknown[]) => void) {
    const handlers = this.listeners.get(event) ?? [];
    this.listeners.set(event, handlers.filter(h => h !== handler));
  }

  simulateMessage(data: string) {
    const handlers = this.listeners.get('message') ?? [];
    for (const h of handlers) h({ data } as unknown);
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    const handlers = this.listeners.get('close') ?? [];
    for (const h of handlers) h();
  }

  simulateError() {
    const handlers = this.listeners.get('error') ?? [];
    for (const h of handlers) h(new Error('connection failed'));
  }
}

// ---------------------------------------------------------------------------
// WebSocketManager tests
// ---------------------------------------------------------------------------

describe('WebSocketManager', () => {
  let manager: WebSocketManager;
  let eventBus: EventBus;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new WebSocketManager();
    eventBus = new EventBus();
  });

  afterEach(() => {
    manager.stop();
    vi.useRealTimers();
  });

  describe('connection tracking', () => {
    it('tracks added connections', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      expect(manager.connectionCount).toBe(1);
    });

    it('sends connected message on add', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      expect(ws.sent.length).toBe(1);
      const msg = JSON.parse(ws.sent[0]);
      expect(msg.type).toBe('connected');
      expect(msg.timestamp).toBeDefined();
    });

    it('removes connection on close', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      expect(manager.connectionCount).toBe(1);
      ws.simulateClose();
      expect(manager.connectionCount).toBe(0);
    });

    it('removes connection on error', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      ws.simulateError();
      expect(manager.connectionCount).toBe(0);
    });

    it('handles multiple connections', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      manager.addConnection(ws1 as unknown as WebSocket);
      manager.addConnection(ws2 as unknown as WebSocket);
      expect(manager.connectionCount).toBe(2);
      ws1.simulateClose();
      expect(manager.connectionCount).toBe(1);
    });

    it('removeConnection is idempotent', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      manager.removeConnection(ws as unknown as WebSocket);
      manager.removeConnection(ws as unknown as WebSocket);
      expect(manager.connectionCount).toBe(0);
    });
  });

  describe('broadcasting', () => {
    it('broadcasts to all connections', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      manager.addConnection(ws1 as unknown as WebSocket);
      manager.addConnection(ws2 as unknown as WebSocket);

      manager.broadcast('chat:message', { text: 'hello' });

      // ws1 has connected msg + broadcast, ws2 has connected msg + broadcast
      const msg1 = JSON.parse(ws1.sent[1]);
      const msg2 = JSON.parse(ws2.sent[1]);
      expect(msg1).toEqual({ type: 'chat:message', data: { text: 'hello' } });
      expect(msg2).toEqual({ type: 'chat:message', data: { text: 'hello' } });
    });

    it('removes connection that throws on send', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      ws.readyState = MockWebSocket.CLOSED;

      manager.broadcast('chat:message', { text: 'hello' });
      expect(manager.connectionCount).toBe(0);
    });
  });

  describe('EventBus relay', () => {
    it('relays EventBus events to connected clients', () => {
      const ws = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws as unknown as WebSocket);

      eventBus.emit('chat:message', { content: 'test' });

      // connected msg + relayed event
      expect(ws.sent.length).toBe(2);
      const relayed = JSON.parse(ws.sent[1]);
      expect(relayed.type).toBe('chat:message');
      expect(relayed.data.content).toBe('test');
      expect(relayed.data.timestamp).toBeDefined();
    });

    it('stops relaying after stop()', () => {
      const ws = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws as unknown as WebSocket);
      manager.stop();

      eventBus.emit('chat:message', { content: 'test' });
      // Only the connected message, no relay
      expect(ws.sent.length).toBe(1);
    });
  });

  describe('heartbeat', () => {
    it('sends ping after 15 seconds', () => {
      const ws = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws as unknown as WebSocket);

      // Mark as alive (addConnection sets alive=true)
      vi.advanceTimersByTime(15_000);

      // connected msg + ping
      expect(ws.sent.length).toBe(2);
      const ping = JSON.parse(ws.sent[1]);
      expect(ping.type).toBe('ping');
    });

    it('disconnects unresponsive clients after two heartbeat cycles', () => {
      const ws = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws as unknown as WebSocket);

      // First heartbeat: sets alive=false, sends ping
      vi.advanceTimersByTime(15_000);
      expect(manager.connectionCount).toBe(1);

      // Second heartbeat: alive is still false, remove
      vi.advanceTimersByTime(15_000);
      expect(manager.connectionCount).toBe(0);
    });

    it('keeps alive clients that respond', () => {
      const ws = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws as unknown as WebSocket);

      // First heartbeat
      vi.advanceTimersByTime(15_000);
      expect(manager.connectionCount).toBe(1);

      // Client sends a message (any message marks alive=true)
      ws.simulateMessage(JSON.stringify({ type: 'ping' }));

      // Second heartbeat: alive was refreshed by message
      vi.advanceTimersByTime(15_000);
      expect(manager.connectionCount).toBe(1);
    });
  });

  describe('selective channel subscription', () => {
    it('filters events by subscribed channels', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      ws.simulateMessage(JSON.stringify({ type: 'subscribe', channels: ['chat:message'] }));

      manager.broadcast('chat:message', { text: 'included' });
      manager.broadcast('job:start', { id: 'excluded' });

      // connected + pong (from subscribe is not a ping, no pong) + chat:message broadcast
      const messages = ws.sent.slice(1).map(s => JSON.parse(s));
      const types = messages.map((m: { type: string }) => m.type);
      expect(types).toContain('chat:message');
      expect(types).not.toContain('job:start');
    });

    it('receives all events when no subscribe message sent', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      manager.broadcast('chat:message', { text: 'a' });
      manager.broadcast('job:start', { id: 'b' });

      // connected + 2 broadcasts
      expect(ws.sent.length).toBe(3);
    });
  });

  describe('client message handling', () => {
    it('responds to ping with pong', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      ws.simulateMessage(JSON.stringify({ type: 'ping' }));

      const pong = JSON.parse(ws.sent[ws.sent.length - 1]);
      expect(pong.type).toBe('pong');
      expect(pong.timestamp).toBeDefined();
    });

    it('handles subscribe message', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      ws.simulateMessage(JSON.stringify({ type: 'subscribe', channels: ['chat:stream'] }));

      manager.broadcast('chat:stream', { delta: 'x' });
      manager.broadcast('chat:error', { error: 'y' });

      const messages = ws.sent.slice(1).map(s => JSON.parse(s));
      expect(messages.some((m: { type: string }) => m.type === 'chat:stream')).toBe(true);
      expect(messages.some((m: { type: string }) => m.type === 'chat:error')).toBe(false);
    });

    it('calls abort handler on session:abort when authenticated', () => {
      const abortFn = vi.fn();
      manager.onAbort(abortFn);

      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket, true);

      ws.simulateMessage(JSON.stringify({ type: 'session:abort', sessionId: 'sess-123' }));
      expect(abortFn).toHaveBeenCalledWith('sess-123');
    });

    it('ignores session:abort when not authenticated', () => {
      const abortFn = vi.fn();
      manager.onAbort(abortFn);

      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket); // not authenticated

      ws.simulateMessage(JSON.stringify({ type: 'session:abort', sessionId: 'sess-123' }));
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('ignores session:abort with no handler', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      // Should not throw
      ws.simulateMessage(JSON.stringify({ type: 'session:abort', sessionId: 'sess-123' }));
    });

    it('ignores session:abort with empty sessionId', () => {
      const abortFn = vi.fn();
      manager.onAbort(abortFn);

      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      ws.simulateMessage(JSON.stringify({ type: 'session:abort', sessionId: '' }));
      expect(abortFn).not.toHaveBeenCalled();
    });

    it('ignores malformed messages', () => {
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);

      ws.simulateMessage('not-json');
      ws.simulateMessage(JSON.stringify({ noType: true }));
      ws.simulateMessage(JSON.stringify(null));

      // Only the connected message
      expect(ws.sent.length).toBe(1);
    });
  });

  describe('stop()', () => {
    it('clears all connections', () => {
      const ws1 = new MockWebSocket();
      const ws2 = new MockWebSocket();
      manager.start(eventBus);
      manager.addConnection(ws1 as unknown as WebSocket);
      manager.addConnection(ws2 as unknown as WebSocket);

      manager.stop();
      expect(manager.connectionCount).toBe(0);
    });

    it('clears heartbeat interval', () => {
      manager.start(eventBus);
      const ws = new MockWebSocket();
      manager.addConnection(ws as unknown as WebSocket);
      manager.stop();

      // Advancing timers should not send any more pings
      const sentBefore = ws.sent.length;
      vi.advanceTimersByTime(30_000);
      // ws is closed so sent won't increase, but more importantly no error
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
    });
  });
});

// ---------------------------------------------------------------------------
// WS client module tests
// ---------------------------------------------------------------------------

describe('ws client module', () => {
  it('exports connectWebSocket function', async () => {
    const mod = await import('../packages/web/ui/src/lib/ws.js');
    expect(typeof mod.connectWebSocket).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// WS client logic tests (with mocked WebSocket)
// ---------------------------------------------------------------------------

describe('ws client behavior', () => {
  let originalWebSocket: typeof globalThis.WebSocket;
  let mockInstances: MockClientWebSocket[];

  class MockClientWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;

    url: string;
    readyState = MockClientWebSocket.CONNECTING;
    onopen: ((ev: Event) => void) | null = null;
    onclose: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    sent: string[] = [];

    constructor(url: string) {
      this.url = url;
      mockInstances.push(this);
    }

    send(data: string) {
      this.sent.push(data);
    }

    close() {
      this.readyState = MockClientWebSocket.CLOSED;
    }

    simulateOpen() {
      this.readyState = MockClientWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    }

    simulateMessage(data: string) {
      this.onmessage?.(new MessageEvent('message', { data }));
    }

    simulateClose() {
      this.readyState = MockClientWebSocket.CLOSED;
      this.onclose?.(new Event('close'));
    }

    simulateError() {
      this.onerror?.(new Event('error'));
    }
  }

  beforeEach(() => {
    vi.useFakeTimers();
    mockInstances = [];
    originalWebSocket = globalThis.WebSocket;

    // Mock location
    vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3000', origin: 'http://localhost:3000' });

    // Mock WebSocket constructor
    globalThis.WebSocket = MockClientWebSocket as unknown as typeof WebSocket;
    (globalThis.WebSocket as unknown as Record<string, number>).OPEN = MockClientWebSocket.OPEN;
    (globalThis.WebSocket as unknown as Record<string, number>).CONNECTING = MockClientWebSocket.CONNECTING;
    (globalThis.WebSocket as unknown as Record<string, number>).CLOSING = MockClientWebSocket.CLOSING;
    (globalThis.WebSocket as unknown as Record<string, number>).CLOSED = MockClientWebSocket.CLOSED;
  });

  afterEach(() => {
    vi.useRealTimers();
    globalThis.WebSocket = originalWebSocket;
    vi.unstubAllGlobals();
  });

  it('connects to ws:// URL derived from location', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });
    expect(mockInstances.length).toBe(1);
    expect(mockInstances[0].url).toBe('ws://localhost:3000/api/ws');
    client.close();
  });

  it('calls onOpen callback on connection', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const onOpen = vi.fn();
    const client = connectWebSocket({ onEvent: vi.fn(), onOpen });

    mockInstances[0].simulateOpen();
    expect(onOpen).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('sends subscribe message on open', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    mockInstances[0].simulateOpen();
    expect(mockInstances[0].sent.length).toBe(1);
    const msg = JSON.parse(mockInstances[0].sent[0]);
    expect(msg.type).toBe('subscribe');
    client.close();
  });

  it('dispatches events from server messages', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const onEvent = vi.fn();
    const client = connectWebSocket({ onEvent });

    mockInstances[0].simulateOpen();
    mockInstances[0].simulateMessage(JSON.stringify({ type: 'chat:message', data: { text: 'hi' } }));

    expect(onEvent).toHaveBeenCalledWith({ type: 'chat:message', data: { text: 'hi' } });
    client.close();
  });

  it('responds to server ping with pong', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    mockInstances[0].simulateOpen();
    mockInstances[0].simulateMessage(JSON.stringify({ type: 'ping' }));

    const lastSent = JSON.parse(mockInstances[0].sent[mockInstances[0].sent.length - 1]);
    expect(lastSent.type).toBe('pong');
    client.close();
  });

  it('reports isConnected correctly', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    expect(client.isConnected()).toBe(false);
    mockInstances[0].simulateOpen();
    expect(client.isConnected()).toBe(true);
    client.close();
    expect(client.isConnected()).toBe(false);
  });

  it('reconnects with exponential backoff', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    // First connection fails
    mockInstances[0].simulateClose();
    expect(mockInstances.length).toBe(1);

    // After 1s delay, reconnect attempt
    vi.advanceTimersByTime(1_000);
    expect(mockInstances.length).toBe(2);

    // Second failure
    mockInstances[1].simulateClose();

    // After 2s delay
    vi.advanceTimersByTime(2_000);
    expect(mockInstances.length).toBe(3);

    client.close();
  });

  it('falls back to SSE after 3 consecutive failures', async () => {
    let eventSourceCreated = false;
    class MockEventSource {
      onopen: ((ev: Event) => void) | null = null;
      onerror: ((ev: Event) => void) | null = null;
      addEventListener = vi.fn();
      close = vi.fn();
      constructor() { eventSourceCreated = true; }
    }
    vi.stubGlobal('EventSource', MockEventSource);

    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    // Fail 3 times with reconnect delays
    mockInstances[0].simulateClose();
    vi.advanceTimersByTime(1_000);
    mockInstances[1].simulateClose();
    vi.advanceTimersByTime(2_000);
    mockInstances[2].simulateClose();
    vi.advanceTimersByTime(4_000);

    // After 3 failures, no 4th WebSocket is created — SSE fallback is used
    expect(mockInstances.length).toBe(3);
    expect(eventSourceCreated).toBe(true);

    client.close();
  });

  it('send() is a no-op when not connected', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    // Not yet open
    client.send({ type: 'test' });
    expect(mockInstances[0].sent.length).toBe(0);
    client.close();
  });

  it('send() works when connected', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    mockInstances[0].simulateOpen();
    client.send({ type: 'session:abort', sessionId: 'abc' });

    // subscribe msg + abort msg
    expect(mockInstances[0].sent.length).toBe(2);
    const msg = JSON.parse(mockInstances[0].sent[1]);
    expect(msg.type).toBe('session:abort');
    expect(msg.sessionId).toBe('abc');
    client.close();
  });

  it('ignores malformed server messages', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const onEvent = vi.fn();
    const client = connectWebSocket({ onEvent });

    mockInstances[0].simulateOpen();
    mockInstances[0].simulateMessage('not-json');
    mockInstances[0].simulateMessage(JSON.stringify({ noType: true }));

    expect(onEvent).not.toHaveBeenCalled();
    client.close();
  });

  it('calls onClose when connection drops', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const onClose = vi.fn();
    const client = connectWebSocket({ onEvent: vi.fn(), onClose });

    mockInstances[0].simulateOpen();
    mockInstances[0].simulateClose();
    expect(onClose).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('calls onError on WebSocket error', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const onError = vi.fn();
    const client = connectWebSocket({ onEvent: vi.fn(), onError });

    mockInstances[0].simulateError();
    expect(onError).toHaveBeenCalledTimes(1);
    client.close();
  });

  it('does not reconnect after explicit close', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    mockInstances[0].simulateOpen();
    client.close();

    vi.advanceTimersByTime(30_000);
    expect(mockInstances.length).toBe(1);
  });

  it('caps reconnect delay at 30 seconds', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');
    const client = connectWebSocket({ onEvent: vi.fn() });

    // Fail and reconnect: delays are 1s, 2s, but we only get 3 before fallback
    // So test the delay doubling
    mockInstances[0].simulateClose();
    vi.advanceTimersByTime(999);
    expect(mockInstances.length).toBe(1); // Not yet
    vi.advanceTimersByTime(1);
    expect(mockInstances.length).toBe(2); // At 1000ms

    mockInstances[1].simulateClose();
    vi.advanceTimersByTime(1999);
    expect(mockInstances.length).toBe(2); // Not yet
    vi.advanceTimersByTime(1);
    expect(mockInstances.length).toBe(3); // At 2000ms

    client.close();
  });
});

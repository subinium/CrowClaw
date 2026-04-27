/**
 * Coverage for the dashboard's WS fallback + reconnect surface.
 *
 * Issue #141 (web side): when the WebSocket connection fails three times
 * in a row, the client must (a) switch to the SSE-only fallback, (b) fire
 * `onFallback` so the UI can render the banner, and (c) expose a
 * `reconnect()` method that drops the SSE channel and starts a fresh WS
 * attempt with the failure counter reset.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal Mock WebSocket — we control readyState transitions per-instance.
// ---------------------------------------------------------------------------

class MockWS {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWS[] = [];

  readyState = MockWS.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((e?: CloseEvent) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  url: string;
  sent: string[] = [];

  constructor(url: string) {
    this.url = url;
    MockWS.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = MockWS.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }

  // Test helper: simulate a connection failure.
  failOpen() {
    this.readyState = MockWS.CLOSED;
    this.onclose?.(new CloseEvent('close'));
  }
}

// EventSource stub for the SSE fallback path.
class MockES {
  static instances: MockES[] = [];
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();

  constructor(public url: string) {
    MockES.instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    const arr = this.listeners.get(type) ?? [];
    arr.push(fn);
    this.listeners.set(type, arr);
  }

  close() { /* no-op */ }
}

beforeEach(() => {
  MockWS.instances = [];
  MockES.instances = [];
  vi.useFakeTimers();
  vi.stubGlobal('location', { protocol: 'http:', host: 'test.local' });
  vi.stubGlobal('WebSocket', MockWS as unknown as typeof WebSocket);
  vi.stubGlobal('EventSource', MockES as unknown as typeof EventSource);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('connectWebSocket fallback machinery', () => {
  it('fires onFallback once after three consecutive WS failures', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');

    const onFallback = vi.fn();
    const onEvent = vi.fn();

    const client = connectWebSocket({ onEvent, onFallback });

    // First WS attempt — fail it.
    expect(MockWS.instances.length).toBe(1);
    MockWS.instances[0].failOpen();

    // Reconnect timer #1 (1s)
    vi.advanceTimersByTime(1000);
    expect(MockWS.instances.length).toBe(2);
    MockWS.instances[1].failOpen();

    // Reconnect timer #2 (2s, exponential backoff)
    vi.advanceTimersByTime(2000);
    expect(MockWS.instances.length).toBe(3);
    MockWS.instances[2].failOpen();

    // Third failure schedules another connect; the next pass detects
    // consecutiveFailures >= 3 and routes to SSE fallback instead.
    vi.advanceTimersByTime(4000);

    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(MockES.instances.length).toBe(1);
    expect(client.isFallback()).toBe(true);

    client.close();
  });

  it('reconnect() drops SSE, resets failure count, and starts a fresh WS attempt', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');

    const onReconnect = vi.fn();
    const onFallback = vi.fn();
    const client = connectWebSocket({ onEvent: vi.fn(), onFallback, onReconnect });

    // Drive into fallback.
    MockWS.instances[0].failOpen();
    vi.advanceTimersByTime(1000);
    MockWS.instances[1].failOpen();
    vi.advanceTimersByTime(2000);
    MockWS.instances[2].failOpen();
    vi.advanceTimersByTime(4000);
    expect(client.isFallback()).toBe(true);

    const wsCountBefore = MockWS.instances.length;

    // Manual reconnect — should not wait for backoff.
    client.reconnect();

    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(MockWS.instances.length).toBe(wsCountBefore + 1);
    expect(client.isFallback()).toBe(false);

    client.close();
  });

  it('does not fire onFallback when WS opens cleanly', async () => {
    const { connectWebSocket } = await import('../packages/web/ui/src/lib/ws.js');

    const onFallback = vi.fn();
    const onOpen = vi.fn();

    const client = connectWebSocket({ onEvent: vi.fn(), onFallback, onOpen });

    const ws = MockWS.instances[0];
    ws.readyState = MockWS.OPEN;
    ws.onopen?.();

    expect(onOpen).toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
    expect(client.isFallback()).toBe(false);
    expect(client.isConnected()).toBe(true);

    client.close();
  });
});

/**
 * v0.6.1 reliability + security sweep — runtime-node shutdown / body cap.
 *
 * Covers:
 * - #115 wsManager.stop() called in shutdown()
 * - #116 bridgeProcesses Map cleanup on terminate + prune dead entries
 * - #118 lastHeartbeatAt EventBus listener unsubscribed in shutdown
 * - #119 contextRefresh interval cleared in shutdown
 * - #120 GatewayDebouncer.flush() called in shutdown
 * - #123 child handle.removeAllListeners + null on terminate
 * - #124 RateLimiter eviction off-by-one when oldest === current key
 * - #128 1 MiB body size cap on POST routes (with chunked-stream defense)
 */
import { describe, expect, it } from 'vitest';
import {
  createNodeRuntime,
  GatewayDebouncer,
  RateLimiter,
  MAX_REQUEST_BODY_BYTES,
  checkContentLengthCap,
  readJsonWithSizeCap,
} from '../packages/runtime-node/src/index.js';
import {
  terminateBridgeProcess,
  pruneDeadBridgeProcesses,
  type BridgeProcessRecord,
} from '../packages/runtime-node/src/bridge-process.js';
import { EchoProvider } from '@crowclaw/providers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeChildHandle {
  pid?: number;
  killed: boolean;
  listenersByEvent: Map<string, Array<(code: number | null) => void>>;
  removeAllCalled: number;
  killCalls: number;
  kill(_signal?: string): boolean;
  on(event: string, cb: (code: number | null) => void): void;
  removeAllListeners(event?: string): void;
  unref(): void;
}

function makeFakeHandle(): FakeChildHandle {
  const handle: FakeChildHandle = {
    pid: 99999,
    killed: false,
    listenersByEvent: new Map(),
    removeAllCalled: 0,
    killCalls: 0,
    kill(_signal?: string) {
      this.killed = true;
      this.killCalls += 1;
      return true;
    },
    on(event, cb) {
      const arr = this.listenersByEvent.get(event) ?? [];
      arr.push(cb);
      this.listenersByEvent.set(event, arr);
    },
    removeAllListeners(event?: string) {
      this.removeAllCalled += 1;
      if (event) this.listenersByEvent.delete(event);
      else this.listenersByEvent.clear();
    },
    unref() { /* noop */ },
  };
  return handle;
}

function makeBridgeRecord(sessionId: string, alive = true, startedAt = new Date().toISOString()): BridgeProcessRecord & { handle: FakeChildHandle } {
  const handle = makeFakeHandle();
  handle.on('exit', () => { /* noop */ });
  // pruneDeadBridgeProcesses only collects records that ACTUALLY ran and then
  // exited (have exitedAt). Simulated / spawn-error records (alive=false from
  // birth, no exitedAt) stay visible. Tests for the dead-and-cleaned path must
  // stamp exitedAt alongside alive=false to model a real terminated process.
  return {
    sessionId,
    protocolVersion: 'crowclaw-tool-bridge/v1',
    pid: handle.pid,
    command: 'fake',
    mode: 'child-process',
    socketPath: `/tmp/${sessionId}.sock`,
    socketReady: true,
    supportedDirectTools: ['echo'],
    alive,
    startedAt,
    handle,
    ...(alive ? {} : { exitedAt: new Date().toISOString(), exitCode: 0 }),
  };
}

// ---------------------------------------------------------------------------
// #115 / #118 / #119 / #120 — shutdown wiring
// ---------------------------------------------------------------------------

describe('createNodeRuntime shutdown (#115/#118/#119/#120)', () => {
  it('runs to completion without throwing and reports drained debouncer count', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    const summary = await runtime.shutdown();
    expect(summary).toBeDefined();
    expect(typeof summary.ssEClosed).toBe('number');
    expect(typeof summary.learningAwaited).toBe('number');
    expect(typeof summary.debouncerFlushed).toBe('number');
    expect(summary.debouncerFlushed).toBe(0);
  });

  it('is idempotent — calling shutdown twice does not throw', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    await runtime.shutdown();
    await expect(runtime.shutdown()).resolves.toBeDefined();
  });

  it('back-to-back createNodeRuntime() does not leave the process pinned', async () => {
    // If wsManager.stop / contextRefresh / heartbeat-tracker leaked, the
    // intervals would still keep firing — we can't easily prove "no extra
    // intervals" from inside the runtime, but we can at least prove that
    // shutting down two consecutive runtimes succeeds and reports clean
    // counts. This guards against regressions where the second runtime
    // can't shut down because the first one's listeners are still wired.
    const a = createNodeRuntime({ provider: new EchoProvider() });
    const b = createNodeRuntime({ provider: new EchoProvider() });
    await a.shutdown();
    await b.shutdown();
  });
});

// ---------------------------------------------------------------------------
// #120 — GatewayDebouncer.flush
// ---------------------------------------------------------------------------

describe('GatewayDebouncer.flush (#120)', () => {
  it('drains pending entries and resolves their promises with merged text', async () => {
    const d = new GatewayDebouncer(10_000);
    const p = d.debounce('discord', 'u1', 'c1', 'hello');
    expect(d.pendingCount).toBe(1);
    const drained = d.flush();
    expect(drained).toBe(1);
    expect(d.pendingCount).toBe(0);
    await expect(p).resolves.toBe('hello');
  });

  it('returns 0 when nothing is pending', () => {
    const d = new GatewayDebouncer(10_000);
    expect(d.flush()).toBe(0);
  });

  it('handles multiple pending entries across distinct keys', async () => {
    const d = new GatewayDebouncer(10_000);
    const a = d.debounce('discord', 'u1', 'c1', 'a');
    const b = d.debounce('telegram', 'u2', 'c2', 'b');
    expect(d.pendingCount).toBe(2);
    expect(d.flush()).toBe(2);
    await expect(a).resolves.toBe('a');
    await expect(b).resolves.toBe('b');
  });
});

// ---------------------------------------------------------------------------
// #124 — RateLimiter eviction off-by-one
// ---------------------------------------------------------------------------

describe('RateLimiter eviction (#124)', () => {
  it('does not exceed maxKeys when the oldest key happens to be the current key', () => {
    const rl = new RateLimiter({ maxKeys: 2 });
    expect(rl.check('a', 100, 60_000)).toBe(true);
    expect(rl.check('b', 100, 60_000)).toBe(true);
    // Third distinct key inserts at size=3, then evicts down to 2.
    expect(rl.check('c', 100, 60_000)).toBe(true);
    expect(rl.size).toBe(2);
    // Re-checking 'a' (which was likely evicted) inserts again, growing
    // to 3 then evicting back to 2 — never to 3.
    expect(rl.check('a', 100, 60_000)).toBe(true);
    expect(rl.size).toBe(2);
  });

  it('caps the Map size after many distinct keys', () => {
    const rl = new RateLimiter({ maxKeys: 3 });
    for (let i = 0; i < 50; i++) {
      rl.check(`key-${i}`, 100, 60_000);
    }
    expect(rl.size).toBe(3);
  });

  it('never evicts the entry just inserted', () => {
    const rl = new RateLimiter({ maxKeys: 1 });
    rl.check('first', 100, 60_000);
    rl.check('second', 100, 60_000);
    expect(rl.size).toBe(1);
    // 'second' must still be tracked — if eviction picked the just-inserted
    // key the size would be 0 here, or the next call to 'second' would
    // re-insert it as if it were a fresh client (silently doubling allowance).
    expect(rl.check('second', 1, 60_000)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// #116 / #123 — bridge process termination + prune
// ---------------------------------------------------------------------------

describe('terminateBridgeProcess (#116/#123)', () => {
  it('removes the entry from the Map after terminate', () => {
    const map = new Map<string, BridgeProcessRecord>();
    const rec = makeBridgeRecord('s1');
    map.set('s1', rec);
    terminateBridgeProcess(map, 's1');
    expect(map.has('s1')).toBe(false);
    expect(map.size).toBe(0);
  });

  it('detaches all child-process listeners and nulls the handle', () => {
    const map = new Map<string, BridgeProcessRecord>();
    const rec = makeBridgeRecord('s2');
    const handle = rec.handle as FakeChildHandle;
    map.set('s2', rec);
    const out = terminateBridgeProcess(map, 's2');
    expect(out).toBeDefined();
    expect(handle.removeAllCalled).toBeGreaterThanOrEqual(1);
    expect(handle.listenersByEvent.size).toBe(0);
    // The record returned by terminate had its handle nulled.
    expect(out!.handle).toBeNull();
  });

  it('returns undefined for unknown sessionId', () => {
    const map = new Map<string, BridgeProcessRecord>();
    expect(terminateBridgeProcess(map, 'nope')).toBeUndefined();
  });

  it('does not throw when the handle has no removeAllListeners (legacy shape)', () => {
    const map = new Map<string, BridgeProcessRecord>();
    map.set('s3', {
      sessionId: 's3',
      protocolVersion: 'v1',
      command: 'x',
      mode: 'simulated',
      socketPath: '/tmp/x.sock',
      socketReady: false,
      supportedDirectTools: [],
      alive: false,
      startedAt: new Date().toISOString(),
    });
    expect(() => terminateBridgeProcess(map, 's3')).not.toThrow();
    expect(map.size).toBe(0);
  });
});

describe('pruneDeadBridgeProcesses (#116)', () => {
  it('removes entries whose alive flag is false', () => {
    const map = new Map<string, BridgeProcessRecord>();
    map.set('a', makeBridgeRecord('a', false));
    map.set('b', makeBridgeRecord('b', true));
    map.set('c', makeBridgeRecord('c', false));
    const removed = pruneDeadBridgeProcesses(map);
    expect(removed).toBe(2);
    expect(map.size).toBe(1);
    expect(map.has('b')).toBe(true);
  });

  it('removes entries whose startedAt is older than maxAgeMs', () => {
    const map = new Map<string, BridgeProcessRecord>();
    const oldTime = new Date(Date.now() - 7_200_000).toISOString(); // 2h old
    map.set('old', makeBridgeRecord('old', true, oldTime));
    map.set('young', makeBridgeRecord('young', true));
    const removed = pruneDeadBridgeProcesses(map, 60 * 60 * 1000);
    expect(removed).toBe(1);
    expect(map.has('old')).toBe(false);
    expect(map.has('young')).toBe(true);
  });

  it('handles 100 spawn-then-terminate cycles without leaking the Map', () => {
    const map = new Map<string, BridgeProcessRecord>();
    for (let i = 0; i < 100; i++) {
      map.set(`s${i}`, makeBridgeRecord(`s${i}`));
    }
    expect(map.size).toBe(100);
    for (let i = 0; i < 100; i++) {
      terminateBridgeProcess(map, `s${i}`);
    }
    expect(map.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// #128 — 1 MiB body size cap
// ---------------------------------------------------------------------------

describe('checkContentLengthCap (#128)', () => {
  it('returns null when content-length is absent', () => {
    const req = new Request('http://localhost/x', { method: 'POST' });
    expect(checkContentLengthCap(req)).toBeNull();
  });

  it('returns null for sizes within the cap', () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': '1024' },
      body: 'small body',
    });
    expect(checkContentLengthCap(req)).toBeNull();
  });

  it('returns 413 when content-length exceeds the cap', () => {
    const tooBig = String(MAX_REQUEST_BODY_BYTES + 1);
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': tooBig },
    });
    const res = checkContentLengthCap(req);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(413);
  });

  it('returns 400 when content-length is malformed', () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': 'not-a-number' },
    });
    const res = checkContentLengthCap(req);
    expect(res!.status).toBe(400);
  });
});

describe('readJsonWithSizeCap (#128)', () => {
  it('parses a small JSON body normally', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const out = await readJsonWithSizeCap<{ a: number }>(req);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.value.a).toBe(1);
  });

  it('rejects a body whose declared content-length exceeds the cap before reading', async () => {
    const tooBig = String(MAX_REQUEST_BODY_BYTES + 1);
    // We can't easily construct a real oversized stream — the header gate
    // alone is enough for this test. The streaming gate is exercised below
    // with a synthetic ReadableStream that omits the header.
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': tooBig, 'content-type': 'application/json' },
      body: JSON.stringify({ a: 1 }),
    });
    const out = await readJsonWithSizeCap(req);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.response.status).toBe(413);
  });

  it('aborts a chunked stream that exceeds the cap (no Content-Length)', async () => {
    // Build a ReadableStream that streams >1 MiB without setting a header.
    const chunk = new Uint8Array(64 * 1024); // 64 KiB
    chunk.fill(0x61); // 'a'
    let pushed = 0;
    const totalToPush = MAX_REQUEST_BODY_BYTES + 256 * 1024; // 1.25 MiB

    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pushed >= totalToPush) {
          controller.close();
          return;
        }
        controller.enqueue(chunk);
        pushed += chunk.byteLength;
      },
    });

    const req = new Request('http://localhost/x', {
      method: 'POST',
      // Deliberately no content-length — simulates chunked transfer.
      body: stream,
      // @ts-expect-error — undici needs duplex for streaming bodies.
      duplex: 'half',
    });
    const out = await readJsonWithSizeCap(req);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.response.status).toBe(413);
  });

  it('returns 400 when the body is not valid JSON', async () => {
    const req = new Request('http://localhost/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json {',
    });
    const out = await readJsonWithSizeCap(req);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.response.status).toBe(400);
  });
});

describe('runtime fetch — body size cap (#128)', () => {
  it('rejects a POST whose content-length exceeds the cap', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    const tooBig = String(MAX_REQUEST_BODY_BYTES + 1);
    const res = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'content-length': tooBig, 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'whatever' }),
    }));
    expect(res.status).toBe(413);
  });

  it('still accepts a normal-sized auth/verify POST', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    const res = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'wrong' }),
    }));
    // Either 200 ({ok:false}) or 429 if previous tests in the file
    // pre-warmed the rate limiter; both prove it didn't 413.
    expect(res.status).not.toBe(413);
  });

  it('rejects a POST with a malformed content-length header', async () => {
    const runtime = createNodeRuntime({ provider: new EchoProvider() });
    const res = await runtime.fetch(new Request('http://localhost/api/auth/verify', {
      method: 'POST',
      headers: { 'content-length': 'banana', 'content-type': 'application/json' },
      body: JSON.stringify({ token: 'x' }),
    }));
    expect(res.status).toBe(400);
  });
});

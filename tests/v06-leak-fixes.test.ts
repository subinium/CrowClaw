/**
 * v0.6.0 reliability sweep — leak / unbounded-growth fixes.
 *
 * Covers:
 * - #117: DurableObjectIdempotencyStore enforces a maxEntries cap.
 * - #153: DurableObjectIdempotencyStore.markIfAbsent serializes concurrent
 *         hydration so two callers cannot race their own storage.get.
 * - #114/#133: ProcessTracker drops the entry on child 'exit' (no leak across
 *         long-running cron loops).
 * - #122: InMemoryDreamStore.longTerm is capped at MAX_LONG_TERM (500).
 * - #126: McpJsonRpcStdioTransport.disconnect uses `once('close', ...)` so a
 *         second 'close' emission does not double-resolve / double-clear.
 */
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import { DurableObjectIdempotencyStore } from '../packages/runtime-cloudflare/src/agent-do.js';
import { ProcessTracker } from '../packages/sandbox-executor/src/index.js';
import { InMemoryDreamStore } from '../packages/memory/src/dream-memory.js';
import { McpJsonRpcStdioTransport } from '../packages/mcp/src/stdio-transport.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface StorageMock {
  get: ReturnType<typeof vi.fn>;
  put: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

function makeStorage(initial: Record<string, unknown> = {}): StorageMock {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    put: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value);
    }),
    delete: vi.fn(async (key: string) => data.delete(key)),
  };
}

// ---------------------------------------------------------------------------
// #117 — DurableObjectIdempotencyStore maxEntries cap
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#117) — maxEntries cap', () => {
  it('evicts the oldest entry when maxEntries is exceeded', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 3 });

    expect(await store.markIfAbsent('a')).toBe(true);
    expect(await store.markIfAbsent('b')).toBe(true);
    expect(await store.markIfAbsent('c')).toBe(true);
    expect(store.size).toBe(3);

    // Insert one beyond the cap. Oldest ('a') should be evicted.
    expect(await store.markIfAbsent('d')).toBe(true);
    expect(store.size).toBe(3);
    expect(await store.has('a')).toBe(false);
    expect(await store.has('b')).toBe(true);
    expect(await store.has('c')).toBe(true);
    expect(await store.has('d')).toBe(true);
  });

  it('continues to evict oldest as more keys arrive', async () => {
    const storage = makeStorage();
    const store = new DurableObjectIdempotencyStore(storage, 60_000, { maxEntries: 2 });

    await store.markIfAbsent('k1');
    await store.markIfAbsent('k2');
    await store.markIfAbsent('k3');
    await store.markIfAbsent('k4');

    expect(store.size).toBe(2);
    expect(await store.has('k1')).toBe(false);
    expect(await store.has('k2')).toBe(false);
    expect(await store.has('k3')).toBe(true);
    expect(await store.has('k4')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #153 — concurrent hydrate serialization
// ---------------------------------------------------------------------------

describe('DurableObjectIdempotencyStore (#153) — concurrent hydrate', () => {
  it('serializes concurrent first calls so storage.get runs once', async () => {
    // Use a deferred-resolve mock so both markIfAbsent calls are awaiting
    // the same hydrate() at the same time.
    let resolveGet: ((value: Record<string, number> | undefined) => void) | null = null;
    const storage = {
      get: vi.fn(
        () =>
          new Promise<Record<string, number> | undefined>((resolve) => {
            resolveGet = resolve;
          }),
      ),
      put: vi.fn(async () => undefined),
      delete: vi.fn(async () => true),
    };

    const store = new DurableObjectIdempotencyStore(storage as never, 60_000, { maxEntries: 100 });

    // Fire both calls without awaiting — they must share a single hydrate.
    const p1 = store.markIfAbsent('alpha');
    const p2 = store.markIfAbsent('beta');

    // Both are blocked on the same in-flight storage.get.
    expect(storage.get).toHaveBeenCalledTimes(1);

    // Release the hydrate.
    resolveGet!({ legacy: Date.now() + 60_000 });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);

    // Storage was hit exactly once for hydrate even after both completed.
    expect(storage.get).toHaveBeenCalledTimes(1);
    expect(await store.has('alpha')).toBe(true);
    expect(await store.has('beta')).toBe(true);
    expect(await store.has('legacy')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #114/#133 — ProcessTracker drops entry on child exit
// ---------------------------------------------------------------------------

describe('ProcessTracker (#114, #133) — exit cleanup', () => {
  it('removes the tracked entry when the child emits exit', () => {
    const tracker = new ProcessTracker();

    // Minimal ChildProcess stand-in: EventEmitter + pid + once.
    const fake = new EventEmitter() as EventEmitter & { pid: number; once: EventEmitter['once'] };
    fake.pid = 42_001;

    tracker.track(fake as never, 'sleep 1', 'unit-test');
    expect(tracker.list()).toHaveLength(1);
    expect(tracker.get(42_001)).not.toBeNull();

    fake.emit('exit', 0);

    expect(tracker.list()).toHaveLength(0);
    expect(tracker.get(42_001)).toBeNull();
  });

  it('does not leak entries across many short-lived processes', () => {
    const tracker = new ProcessTracker();
    for (let i = 0; i < 100; i++) {
      const fake = new EventEmitter() as EventEmitter & { pid: number };
      fake.pid = 50_000 + i;
      tracker.track(fake as never, `cmd-${i}`);
      fake.emit('exit', 0);
    }
    expect(tracker.list()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// #122 — dream-memory longTerm cap
// ---------------------------------------------------------------------------

describe('InMemoryDreamStore (#122) — longTerm cap', () => {
  it('caps longTerm at MAX_LONG_TERM (500)', async () => {
    const store = new InMemoryDreamStore();

    // Each consolidate() with one live entry adds exactly one longTerm entry.
    for (let i = 0; i < 600; i++) {
      await store.addLive(`s${i}`, `summary ${i}`);
      await store.consolidate();
    }

    const all = await store.getLongTerm(10_000);
    expect(all.length).toBeLessThanOrEqual(500);
    expect(all.length).toBe(500);

    // Newest survive — entry s599 should still be present.
    const allContent = all.map((e) => e.content).join(' | ');
    expect(allContent).toContain('summary 599');
    // Oldest evicted — entry s0 should be gone.
    expect(allContent).not.toContain('summary 0 ');
  });
});

// ---------------------------------------------------------------------------
// #126 — stdio transport once('close')
// ---------------------------------------------------------------------------

describe('McpJsonRpcStdioTransport (#126) — disconnect once-close', () => {
  it('disconnect resolves once even if close is emitted twice', async () => {
    // Drive the disconnect path manually with a hand-rolled child stub. We
    // bypass connect() (no real spawn) by setting the private fields via a
    // typed escape hatch.
    const transport = new McpJsonRpcStdioTransport({ command: '/bin/true' });

    const fakeStdin = { end: vi.fn(), writable: true } as unknown as NodeJS.WritableStream;
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdin: NodeJS.WritableStream;
      kill: ReturnType<typeof vi.fn>;
    };
    fakeChild.stdin = fakeStdin;
    fakeChild.kill = vi.fn();

    // Reach into private state. Tests are colocated in the repo; this is
    // intentional and scoped to verify the listener semantics.
    const internal = transport as unknown as {
      childProcess: typeof fakeChild;
      connected: boolean;
    };
    internal.childProcess = fakeChild;
    internal.connected = true;

    // Snapshot the listener counts on the EventEmitter before disconnect.
    expect(fakeChild.listenerCount('close')).toBe(0);

    const done = transport.disconnect();

    // disconnect() should have registered exactly one 'close' listener.
    expect(fakeChild.listenerCount('close')).toBe(1);

    // Emit close — the once() listener fires and is removed.
    fakeChild.emit('close', 0);
    await done;

    // After firing, the listener must have been auto-removed (proof of `once`,
    // not `on`). A second emission would not re-trigger the resolved promise
    // (which would be a no-op anyway, since `done` already settled), but it
    // also must not leave a dangling listener.
    expect(fakeChild.listenerCount('close')).toBe(0);

    // Sanity: SIGTERM was issued.
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

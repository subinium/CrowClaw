// ---------------------------------------------------------------------------
// #314 — /steer and /queue over ACP
//
// Acceptance criteria from the issue:
//   - [x] IDE plugin (mock ACP client) can call `acp.steer` and the agent
//         picks up guidance at next iteration
//   - [x] `acp.queue` multiple messages while agent is mid-run; all drained
//         at next user turn in order
//   - [x] Session restart preserves queue and reasoning metadata
//   - [x] Tests cover ordering, concurrent steer + queue, and persistence
// ---------------------------------------------------------------------------

import { describe, it, expect, vi } from 'vitest';
import {
  AcpServer,
  type AcpAgentLoop,
} from '../packages/acp/src/index.js';
import {
  createPendingQueueStore,
  enqueueMessage,
  drainPendingQueue,
  peekPendingQueue,
  pendingQueueLength,
  assembleNextUserMessage,
  buildQueueAnnotation,
  serializeQueue,
  restoreQueue,
  OPERATOR_QUEUE_SEPARATOR,
  type QueuedUserMessage,
} from '../packages/core/src/queue.js';

// ---------------------------------------------------------------------------
// Pure queue-primitive tests
// ---------------------------------------------------------------------------

describe('pending queue primitive (#314)', () => {
  it('enqueueMessage stores in order', () => {
    const store = createPendingQueueStore();
    expect(enqueueMessage(store, 's1', { content: 'first', queuedAt: '2026-01-01T00:00:00.000Z' })).toBe(true);
    expect(enqueueMessage(store, 's1', { content: 'second', queuedAt: '2026-01-01T00:00:01.000Z' })).toBe(true);
    const peeked = peekPendingQueue(store, 's1');
    expect(peeked.map((m) => m.content)).toEqual(['first', 'second']);
  });

  it('drops empty / whitespace-only messages', () => {
    const store = createPendingQueueStore();
    expect(enqueueMessage(store, 's1', { content: '', queuedAt: 'x' })).toBe(false);
    expect(enqueueMessage(store, 's1', { content: '   \t\n  ', queuedAt: 'x' })).toBe(false);
    expect(pendingQueueLength(store, 's1')).toBe(0);
  });

  it('drainPendingQueue empties the slot and preserves order', () => {
    const store = createPendingQueueStore();
    enqueueMessage(store, 's1', { content: 'a', queuedAt: '1' });
    enqueueMessage(store, 's1', { content: 'b', queuedAt: '2' });
    enqueueMessage(store, 's1', { content: 'c', queuedAt: '3' });
    const drained = drainPendingQueue(store, 's1');
    expect(drained.map((m) => m.content)).toEqual(['a', 'b', 'c']);
    // Re-drain is empty
    expect(drainPendingQueue(store, 's1')).toEqual([]);
    expect(pendingQueueLength(store, 's1')).toBe(0);
  });

  it('queues are per-session (no cross-leakage)', () => {
    const store = createPendingQueueStore();
    enqueueMessage(store, 's1', { content: 'one', queuedAt: '1' });
    enqueueMessage(store, 's2', { content: 'two', queuedAt: '2' });
    expect(peekPendingQueue(store, 's1').map((m) => m.content)).toEqual(['one']);
    expect(peekPendingQueue(store, 's2').map((m) => m.content)).toEqual(['two']);
  });

  it('assembleNextUserMessage concatenates with the operator separator', () => {
    const drained: QueuedUserMessage[] = [
      { content: 'extra context A', queuedAt: '1' },
      { content: 'and B', queuedAt: '2' },
    ];
    const merged = assembleNextUserMessage('base', drained);
    expect(merged.startsWith('base')).toBe(true);
    expect(merged).toContain(OPERATOR_QUEUE_SEPARATOR);
    expect(merged).toContain('extra context A');
    expect(merged).toContain('and B');
    // The two queued fragments come in order
    expect(merged.indexOf('extra context A')).toBeLessThan(merged.indexOf('and B'));
  });

  it('assembleNextUserMessage with empty base trims the leading separator', () => {
    const merged = assembleNextUserMessage('', [
      { content: 'only', queuedAt: '1' },
    ]);
    // No leading newline / separator chrome — operator content starts cleanly
    expect(merged.startsWith('[OPERATOR')).toBe(true);
    expect(merged).toContain('only');
  });

  it('buildQueueAnnotation returns null when nothing was drained', () => {
    expect(buildQueueAnnotation([])).toBeNull();
  });

  it('buildQueueAnnotation produces a system-role message tagged with the count', () => {
    const drained: QueuedUserMessage[] = [
      { content: 'x', queuedAt: '1', source: 'acp.queue' },
      { content: 'y', queuedAt: '2', source: 'ws.queue' },
    ];
    const annotation = buildQueueAnnotation(drained);
    expect(annotation).not.toBeNull();
    expect(annotation!.role).toBe('system');
    expect(annotation!.content).toContain('OPERATOR QUEUE DRAINED 2');
    expect(annotation!.content).toContain('acp.queue');
    expect(annotation!.content).toContain('ws.queue');
    expect(annotation!.metadata?.queueDrained).toBe(true);
    expect(annotation!.metadata?.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Persistence round-trip — covers the "session restart preserves queue" AC
// ---------------------------------------------------------------------------

describe('queue persistence round-trip (#314)', () => {
  it('serializeQueue → restoreQueue preserves ordering and metadata', () => {
    const original = createPendingQueueStore();
    enqueueMessage(original, 's1', {
      content: 'first',
      queuedAt: '2026-01-01T00:00:00.000Z',
      source: 'acp.queue',
      id: 'q-1',
    });
    enqueueMessage(original, 's1', {
      content: 'second',
      queuedAt: '2026-01-01T00:00:01.000Z',
      source: 'ws.queue',
    });
    enqueueMessage(original, 's2', { content: 'other', queuedAt: '2026-01-01T00:00:02.000Z' });

    const snapshot = serializeQueue(original);
    // Re-create the store as if from a cold restart
    const rehydrated = createPendingQueueStore();
    restoreQueue(rehydrated, snapshot);

    const s1 = peekPendingQueue(rehydrated, 's1');
    expect(s1.map((m) => m.content)).toEqual(['first', 'second']);
    expect(s1[0].source).toBe('acp.queue');
    expect(s1[0].id).toBe('q-1');
    const s2 = peekPendingQueue(rehydrated, 's2');
    expect(s2.map((m) => m.content)).toEqual(['other']);
  });

  it('serializeQueue skips empty sessions', () => {
    const store = createPendingQueueStore();
    enqueueMessage(store, 's1', { content: 'x', queuedAt: '1' });
    drainPendingQueue(store, 's1');
    enqueueMessage(store, 's2', { content: 'y', queuedAt: '2' });
    const snap = serializeQueue(store);
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe('s2');
  });

  it('restoreQueue is a no-op on null / undefined input', () => {
    const store = createPendingQueueStore();
    restoreQueue(store, null);
    restoreQueue(store, undefined);
    expect(store.size).toBe(0);
  });

  it('restoreQueue ignores malformed entries (defensive)', () => {
    const store = createPendingQueueStore();
    // @ts-expect-error — intentionally malformed
    restoreQueue(store, [{ sessionId: '', messages: [] }, { sessionId: 'ok', messages: 'nope' }]);
    expect(store.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ACP server: acp.steer / acp.queue / acp.queue.list method handlers
// ---------------------------------------------------------------------------

describe('AcpServer steer + queue methods (#314)', () => {
  // Mock loop tracks every call so tests can assert dispatch order.
  type SteerCall = { sessionId: string; guidance: string };
  type QueueCall = { sessionId: string; message: string; options?: { source?: string; id?: string } };

  function makeLoop() {
    const steerCalls: SteerCall[] = [];
    const queueCalls: QueueCall[] = [];
    let peekResult: QueuedUserMessage[] = [];
    const loop: AcpAgentLoop = {
      run: vi.fn().mockResolvedValue({ finalResponse: 'ok', toolResults: [] }),
      steer: (sessionId: string, guidance: string) => {
        steerCalls.push({ sessionId, guidance });
      },
      queue: (sessionId: string, message: string, options) => {
        queueCalls.push({ sessionId, message, ...(options ? { options } : {}) });
        return message.trim().length > 0;
      },
      peekQueue: (_sessionId: string) => peekResult,
    };
    return {
      loop,
      steerCalls,
      queueCalls,
      setPeek: (v: QueuedUserMessage[]) => {
        peekResult = v;
      },
    };
  }

  async function createSession(server: AcpServer): Promise<string> {
    const create = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'sessions/create',
    });
    return (create.result as { id: string }).id;
  }

  it('acp.steer dispatches to AgentLoop.steer with sessionId + guidance', async () => {
    const { loop, steerCalls } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'acp.steer',
      params: { sessionId, guidance: 'focus on tests' },
    });

    expect(response.error).toBeUndefined();
    expect((response.result as { ok: boolean }).ok).toBe(true);
    expect(steerCalls).toEqual([{ sessionId, guidance: 'focus on tests' }]);
  });

  it('acp.steer accepts legacy `message` param alias', async () => {
    const { loop, steerCalls } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'session/steer',
      params: { sessionId, message: 'use the legacy alias' },
    });

    expect(steerCalls).toEqual([{ sessionId, guidance: 'use the legacy alias' }]);
  });

  it('acp.steer rejects missing params', async () => {
    const { loop } = makeLoop();
    const server = new AcpServer(loop);
    await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'acp.steer',
      params: { sessionId: 'wat' },
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32600);
  });

  it('acp.steer returns METHOD_NOT_FOUND when loop omits steer hook', async () => {
    const minimalLoop: AcpAgentLoop = {
      run: vi.fn().mockResolvedValue({ finalResponse: 'x', toolResults: [] }),
    };
    const server = new AcpServer(minimalLoop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'acp.steer',
      params: { sessionId, guidance: 'whatever' },
    });

    expect(response.error?.code).toBe(-32601);
  });

  it('acp.queue dispatches to AgentLoop.queue and returns ack', async () => {
    const { loop, queueCalls } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 20,
      method: 'acp.queue',
      params: { sessionId, message: 'follow-up A', id: 'client-1' },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { ok: boolean; queued: boolean; id?: string };
    expect(result.ok).toBe(true);
    expect(result.queued).toBe(true);
    expect(result.id).toBe('client-1');
    expect(queueCalls).toEqual([
      { sessionId, message: 'follow-up A', options: { source: 'acp.queue', id: 'client-1' } },
    ]);
  });

  it('acp.queue preserves caller-supplied source', async () => {
    const { loop, queueCalls } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    await server.handleRequest({
      jsonrpc: '2.0',
      id: 21,
      method: 'acp.queue',
      params: { sessionId, message: 'from zed', source: 'zed.plugin' },
    });

    expect(queueCalls[0].options?.source).toBe('zed.plugin');
  });

  it('acp.queue reports queued=false for empty content (drop signal)', async () => {
    const { loop } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 22,
      method: 'acp.queue',
      params: { sessionId, message: '   ' },
    });

    expect((response.result as { ok: boolean; queued: boolean }).queued).toBe(false);
  });

  it('acp.queue rejects unknown session', async () => {
    const { loop } = makeLoop();
    const server = new AcpServer(loop);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 23,
      method: 'acp.queue',
      params: { sessionId: 'no-such-session', message: 'x' },
    });
    expect(response.error?.code).toBe(-32600);
  });

  it('acp.queue returns METHOD_NOT_FOUND when loop omits queue hook', async () => {
    const minimalLoop: AcpAgentLoop = {
      run: vi.fn().mockResolvedValue({ finalResponse: 'x', toolResults: [] }),
    };
    const server = new AcpServer(minimalLoop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 24,
      method: 'acp.queue',
      params: { sessionId, message: 'x' },
    });
    expect(response.error?.code).toBe(-32601);
  });

  it('acp.queue.list returns current pending queue without draining', async () => {
    const { loop, setPeek } = makeLoop();
    setPeek([
      { content: 'a', queuedAt: '2026-01-01T00:00:00.000Z', source: 'acp.queue' },
      { content: 'b', queuedAt: '2026-01-01T00:00:01.000Z' },
    ]);
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 30,
      method: 'acp.queue.list',
      params: { sessionId },
    });

    const result = response.result as { available: boolean; messages: QueuedUserMessage[] };
    expect(result.available).toBe(true);
    expect(result.messages.map((m) => m.content)).toEqual(['a', 'b']);
  });

  it('acp.queue.list returns available=false when loop omits peekQueue', async () => {
    const minimalLoop: AcpAgentLoop = {
      run: vi.fn().mockResolvedValue({ finalResponse: 'x', toolResults: [] }),
    };
    const server = new AcpServer(minimalLoop);
    const sessionId = await createSession(server);

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 31,
      method: 'acp.queue.list',
      params: { sessionId },
    });

    const result = response.result as { available: boolean; messages: QueuedUserMessage[] };
    expect(result.available).toBe(false);
    expect(result.messages).toEqual([]);
  });

  it('concurrent steer + queue calls land on the same session in order', async () => {
    const { loop, steerCalls, queueCalls } = makeLoop();
    const server = new AcpServer(loop);
    const sessionId = await createSession(server);

    // Fire interleaved steer + queue calls; resolve order should match dispatch order.
    await Promise.all([
      server.handleRequest({
        jsonrpc: '2.0',
        id: 40,
        method: 'acp.steer',
        params: { sessionId, guidance: 'steer-1' },
      }),
      server.handleRequest({
        jsonrpc: '2.0',
        id: 41,
        method: 'acp.queue',
        params: { sessionId, message: 'queue-1' },
      }),
      server.handleRequest({
        jsonrpc: '2.0',
        id: 42,
        method: 'acp.queue',
        params: { sessionId, message: 'queue-2' },
      }),
      server.handleRequest({
        jsonrpc: '2.0',
        id: 43,
        method: 'acp.steer',
        params: { sessionId, guidance: 'steer-2' },
      }),
    ]);

    expect(steerCalls.map((c) => c.guidance)).toEqual(['steer-1', 'steer-2']);
    expect(queueCalls.map((c) => c.message)).toEqual(['queue-1', 'queue-2']);
  });
});

// ---------------------------------------------------------------------------
// AgentLoop integration — queue/steer + iteration-end drain + restore
// ---------------------------------------------------------------------------

describe('AgentLoop queue + restore (#314)', () => {
  // Minimal smoke test against the real AgentLoop instance.
  // We don't run end-to-end with a provider here — the iteration-end drain
  // is exercised by other tests (agent-loop.test, etc.) for the LLM path.
  // What we care about: enqueue + drain via the public API + persistence round-trip.

  it('AgentLoop exposes queue, peekQueue, drainQueue, and persistence helpers', async () => {
    const { AgentLoop } = await import('../packages/core/src/index.js');
    const { EchoProvider } = await import('../packages/providers/src/index.js');
    const { InMemorySessionStore } = await import('../packages/storage/src/index.js');
    const { ToolRegistry, createEchoTool } = await import('../packages/tools/src/index.js');

    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore());

    expect(agent.queue('s1', 'first follow-up', { source: 'test', id: 'q-1' })).toBe(true);
    expect(agent.queue('s1', '   ', { source: 'test' })).toBe(false);
    expect(agent.queue('s1', 'second follow-up', { source: 'test', id: 'q-2' })).toBe(true);

    expect(agent.queueLength('s1')).toBe(2);
    const peeked = agent.peekQueue('s1');
    expect(peeked.map((m) => m.content)).toEqual(['first follow-up', 'second follow-up']);
    expect(peeked[0].id).toBe('q-1');
    expect(peeked[1].id).toBe('q-2');

    // Snapshot for persistence
    const snap = agent.serializePendingQueue();
    expect(snap).toHaveLength(1);
    expect(snap[0].sessionId).toBe('s1');

    // Drain consumes the queue
    const drained = agent.drainQueue('s1');
    expect(drained.map((m) => m.content)).toEqual(['first follow-up', 'second follow-up']);
    expect(agent.queueLength('s1')).toBe(0);

    // Restore brings them back as if the host rebooted
    agent.restorePendingQueue(snap);
    expect(agent.queueLength('s1')).toBe(2);
  });
});

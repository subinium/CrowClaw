/**
 * E2E: Hermes Module Runtime Wiring
 *
 * Verifies that ContextEngine, FrozenMemory, MessageStore, and memory tools
 * are properly wired into the runtime — not just exported/tested in isolation.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

const TEST_TOKEN = 'test-hermes-wiring';
beforeAll(() => { process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN; });
afterAll(() => { delete process.env.CROWCLAW_DASHBOARD_TOKEN; });

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

function createTestRuntime() {
  return createNodeRuntime({ configStorePath: null, schedulerStorePath: null });
}

// ---------------------------------------------------------------------------
// FrozenMemory lifecycle through runtime
// ---------------------------------------------------------------------------

describe('FrozenMemory runtime lifecycle', () => {
  it('set → get → snapshot round-trip through API', async () => {
    const runtime = createTestRuntime();

    // Set a frozen memory entry
    const setRes = await runtime.fetch(
      new Request('http://localhost/api/memory/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ namespace: 'memory', action: 'set', key: 'project', value: 'CrowClaw v0.3.1', category: 'fact' }),
      }),
    );
    const setData = await setRes.json();
    expect(setData.ok).toBe(true);
    expect(setData.size).toBeGreaterThanOrEqual(1);

    // Read snapshot
    const getRes = await runtime.fetch(
      new Request('http://localhost/api/memory/snapshot', { headers: authHeaders }),
    );
    const getData = await getRes.json();
    expect(getData.ok).toBe(true);
    expect(getData.memory.entries.length).toBeGreaterThanOrEqual(1);
    expect(getData.memory.entries.some((e: { key: string }) => e.key === 'project')).toBe(true);
  });

  it('remove entry through API', async () => {
    const runtime = createTestRuntime();

    await runtime.fetch(
      new Request('http://localhost/api/memory/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ namespace: 'memory', action: 'set', key: 'temp', value: 'will be removed' }),
      }),
    );

    const removeRes = await runtime.fetch(
      new Request('http://localhost/api/memory/snapshot', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ namespace: 'memory', action: 'remove', key: 'temp' }),
      }),
    );
    const removeData = await removeRes.json();
    expect(removeData.ok).toBe(true);

    // Verify the entry is gone
    const snapshot = await runtime.fetch(
      new Request('http://localhost/api/memory/snapshot', { headers: authHeaders }),
    );
    const snapData = await snapshot.json();
    const hasTemp = snapData.memory.entries.some((e: { key: string }) => e.key === 'temp');
    expect(hasTemp).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// MessageStore recording through runtime
// ---------------------------------------------------------------------------

describe('MessageStore runtime recording', () => {
  it('records messages after sending a chat message', async () => {
    const runtime = createTestRuntime();
    const sid = 'msg-store-test-1';

    // Send a message (EchoProvider will echo it back)
    await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ userMessage: 'hello world' }),
      }),
    );

    // Wait for fire-and-forget message store write
    await new Promise((r) => setTimeout(r, 100));

    // Check messages were recorded
    const msgsRes = await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/messages`, { headers: authHeaders }),
    );
    const msgsData = await msgsRes.json();
    expect(msgsData.ok).toBe(true);
    expect(msgsData.messages.length).toBeGreaterThanOrEqual(1);
  });

  it('returns stats for a session', async () => {
    const runtime = createTestRuntime();
    const sid = 'msg-store-stats-1';

    await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/message`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ userMessage: 'test stats' }),
      }),
    );

    await new Promise((r) => setTimeout(r, 100));

    const statsRes = await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/stats`, { headers: authHeaders }),
    );
    const statsData = await statsRes.json();
    expect(statsData.ok).toBe(true);
    expect(statsData.totalMessages).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Session compact e2e (happy path)
// ---------------------------------------------------------------------------

describe('Session compact e2e', () => {
  it('creates session, sends messages, compacts, verifies reduction', async () => {
    const runtime = createTestRuntime();
    const sid = 'compact-test-1';

    // Send multiple messages to build up history
    for (let i = 0; i < 5; i++) {
      await runtime.fetch(
        new Request(`http://localhost/api/sessions/${sid}/message`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...authHeaders },
          body: JSON.stringify({ userMessage: `message ${i}` }),
        }),
      );
    }

    // Check session has messages
    const beforeRes = await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/history`, { headers: authHeaders }),
    );
    const beforeData = await beforeRes.json();
    const beforeCount = beforeData.messages?.length ?? 0;
    expect(beforeCount).toBeGreaterThan(5);

    // Compact
    const compactRes = await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/compact`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ keepLastN: 3 }),
      }),
    );
    const compactData = await compactRes.json();
    expect(compactData.ok).toBe(true);
    expect(compactData.compactedMessageCount).toBeLessThan(compactData.originalMessageCount);

    // Verify reduction
    const afterRes = await runtime.fetch(
      new Request(`http://localhost/api/sessions/${sid}/history`, { headers: authHeaders }),
    );
    const afterData = await afterRes.json();
    expect(afterData.messages.length).toBeLessThan(beforeCount);
  });
});

// ---------------------------------------------------------------------------
// memory.set / memory.remove tools registered
// ---------------------------------------------------------------------------

describe('Frozen memory tools registered', () => {
  it('memory.set and memory.remove appear in tool list', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/tools', { headers: authHeaders }),
    );
    const data = await res.json();
    const toolNames = data.tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('memory.set');
    expect(toolNames).toContain('memory.remove');
  });
});

// ---------------------------------------------------------------------------
// ContextEngine status
// ---------------------------------------------------------------------------

describe('ContextEngine runtime status', () => {
  it('returns context discovery results', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/context', { headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(Array.isArray(data.files)).toBe(true);
    expect(typeof data.totalBytes).toBe('number');
    expect(Array.isArray(data.securityWarnings)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

describe('Diagnostics completeness', () => {
  it('returns all expected fields', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/diagnostics', { headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.runtime).toBe('node');
    expect(typeof data.nodeVersion).toBe('string');
    expect(typeof data.platform).toBe('string');
    expect(typeof data.wsConnections).toBe('number');
    expect(typeof data.activeSessions).toBe('number');
    expect(typeof data.eventBusSubscribers).toBe('number');
    expect(typeof data.uptime).toBe('number');
    // lastHeartbeat may be null initially
    expect(data).toHaveProperty('lastHeartbeat');
  });
});

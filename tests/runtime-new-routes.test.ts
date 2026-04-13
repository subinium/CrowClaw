import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

const TEST_TOKEN = 'test-new-routes-token';
beforeAll(() => { process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN; });
afterAll(() => { delete process.env.CROWCLAW_DASHBOARD_TOKEN; });

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

function createTestRuntime() {
  const tools = [
    { name: 'echo', originalName: 'echo', registeredName: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
  ];
  return createNodeRuntime({
    mcpClient: {
      listTools: async () => tools,
      listResources: async () => [],
      listPrompts: async () => [],
      getStatus: () => ({
        toolsRevision: 0, cachedTools: 1, supportsResources: true,
        supportsPrompts: true, degraded: false, lastError: undefined, lastRefreshAt: undefined,
      }),
      refreshTools: async () => tools,
      notifyToolsChanged: async () => ({ ok: true, refreshed: tools }),
      callTool: async (name: string, args: Record<string, unknown>) => ({ ok: true, content: { name, args } }),
      inspect: async () => ({
        status: { toolsRevision: 0, cachedTools: 1, supportsResources: true, supportsPrompts: true, degraded: false },
        tools, resources: [], prompts: [],
      }),
      verify: async () => ({ ok: true, toolCount: 1, latencyMs: 10 }),
    } as never,
    configStorePath: null,
  });
}

const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

// ---------------------------------------------------------------------------
// Config schema routes
// ---------------------------------------------------------------------------

describe('Config schema routes', () => {
  it('GET /api/config/schema returns schema with sections', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/config/schema', { headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.version).toBeTruthy();
    expect(Array.isArray(data.sections)).toBe(true);
    expect(data.sections.length).toBeGreaterThanOrEqual(5);

    const sectionIds = data.sections.map((s: { id: string }) => s.id);
    expect(sectionIds).toContain('agent');
    expect(sectionIds).toContain('security');
    expect(sectionIds).toContain('provider');
  });

  it('POST /api/config/validate accepts valid agent config', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          section: 'agent',
          data: { maxToolIterations: 10, concurrentToolCalls: true },
        }),
      }),
    );
    const data = await res.json();
    expect(data.valid).toBe(true);
    expect(data.errors).toHaveLength(0);
  });

  it('POST /api/config/validate rejects out-of-range value', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          section: 'agent',
          data: { maxToolIterations: 999 },
        }),
      }),
    );
    const data = await res.json();
    expect(data.valid).toBe(false);
    expect(data.errors.length).toBeGreaterThan(0);
  });

  it('POST /api/config/diff detects changes', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/config/diff', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          before: { agent: { maxToolIterations: 10 } },
          after: { agent: { maxToolIterations: 20 } },
        }),
      }),
    );
    const data = await res.json();
    expect(data.changes.length).toBeGreaterThan(0);
    expect(data.timestamp).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Session control routes
// ---------------------------------------------------------------------------

describe('Session control routes', () => {
  it('GET /api/sessions/active returns empty initially', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/sessions/active', { headers: authHeaders }),
    );
    const data = await res.json();
    expect(data.sessions).toEqual([]);
  });

  it('POST /api/sessions/:id/abort returns false for non-active session', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/sessions/nonexistent/abort', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: '{}',
      }),
    );
    const data = await res.json();
    expect(data.ok).toBe(false);
    expect(data.aborted).toBe(false);
  });

  it('POST /api/sessions/:id/compact returns 404 for missing session', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/sessions/missing/compact', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ keepLastN: 5 }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/sessions/:id/steer returns 400 without directive', async () => {
    const runtime = createTestRuntime();

    // First create a session by sending a message
    await runtime.fetch(
      new Request('http://localhost/api/sessions/steer-test/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({ userMessage: 'hello' }),
      }),
    );

    const res = await runtime.fetch(
      new Request('http://localhost/api/sessions/steer-test/steer', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// WebSocket route
// ---------------------------------------------------------------------------

describe('WebSocket route', () => {
  it('GET /ws without upgrade returns response', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/ws', { headers: authHeaders }),
    );
    // Without proper WebSocket upgrade headers, should still respond
    expect(res).toBeTruthy();
  });
});

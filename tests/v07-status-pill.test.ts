/**
 * Issue #177 — connection status indicator coverage.
 *
 * Two surfaces to lock down:
 *   1. The pure aggregation helper (`aggregateStatus`) that maps a
 *      diagnostics payload to an overall red/yellow/green color.
 *   2. The `/api/diagnostics` runtime route that now emits the four
 *      sub-checks the pill consumes (`transport`, `provider`,
 *      `scheduler`, `mcp`).
 *
 * The Lit element itself isn't rendered here — vitest runs in a `node`
 * environment so there's no `customElements` registry to drive. The
 * aggregation helper is the load-bearing logic, and it's exported as a
 * pure function for exactly this reason.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import {
  aggregateStatus,
  STATUS_PILL_ACTIONS,
  type DiagnosticsResponse,
} from '../packages/web/ui/src/components/status-pill.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

// ---------------------------------------------------------------------------
// Pure aggregation logic
// ---------------------------------------------------------------------------

describe('aggregateStatus', () => {
  const allHealthy: DiagnosticsResponse = {
    transport: { ws: true, sse: true },
    provider: { configured: true, reachable: true, lastCallOk: true },
    scheduler: { running: true, errored: false },
    mcp: { total: 2, connected: 2, degraded: 0 },
  };

  it('returns green when every sub-check is green', () => {
    const status = aggregateStatus(allHealthy);
    expect(status.color).toBe('green');
    expect(status.transport.color).toBe('green');
    expect(status.provider.color).toBe('green');
    expect(status.scheduler.color).toBe('green');
    expect(status.mcp.color).toBe('green');
  });

  it('falls back to SSE yellow when WS is down but SSE is up', () => {
    const status = aggregateStatus({
      ...allHealthy,
      transport: { ws: false, sse: true },
    });
    expect(status.transport.color).toBe('yellow');
    expect(status.color).toBe('yellow');
  });

  it('marks transport red when both WS and SSE are unavailable', () => {
    const status = aggregateStatus({
      ...allHealthy,
      transport: { ws: false, sse: false },
    });
    expect(status.transport.color).toBe('red');
    expect(status.color).toBe('red');
  });

  it('marks provider red when lastCallOk is false', () => {
    const status = aggregateStatus({
      ...allHealthy,
      provider: { configured: true, reachable: true, lastCallOk: false },
    });
    expect(status.provider.color).toBe('red');
    expect(status.color).toBe('red');
  });

  it('marks provider yellow when configured but unreachable (no explicit failure yet)', () => {
    const status = aggregateStatus({
      ...allHealthy,
      provider: { configured: true, reachable: false, lastCallOk: null },
    });
    expect(status.provider.color).toBe('yellow');
    expect(status.color).toBe('yellow');
  });

  it('treats a missing provider as gray, not red', () => {
    const status = aggregateStatus({
      ...allHealthy,
      provider: { configured: false, reachable: false, lastCallOk: null },
    });
    expect(status.provider.color).toBe('gray');
    // Gray must never promote the rollup to red — every other check is
    // green so the pill stays green.
    expect(status.color).toBe('green');
  });

  it('marks scheduler red when errored, regardless of running flag', () => {
    const status = aggregateStatus({
      ...allHealthy,
      scheduler: { running: true, errored: true },
    });
    expect(status.scheduler.color).toBe('red');
    expect(status.color).toBe('red');
  });

  it('marks scheduler yellow (paused) when not running and not errored', () => {
    const status = aggregateStatus({
      ...allHealthy,
      scheduler: { running: false, errored: false },
    });
    expect(status.scheduler.color).toBe('yellow');
    expect(status.color).toBe('yellow');
  });

  it('marks MCP yellow when any server is degraded', () => {
    const status = aggregateStatus({
      ...allHealthy,
      mcp: { total: 3, connected: 2, degraded: 1 },
    });
    expect(status.mcp.color).toBe('yellow');
    expect(status.mcp.label).toContain('2/3');
    expect(status.color).toBe('yellow');
  });

  it('marks MCP gray when no servers are configured', () => {
    const status = aggregateStatus({
      ...allHealthy,
      mcp: { total: 0, connected: 0, degraded: 0 },
    });
    expect(status.mcp.color).toBe('gray');
    // Gray MCP doesn't pull the rollup down.
    expect(status.color).toBe('green');
  });

  it('any single red dominates yellow + green', () => {
    const status = aggregateStatus({
      transport: { ws: false, sse: false }, // red
      provider: { configured: true, reachable: false, lastCallOk: null }, // yellow
      scheduler: { running: true, errored: false }, // green
      mcp: { total: 1, connected: 1, degraded: 0 }, // green
    });
    expect(status.color).toBe('red');
  });

  it('null payload renders as red transport (the fetch failed)', () => {
    const status = aggregateStatus(null);
    expect(status.transport.color).toBe('red');
    expect(status.color).toBe('red');
  });

  it('exports stable action event names so the orchestrator can wire matching listeners', () => {
    expect(STATUS_PILL_ACTIONS.reconnectWs).toBe('crowclaw-action-reconnect-ws');
    expect(STATUS_PILL_ACTIONS.testProvider).toBe('crowclaw-action-test-provider');
    expect(STATUS_PILL_ACTIONS.resumeScheduler).toBe('crowclaw-action-resume-scheduler');
  });
});

// ---------------------------------------------------------------------------
// /api/diagnostics extension
// ---------------------------------------------------------------------------

const TEST_TOKEN = 'test-status-pill-token';
beforeAll(() => {
  process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN;
});
afterAll(() => {
  delete process.env.CROWCLAW_DASHBOARD_TOKEN;
});

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() })),
}));

const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

interface DiagnosticsBody extends DiagnosticsResponse {
  ok: boolean;
  runtime: string;
  wsConnections: number;
  activeSessions: number;
}

const createTestRuntime = (overrides?: { mcpDegraded?: boolean; mcpServers?: number }) => {
  const tools = [
    { name: 'echo', originalName: 'echo', registeredName: 'echo', description: 'Echo', inputSchema: { type: 'object' } },
  ];
  const degraded = overrides?.mcpDegraded ?? false;
  const serverCount = overrides?.mcpServers ?? 1;

  // Build a multi-server stub when the test wants more than one server.
  const serverStatus: Record<string, { degraded: boolean; lastError: undefined; toolsRevision: number; cachedTools: number; supportsResources: boolean; supportsPrompts: boolean; lastRefreshAt: undefined }> = {};
  for (let i = 0; i < serverCount; i++) {
    serverStatus[`srv${i}`] = {
      toolsRevision: 0,
      cachedTools: 1,
      supportsResources: true,
      supportsPrompts: true,
      degraded: i === 0 && degraded,
      lastError: undefined,
      lastRefreshAt: undefined,
    };
  }

  return createNodeRuntime({
    mcpClient: {
      listTools: async () => tools,
      listResources: async () => [],
      listPrompts: async () => [],
      getStatus: () => serverStatus.srv0,
      getServerStatus: () => serverStatus,
      refreshTools: async () => tools,
      notifyToolsChanged: async () => ({ ok: true, refreshed: tools }),
      callTool: async (name: string, args: Record<string, unknown>) => ({ ok: true, content: { name, args } }),
      inspect: async () => ({
        status: serverStatus.srv0,
        tools,
        resources: [],
        prompts: [],
      }),
      verify: async () => ({ ok: true, toolCount: 1, latencyMs: 10 }),
    } as never,
    configStorePath: null,
  });
};

describe('GET /api/diagnostics — issue #177 sub-checks', () => {
  it('emits transport / provider / scheduler / mcp sub-objects with correct shapes', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/diagnostics', { headers: authHeaders }),
    );
    const data = (await res.json()) as DiagnosticsBody;

    expect(data.ok).toBe(true);

    // Transport
    expect(data.transport).toBeDefined();
    expect(typeof data.transport?.ws).toBe('boolean');
    expect(typeof data.transport?.sse).toBe('boolean');
    // SSE is always available (the route is mounted unconditionally).
    expect(data.transport?.sse).toBe(true);

    // Provider — no provider configured in createTestRuntime, so configured
    // must be false and reachable must mirror that. lastCallOk is null
    // until a tracker is wired, but it MUST be present in the payload.
    expect(data.provider).toBeDefined();
    expect(typeof data.provider?.configured).toBe('boolean');
    expect(typeof data.provider?.reachable).toBe('boolean');
    expect('lastCallOk' in (data.provider ?? {})).toBe(true);
    expect(data.provider?.configured).toBe(false);
    expect(data.provider?.reachable).toBe(false);

    // Scheduler
    expect(data.scheduler).toBeDefined();
    expect(typeof data.scheduler?.running).toBe('boolean');
    expect(typeof data.scheduler?.errored).toBe('boolean');
    expect(data.scheduler?.errored).toBe(false);

    // MCP — single healthy stub server.
    expect(data.mcp).toBeDefined();
    expect(data.mcp?.total).toBe(1);
    expect(data.mcp?.connected).toBe(1);
    expect(data.mcp?.degraded).toBe(0);
  });

  it('surfaces MCP degraded count when a server reports degraded: true', async () => {
    const runtime = createTestRuntime({ mcpDegraded: true, mcpServers: 2 });
    const res = await runtime.fetch(
      new Request('http://localhost/api/diagnostics', { headers: authHeaders }),
    );
    const data = (await res.json()) as DiagnosticsBody;

    expect(data.mcp?.total).toBe(2);
    expect(data.mcp?.degraded).toBe(1);
    expect(data.mcp?.connected).toBe(1);

    // Aggregation should yield yellow on the rollup since transport
    // (ws) is also down in the test runtime (no clients connected).
    const status = aggregateStatus(data);
    // WS is not connected in tests → transport yellow, MCP yellow → overall yellow.
    expect(status.color).toBe('yellow');
  });

  it('preserves the legacy fields the older Overview panel reads', async () => {
    const runtime = createTestRuntime();
    const res = await runtime.fetch(
      new Request('http://localhost/api/diagnostics', { headers: authHeaders }),
    );
    const data = (await res.json()) as DiagnosticsBody;

    // Don't break the existing /api/diagnostics consumers.
    expect(data.runtime).toBe('node');
    expect(typeof data.wsConnections).toBe('number');
    expect(typeof data.activeSessions).toBe('number');
  });
});

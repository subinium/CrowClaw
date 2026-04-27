/**
 * v0.6.1 — issue sweep tests for the mcp/providers/acp surfaces.
 *
 *   #80  McpClient sessionIdleTtlMs eviction + dispose on one-shot exit
 *   #81  providers seedManifestCacheFromPlugin / readPluginManifestModelCatalog
 *   #103 stdio-transport exponential-backoff reconnect
 *   #148 AcpServer tools/list registry callback (`available` flag)
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpClient,
  MultiServerMcpManager,
  type McpTransport,
} from '../packages/mcp/src/index.js';
import { McpJsonRpcStdioTransport } from '../packages/mcp/src/stdio-transport.js';
import {
  loadManifest,
  resetManifestCache,
  readPluginManifestModelCatalog,
  seedManifestCacheFromPlugin,
  hasPluginManifestModelCatalog,
  DEFAULT_MANIFEST_URL,
  type ManifestCache,
} from '../packages/providers/src/model-catalog.js';
import { AcpServer, type AcpToolInfo } from '../packages/acp/src/index.js';

// -----------------------------------------------------------------------------
// helpers
// -----------------------------------------------------------------------------

function makeFakeTransport(): McpTransport & { disconnect: ReturnType<typeof vi.fn> } {
  return {
    listTools: vi.fn(async () => [{ name: 'search', description: 'Search docs' }]),
    callTool: vi.fn(async (name: string, args: Record<string, unknown>) => ({
      ok: true,
      content: { name, args },
    })),
    listResources: vi.fn(async () => []),
    listPrompts: vi.fn(async () => []),
    disconnect: vi.fn(async () => undefined),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// =============================================================================
// #80 — McpClient sessionIdleTtlMs + dispose
// =============================================================================

describe('#80 McpClient sessionIdleTtlMs eviction', () => {
  it('does not evict when sessionIdleTtlMs is unset', async () => {
    let now = 1_000_000;
    const transport = makeFakeTransport();
    const client = new McpClient(transport, { now: () => now });

    await client.callTool('search', {});
    now += 999_999_999;

    expect(client.isIdle()).toBe(false);
    expect(await client.sweepIfIdle()).toBe(false);
    expect(client.isDisposed()).toBe(false);
  });

  it('reports idle once now - lastUsedAt exceeds the TTL', async () => {
    let now = 1_000_000;
    const transport = makeFakeTransport();
    const client = new McpClient(transport, {
      sessionIdleTtlMs: 60_000,
      now: () => now,
    });

    await client.callTool('search', {});
    now += 30_000;
    expect(client.isIdle()).toBe(false);

    now += 31_000; // total 61s idle
    expect(client.isIdle()).toBe(true);
    expect(client.getIdleMs()).toBe(61_000);
  });

  it('sweepIfIdle disposes idle clients and tears down the transport', async () => {
    let now = 1_000_000;
    const transport = makeFakeTransport();
    const client = new McpClient(transport, {
      sessionIdleTtlMs: 1_000,
      now: () => now,
    });

    await client.listTools();
    expect(client.isDisposed()).toBe(false);

    now += 5_000;
    const evicted = await client.sweepIfIdle();
    expect(evicted).toBe(true);
    expect(client.isDisposed()).toBe(true);
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects further calls after dispose()', async () => {
    const transport = makeFakeTransport();
    const client = new McpClient(transport);
    await client.dispose();
    await expect(client.callTool('search', {})).rejects.toThrow(/disposed/);
    await expect(client.refreshTools()).rejects.toThrow(/disposed/);
  });

  it('dispose() is idempotent', async () => {
    const transport = makeFakeTransport();
    const client = new McpClient(transport);
    await client.dispose();
    await client.dispose();
    expect(transport.disconnect).toHaveBeenCalledTimes(1);
  });

  it('touch is updated on every successful op', async () => {
    let now = 1_000;
    const transport = makeFakeTransport();
    const client = new McpClient(transport, { now: () => now });

    const t0 = client.getLastUsedAt();
    now = 5_000;
    await client.callTool('search', {});
    expect(client.getLastUsedAt()).toBe(5_000);
    expect(client.getLastUsedAt()).toBeGreaterThan(t0);

    now = 9_000;
    await client.listResources();
    expect(client.getLastUsedAt()).toBe(9_000);
  });

  it('MultiServerMcpManager.sweepIdle evicts only idle servers', async () => {
    let now = 1_000_000;
    const hot = makeFakeTransport();
    const cold = makeFakeTransport();
    const hotClient = new McpClient(hot, { sessionIdleTtlMs: 60_000, now: () => now });
    const coldClient = new McpClient(cold, { sessionIdleTtlMs: 60_000, now: () => now });

    await hotClient.callTool('search', {});
    await coldClient.callTool('search', {});

    now += 30_000;
    await hotClient.callTool('search', {}); // refresh hot

    now += 40_000; // hot idle 40s, cold idle 70s
    const manager = new MultiServerMcpManager({ hot: hotClient, cold: coldClient });

    const evicted = await manager.sweepIdle();
    expect(evicted).toEqual(['cold']);
    expect(hotClient.isDisposed()).toBe(false);
    expect(coldClient.isDisposed()).toBe(true);
  });

  it('MultiServerMcpManager.disposeAll tears every server down', async () => {
    const a = makeFakeTransport();
    const b = makeFakeTransport();
    const manager = new MultiServerMcpManager({
      a: new McpClient(a),
      b: new McpClient(b),
    });
    await manager.disposeAll();
    expect(a.disconnect).toHaveBeenCalledTimes(1);
    expect(b.disconnect).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// #81 — providers plugin manifest cold-read
// =============================================================================

describe('#81 providers plugin manifest cold-read', () => {
  const sampleEntry = {
    id: 'cold-model',
    contextLength: 256_000,
    supportsTools: true,
    supportsImages: false,
    supportsStreaming: true,
  };

  it('readPluginManifestModelCatalog parses a valid plugin manifest', () => {
    const manifest = {
      name: 'crowclaw-model-pack',
      modelCatalog: {
        updatedAt: '2026-04-27',
        models: [sampleEntry],
      },
    };
    const parsed = readPluginManifestModelCatalog(manifest);
    expect(parsed).not.toBeNull();
    expect(parsed?.models).toHaveLength(1);
    expect(parsed?.models[0]?.id).toBe('cold-model');
    expect(parsed?.updatedAt).toBe('2026-04-27');
  });

  it('returns null when modelCatalog is missing', () => {
    expect(readPluginManifestModelCatalog({ name: 'bare' })).toBeNull();
    expect(readPluginManifestModelCatalog(null)).toBeNull();
    expect(readPluginManifestModelCatalog(undefined)).toBeNull();
  });

  it('filters out malformed entries instead of throwing', () => {
    const manifest = {
      modelCatalog: {
        models: [
          sampleEntry,
          { id: 'bad', contextLength: 'not-a-number' },
          { id: 42 }, // wrong type
          null,
          { ...sampleEntry, id: 'second-good' },
        ],
      },
    };
    const parsed = readPluginManifestModelCatalog(manifest);
    expect(parsed?.models.map((m) => m.id)).toEqual(['cold-model', 'second-good']);
  });

  it('hasPluginManifestModelCatalog narrows correctly', () => {
    expect(hasPluginManifestModelCatalog({ modelCatalog: { models: [] } })).toBe(true);
    expect(hasPluginManifestModelCatalog({ modelCatalog: { models: 'nope' } })).toBe(false);
    expect(hasPluginManifestModelCatalog({})).toBe(false);
  });

  it('seedManifestCacheFromPlugin makes the next loadManifest cold-read from cache', async () => {
    const cache: ManifestCache = new Map();
    const fetchMock = vi.fn(async () =>
      Response.json({
        updatedAt: '2099-01-01',
        models: [
          {
            id: 'remote-only',
            contextLength: 1,
            supportsTools: false,
            supportsImages: false,
            supportsStreaming: false,
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const seeded = seedManifestCacheFromPlugin(
      { modelCatalog: { models: [sampleEntry], updatedAt: '2026-04-27' } },
      { cache, url: DEFAULT_MANIFEST_URL },
    );
    expect(seeded).toBe(true);

    // Cold read — must serve from cache and avoid the network round-trip.
    const manifest = await loadManifest(DEFAULT_MANIFEST_URL, cache);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(manifest.models[0]?.id).toBe('cold-model');
  });

  it('seedManifestCacheFromPlugin returns false when the manifest has no catalog', () => {
    const cache: ManifestCache = new Map();
    expect(seedManifestCacheFromPlugin({ name: 'no-catalog' }, { cache })).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('does not interfere with the default cache when a fresh Map is passed', () => {
    resetManifestCache();
    const cache: ManifestCache = new Map();
    seedManifestCacheFromPlugin(
      { modelCatalog: { models: [sampleEntry] } },
      { cache },
    );
    expect(cache.size).toBe(1);
  });
});

// =============================================================================
// #103 — stdio-transport exponential-backoff reconnect
// =============================================================================

describe('#103 stdio-transport exponential-backoff reconnect', () => {
  /**
   * Drive `maybeScheduleReconnect` directly in unit tests. We stub `connect`
   * to a no-op so the timer firing doesn't try to spawn anything, and we
   * also clear the timer slot ourselves between manual invocations to
   * simulate sequential close events.
   */
  function driveTransport(transport: McpJsonRpcStdioTransport) {
    const internal = transport as unknown as {
      maybeScheduleReconnect: () => void;
      reconnectTimer: ReturnType<typeof setTimeout> | null;
      connect: () => Promise<void>;
    };
    // Replace connect with a no-op to keep the test hermetic.
    internal.connect = async () => {};
    return internal;
  }

  it('schedules reconnect with 1s/2s/4s backoff after unexpected close', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcStdioTransport(
      { command: 'noop' },
      { autoReconnect: true, onReconnect },
    );
    const internal = driveTransport(transport);

    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenLastCalledWith(1, 1000);

    vi.advanceTimersByTime(1000); // fires (no-op connect), clears timer slot
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenLastCalledWith(2, 2000);

    vi.advanceTimersByTime(2000);
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenLastCalledWith(3, 4000);
  });

  it('caps at reconnectMaxAttempts (default 3)', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcStdioTransport(
      { command: 'noop' },
      { autoReconnect: true, onReconnect, reconnectMaxAttempts: 3 },
    );
    const internal = driveTransport(transport);

    for (let i = 0; i < 5; i++) {
      internal.maybeScheduleReconnect();
      vi.advanceTimersByTime(10_000); // flush whatever was scheduled
    }

    expect(onReconnect).toHaveBeenCalledTimes(3);
    expect(onReconnect.mock.calls.map((c) => c[0])).toEqual([1, 2, 3]);
  });

  it('does not schedule when autoReconnect is false', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcStdioTransport(
      { command: 'noop' },
      { autoReconnect: false, onReconnect },
    );
    const internal = driveTransport(transport);
    internal.maybeScheduleReconnect();
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('disconnect() suppresses any scheduled reconnect', async () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcStdioTransport(
      { command: 'noop' },
      { autoReconnect: true, onReconnect },
    );
    const internal = driveTransport(transport);
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenCalledTimes(1);

    // disconnect() returns early because !connected, but it must still
    // cancel the pending reconnect timer and set disconnectRequested.
    await transport.disconnect();

    vi.advanceTimersByTime(10_000);
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('honours custom reconnectInitialDelayMs', () => {
    vi.useFakeTimers();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcStdioTransport(
      { command: 'noop' },
      { autoReconnect: true, onReconnect, reconnectInitialDelayMs: 250 },
    );
    const internal = driveTransport(transport);
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenLastCalledWith(1, 250);

    vi.advanceTimersByTime(250);
    internal.maybeScheduleReconnect();
    expect(onReconnect).toHaveBeenLastCalledWith(2, 500);
  });
});

// =============================================================================
// #148 — AcpServer tools/list registry callback
// =============================================================================

describe('#148 AcpServer tools/list registry callback', () => {
  const noopLoop = {
    run: async () => ({ finalResponse: '', toolResults: [] }),
  };

  it('returns available=false when no tools callback is wired', async () => {
    const server = new AcpServer(noopLoop);
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
    });
    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ tools: [], available: false });
  });

  it('returns available=true and the registry tools when wired', async () => {
    const tools: AcpToolInfo[] = [
      { name: 'web.search', description: 'Search the web' },
      { name: 'fs.read', description: 'Read a file', inputSchema: { type: 'object' } },
    ];
    const server = new AcpServer(noopLoop, { tools: () => tools });

    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list',
    });
    expect(response.result).toEqual({ tools, available: true });
  });

  it('supports async tool callbacks', async () => {
    const tools: AcpToolInfo[] = [{ name: 'late.tool' }];
    const server = new AcpServer(noopLoop, {
      tools: async () => {
        await new Promise((r) => setTimeout(r, 1));
        return tools;
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/list',
    });
    expect(response.result).toEqual({ tools, available: true });
  });

  it('catches callback errors and reports available=false with an error message', async () => {
    const server = new AcpServer(noopLoop, {
      tools: () => {
        throw new Error('registry offline');
      },
    });
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
    });
    expect(response.error).toBeUndefined();
    const result = response.result as { tools: unknown[]; available: boolean; error?: string };
    expect(result.available).toBe(false);
    expect(result.tools).toEqual([]);
    expect(result.error).toMatch(/registry offline/);
  });
});

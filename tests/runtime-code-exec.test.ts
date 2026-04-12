import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({
    exec: vi.fn(async (command: string, options?: { cwd?: string }) => ({
      success: true,
      stdout: `sandbox:${command}:${options?.cwd ?? ''}`,
      stderr: '',
      exitCode: 0
    }))
  }))
}));

describe('runtime code exec routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('mcp.example.com/tools')) {
        return Response.json({ tools: [{ name: 'mcp-docs.search', description: 'Search docs' }] });
      }
      if (url.includes('mcp.example.com/resources')) {
        return Response.json({ resources: [] });
      }
      if (url.includes('mcp.example.com/prompts')) {
        return Response.json({ prompts: [] });
      }
      if (url.includes('mcp.example.com/tools/call')) {
        return Response.json({ ok: true, content: { proxied: true } });
      }
      return Response.json({});
    }));
  });

  it('executes code through the node runtime route', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request(localRoute(routePaths.code.exec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'python', code: 'print("hi")', cwd: '/workspace/demo', timeoutMs: 2500, toolBridge: true, maxToolCalls: 3 })
    }));

    const payload = await response.json() as { ok: boolean; output: string; metadata: { language: string; simulated: boolean; timeoutMs: number; toolBridgeRequested: boolean; maxToolCalls: number; stdout: string; stderr: string; command: string; toolBridgeMode: string; bridgeArtifacts?: { protocolVersion: string; bootstrapPython: string } } };
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('python -c');
    expect(payload.metadata).toMatchObject({ language: 'python', simulated: true, timeoutMs: 2500, toolBridgeRequested: true, maxToolCalls: 3 });
    expect(payload.metadata.stdout).toContain('python -c');
    expect(payload.metadata.stderr).toBe('');
    expect(payload.metadata.command).toContain('python -c');
    expect(payload.metadata.toolBridgeMode).toBe('session-artifacts');
    expect(payload.metadata.bridgeArtifacts?.protocolVersion).toBe('crowclaw-tool-bridge/v1');
    expect(payload.metadata.bridgeArtifacts?.bootstrapPython).toContain('def call_tool');
  });

  it('executes node.exec and python.exec through dedicated node runtime routes', async () => {
    const runtime = createNodeRuntime();

    const nodeResponse = await runtime.fetch(new Request(localRoute(routePaths.code.nodeExec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'console.log("hi")', cwd: '/workspace/node-app', timeoutMs: 1800, toolBridge: true, maxToolCalls: 2 })
    }));
    const nodePayload = await nodeResponse.json() as { toolName: string; ok: boolean; output: string; metadata: { language: string; simulated: boolean; timeoutMs: number; toolBridgeRequested: boolean; maxToolCalls: number; toolBridgeMode: string; bridgeArtifacts?: { socketPath: string } } };

    const pythonResponse = await runtime.fetch(new Request(localRoute(routePaths.code.pythonExec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'print("hi")', cwd: '/workspace/python-app', timeoutMs: 900 })
    }));
    const pythonPayload = await pythonResponse.json() as { toolName: string; ok: boolean; output: string; metadata: { language: string; simulated: boolean } };

    expect(nodePayload.ok).toBe(true);
    expect(nodePayload.toolName).toBe('node.exec');
    expect(nodePayload.output).toContain('node -e');
    expect(nodePayload.metadata).toMatchObject({ language: 'javascript', simulated: true, timeoutMs: 1800, toolBridgeRequested: true, maxToolCalls: 2 });
    expect(nodePayload.metadata.toolBridgeMode).toBe('session-artifacts');
    expect(nodePayload.metadata.bridgeArtifacts?.socketPath).toContain('crow-tool-bridge');

    expect(pythonPayload.ok).toBe(true);
    expect(pythonPayload.toolName).toBe('python.exec');
    expect(pythonPayload.output).toContain('python -c');
    expect(pythonPayload.metadata).toMatchObject({ language: 'python', simulated: true, timeoutMs: 900 });
  });

  it('forwards top-level Cloudflare code exec requests', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/code/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'javascript', code: 'console.log("hi")', cwd: '/workspace/app', timeoutMs: 1200, toolBridge: true, maxToolCalls: 2 })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { language: string; code: string; cwd: string; timeoutMs: number; toolBridge: boolean; maxToolCalls: number } };
    expect(payload.forwardedTo).toContain('/code/exec');
    expect(payload.body).toEqual({ language: 'javascript', code: 'console.log("hi")', cwd: '/workspace/app', timeoutMs: 1200, toolBridge: true, maxToolCalls: 2 });
  });

  it('returns explicit tool-bridge artifacts through node and Cloudflare bridge routes', async () => {
    const runtime = createNodeRuntime();
    const nodeBridge = await runtime.fetch(new Request(localRoute(routePaths.code.bridge), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-demo', maxToolCalls: 4 })
    }));
    const nodePayload = await nodeBridge.json() as { protocolVersion: string; socketPath: string; bootstrapPython: string };
    expect(nodePayload.protocolVersion).toBe('crowclaw-tool-bridge/v1');
    expect(nodePayload.socketPath).toContain('crow-tool-bridge-bridge-demo');
    expect(nodePayload.bootstrapPython).toContain('def call_tool');

    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };
    const cfBridge = await runtimeCloudflare.fetch(new Request('https://example.com/api/code/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-demo', maxToolCalls: 4 })
    }), env as never);
    const cfPayload = await cfBridge.json() as { forwardedTo: string; body: { sessionId: string; maxToolCalls: number } };
    expect(cfPayload.forwardedTo).toContain('/code/bridge');
    expect(cfPayload.body).toEqual({ sessionId: 'bridge-demo', maxToolCalls: 4 });
  });

  it('supports live bridge tool calls and transcript inspection through the node runtime', async () => {
    const runtime = createNodeRuntime();
    const created = await runtime.fetch(new Request(localRoute(routePaths.code.bridge), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1', maxToolCalls: 1, idleTimeoutMs: 10000 })
    }));
    expect((await created.json() as { sessionId: string }).sessionId).toBe('bridge-live-1');

    const call = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeCall), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1', name: 'echo', arguments: { value: 'hi' } })
    }));
    const callPayload = await call.json() as { sessionId: string; result: { toolName: string; ok: boolean }; transcriptLength: number; status: string };
    expect(callPayload.sessionId).toBe('bridge-live-1');
    expect(callPayload.result).toMatchObject({ toolName: 'echo', ok: true });
    expect(callPayload.transcriptLength).toBe(1);
    expect(callPayload.status).toBe('open');

    const transcript = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeTranscript)}?sessionId=bridge-live-1`));
    const transcriptPayload = await transcript.json() as { maxToolCalls: number; transcript: Array<{ toolName: string; transport?: string; executionMode?: string }>; lastHeartbeatAt: string };
    expect(transcriptPayload.maxToolCalls).toBe(1);
    expect(transcriptPayload.transcript).toHaveLength(1);
    expect(transcriptPayload.transcript[0]).toMatchObject({
      toolName: 'echo',
      transport: 'runtime',
      executionMode: 'runtime'
    });
    expect(transcriptPayload.lastHeartbeatAt).toEqual(expect.any(String));

    const status = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeStatus)}?sessionId=bridge-live-1`));
    expect(await status.json()).toMatchObject({
      sessionId: 'bridge-live-1',
      exists: true,
      status: 'open',
      runtimeMode: 'simulated-bridge',
      processId: expect.any(String),
      openedAt: expect.any(String),
      lastActivityAt: expect.any(String),
      lastHeartbeatAt: expect.any(String),
      maxToolCalls: 1,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      directToolCount: 0,
      directBrowserTools: [],
      directMcpTools: [],
      directRuntimeTools: [],
      transcriptSummary: {
        total: 1,
        byTransport: { runtime: 1, socket: 0 },
        byExecutionMode: { runtime: 1, directSocket: 0, fallbackRuntime: 0 },
        aliasAppliedEntries: 0,
        nestedAliasAppliedEntries: 0,
        aliasUsageCounts: {},
        nestedRequestedAliasCounts: {},
        toolUsageCounts: { echo: 1 },
        nestedDirectToolCounts: {}
      },
      idle: false,
      idleTimeoutMs: 10000,
      leaseExpiresAt: expect.any(String),
      leaseExpired: false,
      reopenCount: 0,
      activeCallCount: 0,
      lastToolName: 'echo',
      transcriptLength: 1
    });

    const process = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeProcess)}?sessionId=bridge-live-1`));
    expect(await process.json()).toMatchObject({
      sessionId: 'bridge-live-1',
      exists: true,
      runtimeMode: 'simulated-bridge',
      processId: expect.any(String),
      status: 'open',
      startedAt: expect.any(String),
      lastToolName: 'echo',
      activeCallCount: 0,
      transcriptLength: 1,
      leaseExpired: false
    });

    const heartbeat = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeHeartbeat), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1' })
    }));
    expect(await heartbeat.json()).toMatchObject({
      ok: true,
      sessionId: 'bridge-live-1',
      status: 'open',
      runtimeMode: 'simulated-bridge',
      processId: expect.any(String),
      lastHeartbeatAt: expect.any(String),
      lastActivityAt: expect.any(String),
      idle: false,
      idleTimeoutMs: 10000,
      leaseExpiresAt: expect.any(String),
      leaseExpired: false
    });

    const blocked = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeCall), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1', name: 'time' })
    }));
    expect(blocked.status).toBe(429);

    const closed = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeClose), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1' })
    }));
    expect(await closed.json()).toMatchObject({
      ok: true,
      sessionId: 'bridge-live-1',
      closed: true,
      status: 'closed',
      reopenCount: 0,
      transcriptLength: 1
    });

    const afterCloseCall = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeCall), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1', name: 'time' })
    }));
    expect(afterCloseCall.status).toBe(409);

    await runtime.fetch(new Request(localRoute(routePaths.code.bridge), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-live-1', maxToolCalls: 2 })
    }));

    const reopenedStatus = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeStatus)}?sessionId=bridge-live-1`));
    expect(await reopenedStatus.json()).toMatchObject({
      sessionId: 'bridge-live-1',
      exists: true,
      status: 'open',
      maxToolCalls: 2,
      reopenCount: 1,
      transcriptLength: 0
    });
  });

  it('spawns and terminates a process-like bridge runtime in the node runtime', async () => {
    const runtime = createNodeRuntime();

    const spawned = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeSpawn), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', maxToolCalls: 2, idleTimeoutMs: 5000 })
    }));
    const spawnedPayload = await spawned.json() as {
      ok: boolean;
      sessionId: string;
      artifacts: { socketPath: string; protocolVersion: string };
      process: { pid?: number; mode: string; socketPath: string; socketReady: boolean; directToolAliases?: Record<string, string>; supportedRequestedAliases?: string[]; supportedAliasTargets?: string[]; supportedDirectTools?: string[]; alive: boolean; startedAt: string };
    };
    expect(spawnedPayload.ok).toBe(true);
    expect(spawnedPayload.sessionId).toBe('bridge-process-1');
    expect(spawnedPayload.artifacts.protocolVersion).toBe('crowclaw-tool-bridge/v1');
    expect(spawnedPayload.artifacts.socketPath).toContain('bridge-process-1');
    expect(spawnedPayload.process.mode).toBeDefined();
    expect((spawnedPayload.process as unknown as { protocolVersion?: string }).protocolVersion).toBe('crowclaw-tool-bridge/v1');
    expect(spawnedPayload.process.socketPath).toContain('bridge-process-1');
    expect(spawnedPayload.process.directToolAliases).toEqual({
      'browser.wait': 'browser.waitFor',
      'browser.wait-for': 'browser.waitFor',
      'browser.click-ref': 'browser.clickRef'
    });
    expect(spawnedPayload.process.supportedRequestedAliases ?? []).toEqual(expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']));
    expect(spawnedPayload.process.supportedAliasTargets ?? []).toEqual(expect.arrayContaining(['browser.waitFor', 'browser.clickRef']));
    expect(spawnedPayload.process.supportedDirectTools ?? []).toContain('mcp.inspect');

    const processSummary = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeProcess)}?sessionId=bridge-process-1`));
    expect(await processSummary.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      exists: true,
      process: {
        protocolVersion: 'crowclaw-tool-bridge/v1',
        mode: expect.any(String),
        socketPath: expect.any(String),
        socketReady: expect.any(Boolean),
        supportedDirectTools: expect.any(Array),
        startedAt: expect.any(String)
      },
      supportsNestedCallToolDirect: true,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
      supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
      directToolCount: expect.any(Number),
      directBrowserTools: expect.arrayContaining(['browser.open', 'browser.screenshot']),
      directMcpTools: expect.arrayContaining(['mcp.status', 'mcp.inspect']),
      transcriptSummary: {
        total: 0,
        byTransport: { runtime: 0, socket: 0 },
        byExecutionMode: { runtime: 0, directSocket: 0, fallbackRuntime: 0 }
      }
    });

    const capabilities = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCapabilities)}?sessionId=bridge-process-1`));
    expect(await capabilities.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      exists: true,
      protocolVersion: 'crowclaw-tool-bridge/v1',
      supportsNestedCallToolDirect: true,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
      supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
      supportedDirectTools: expect.arrayContaining(['echo', 'mcp.inspect', 'browser.session', 'browser.open', 'browser.goto', 'browser.navigate', 'browser.snapshot', 'browser.console', 'browser.images', 'browser.vision', 'browser.back', 'browser.scroll', 'browser.press', 'browser.clickRef', 'browser.waitFor', 'browser.extract', 'browser.click', 'browser.type', 'browser.screenshot'])
    });

    const ping = await runtime.fetch(new Request(localRoute(routePaths.code.bridgePing), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1' })
    }));
    expect(await ping.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      process: {
        socketPath: expect.any(String),
        directToolAliases: {
          'browser.wait': 'browser.waitFor',
          'browser.wait-for': 'browser.waitFor',
          'browser.click-ref': 'browser.clickRef'
        },
        supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
        supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef'])
      }
    });

    const socketCall = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'echo', arguments: { hello: 'world' } } })
    }));
    expect(await socketCall.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      contract: {
        mode: 'socket-roundtrip',
        requestedToolName: 'echo',
        aliasApplied: false,
        echoedPayload: expect.any(Boolean),
        toolExecutionAttempted: true,
        fallbackToDirectToolExecution: expect.any(Boolean),
        directSocketToolExecution: expect.any(Boolean),
        toolExecutionMode: expect.stringMatching(/direct-socket|fallback-runtime/)
      },
      transcriptLength: expect.any(Number),
      toolResult: {
        toolName: 'echo',
        ok: true
      },
      process: {
        socketPath: expect.any(String),
        directToolAliases: {
          'browser.wait': 'browser.waitFor',
          'browser.wait-for': 'browser.waitFor',
          'browser.click-ref': 'browser.clickRef'
        },
        supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
        supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef'])
      }
    });

    const socketTranscript = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeTranscript)}?sessionId=bridge-process-1`));
    const socketTranscriptPayload = await socketTranscript.json() as {
      transcriptSummary: { total: number; byTransport: { runtime: number; socket: number }; byExecutionMode: { runtime: number; directSocket: number; fallbackRuntime: number }; aliasAppliedEntries: number; nestedAliasAppliedEntries: number; aliasUsageCounts: Record<string, number>; directRequestedAliasCounts: Record<string, number>; nestedRequestedAliasCounts: Record<string, number>; toolUsageCounts: Record<string, number>; nestedDirectToolCounts: Record<string, number>; lastEntry: { toolName: string; transport?: string } | null };
      transcript: Array<{ toolName: string; transport?: string; executionMode?: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean }>;
    };
    expect(socketTranscriptPayload.transcriptSummary.total).toBeGreaterThanOrEqual(1);
    expect(socketTranscriptPayload.transcriptSummary.byTransport.socket).toBeGreaterThanOrEqual(1);
    expect(socketTranscriptPayload.transcriptSummary.aliasAppliedEntries).toBeGreaterThanOrEqual(0);
    expect(socketTranscriptPayload.transcriptSummary.aliasUsageCounts).toBeDefined();
    expect(socketTranscriptPayload.transcriptSummary.directRequestedAliasCounts).toBeDefined();
    expect(socketTranscriptPayload.transcriptSummary.nestedRequestedAliasCounts).toBeDefined();
    expect(socketTranscriptPayload.transcriptSummary.toolUsageCounts.echo).toBeGreaterThanOrEqual(1);
    expect(socketTranscriptPayload.transcript[0]).toMatchObject({
      toolName: 'echo',
      transport: 'socket'
    });

    const socketMcpStatus = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'mcp.status', arguments: {} } })
    }));
    expect(await socketMcpStatus.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'mcp.status',
        ok: true
      }
    });

    const socketDirectAlias = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.wait-for', arguments: { selector: '#app', timeoutMs: 250 } } })
    }));
    const socketDirectAliasPayload = await socketDirectAlias.json() as {
      contract: { requestedToolName?: string | null; canonicalToolName?: string | null; aliasApplied?: boolean; toolExecutionMode: string };
      toolResult: { toolName: string };
    };
    expect(socketDirectAliasPayload.toolResult.toolName).toBe('browser.waitFor');
    expect(socketDirectAliasPayload.contract.requestedToolName).toBe('browser.wait-for');
    expect(socketDirectAliasPayload.contract.canonicalToolName).toBe('browser.waitFor');
    expect(socketDirectAliasPayload.contract.aliasApplied).toBe(true);

    const socketMcpTools = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'mcp.listTools', arguments: {} } })
    }));
    const socketMcpToolsPayload = await socketMcpTools.json() as {
      sessionId: string;
      transport: string;
      contract: { toolExecutionMode: string };
      toolResult: { toolName: string; ok: boolean; output: string };
    };
    expect(socketMcpToolsPayload).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'mcp.listTools',
        ok: true
      }
    });
    expect(socketMcpToolsPayload.contract.toolExecutionMode).toMatch(/direct-socket|fallback-runtime/);
    expect(socketMcpToolsPayload.toolResult.output).toMatch(/mcp\.callTool|mcp-docs\.search/);

    const socketMcpInspect = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'mcp.inspect', arguments: {} } })
    }));
    const socketMcpInspectPayload = await socketMcpInspect.json() as {
      sessionId: string;
      transport: string;
      contract: { toolExecutionMode: string };
      toolResult: { toolName: string; ok: boolean; output: string };
    };
    expect(socketMcpInspectPayload).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'mcp.inspect',
        ok: true
      }
    });
    expect(socketMcpInspectPayload.contract.toolExecutionMode).toMatch(/direct-socket|fallback-runtime/);
    expect(socketMcpInspectPayload.toolResult.output).toMatch(/browser\.session|status/);

    const socketMcpResources = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'mcp.listResources', arguments: {} } })
    }));
    expect(await socketMcpResources.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'mcp.listResources',
        ok: true
      }
    });

    const socketMcpCall = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'mcp.status',
            arguments: {}
          }
        }
      })
    }));
    const socketMcpCallPayload = await socketMcpCall.json() as {
      sessionId: string;
      transport: string;
      contract: { toolExecutionMode: string };
      toolResult: { toolName: string; ok?: boolean; output?: string; content?: unknown; metadata?: Record<string, unknown> };
    };
    expect(socketMcpCallPayload).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      contract: {
        nestedDirectToolName: 'mcp.status'
      },
      toolResult: {
        toolName: 'mcp.callTool'
      }
    });
    expect(socketMcpCallPayload.contract.toolExecutionMode).toMatch(/direct-socket|fallback-runtime/);
    if (socketMcpCallPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketMcpCallPayload.contract.nestedDirectToolExecution).toBe(true);
      const parsedSocketMcpCallOutput = JSON.parse(socketMcpCallPayload.toolResult.output ?? '{}');
      expect(parsedSocketMcpCallOutput).toMatchObject({
        name: 'mcp.status',
        arguments: {},
        direct: true,
        result: {
          toolName: 'mcp.status',
          ok: true
        }
      });
    } else {
      expect(socketMcpCallPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketMcpCallPayload.toolResult.metadata).toMatchObject({
        name: 'mcp.status'
      });
    }

    const socketBrowserSession = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.session', arguments: {} } })
    }));
    expect(await socketBrowserSession.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.session'
      }
    });

    const socketBrowserOpen = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.open', arguments: { url: 'https://example.com/direct' } } })
    }));
    expect(await socketBrowserOpen.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      contract: {
        toolExecutionMode: expect.stringMatching(/direct-socket|fallback-runtime/)
      },
      toolResult: {
        toolName: 'browser.open'
      }
    });

    const socketBrowserGoto = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.goto', arguments: { url: 'https://example.com/direct/goto' } } })
    }));
    expect(await socketBrowserGoto.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.goto'
      }
    });

    const socketBrowserNavigate = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.navigate', arguments: { url: 'https://example.com/direct/next' } } })
    }));
    expect(await socketBrowserNavigate.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.navigate'
      }
    });

    const socketBrowserConsole = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.console', arguments: { url: 'https://example.com/direct' } } })
    }));
    const socketBrowserConsolePayload = await socketBrowserConsole.json() as {
      sessionId: string;
      transport: string;
      contract: { toolExecutionMode: string };
      toolResult: { toolName: string; ok?: boolean };
    };
    expect(socketBrowserConsolePayload).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.console'
      }
    });
    expect(socketBrowserConsolePayload.contract.toolExecutionMode).toMatch(/direct-socket|fallback-runtime/);

    const socketBrowserVision = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.vision', arguments: { url: 'https://example.com/direct', prompt: 'summarize page' } } })
    }));
    expect(await socketBrowserVision.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.vision'
      }
    });

    const socketBrowserPress = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.press', arguments: { key: 'Enter' } } })
    }));
    expect(await socketBrowserPress.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.press'
      }
    });

    const socketBrowserType = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1', payload: { name: 'browser.type', arguments: { selector: '#q', text: 'CrowClaw' } } })
    }));
    expect(await socketBrowserType.json()).toMatchObject({
      sessionId: 'bridge-process-1',
      transport: 'socket',
      toolResult: {
        toolName: 'browser.type'
      }
    });

    const socketBrowserSnapshot = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.snapshot',
            arguments: { url: 'https://example.com/direct' }
          }
        }
      })
    }));
    const socketBrowserSnapshotPayload = await socketBrowserSnapshot.json() as {
      contract: { toolExecutionMode: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserSnapshotPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserSnapshotPayload.contract.nestedDirectToolName).toBe('browser.snapshot');
    if (socketBrowserSnapshotPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserSnapshotPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserSnapshotPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.snapshot',
        direct: true
      });
    } else {
      expect(socketBrowserSnapshotPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserSnapshotPayload.toolResult.metadata).toMatchObject({
        name: 'browser.snapshot'
      });
    }

    const socketBrowserImages = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.images',
            arguments: { url: 'https://example.com/direct', limit: 2 }
          }
        }
      })
    }));
    const socketBrowserImagesPayload = await socketBrowserImages.json() as {
      contract: { toolExecutionMode: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserImagesPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserImagesPayload.contract.nestedDirectToolName).toBe('browser.images');
    if (socketBrowserImagesPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserImagesPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserImagesPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.images',
        direct: true
      });
    } else {
      expect(socketBrowserImagesPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserImagesPayload.toolResult.metadata).toMatchObject({
        name: 'browser.images'
      });
    }

    const socketBrowserBack = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.back',
            arguments: { steps: 2 }
          }
        }
      })
    }));
    const socketBrowserBackPayload = await socketBrowserBack.json() as {
      contract: { toolExecutionMode: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserBackPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserBackPayload.contract.nestedDirectToolName).toBe('browser.back');
    if (socketBrowserBackPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserBackPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserBackPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.back',
        direct: true
      });
    } else {
      expect(socketBrowserBackPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserBackPayload.toolResult.metadata).toMatchObject({
        name: 'browser.back'
      });
    }

    const socketBrowserClickRef = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.click-ref',
            arguments: { ref: '@e1', url: 'https://example.com/direct' }
          }
        }
      })
    }));
    const socketBrowserClickRefPayload = await socketBrowserClickRef.json() as {
      contract: { toolExecutionMode: string; nestedRequestedToolName?: string | null; nestedDirectToolName?: string | null; nestedCanonicalToolName?: string | null; nestedAliasApplied?: boolean; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserClickRefPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserClickRefPayload.contract.nestedRequestedToolName).toBe('browser.click-ref');
    expect(socketBrowserClickRefPayload.contract.nestedDirectToolName).toBe('browser.clickRef');
    expect(socketBrowserClickRefPayload.contract.nestedCanonicalToolName).toBe('browser.clickRef');
    expect(socketBrowserClickRefPayload.contract.nestedAliasApplied).toBe(true);
    if (socketBrowserClickRefPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserClickRefPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserClickRefPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.clickRef',
        direct: true
      });
    } else {
      expect(socketBrowserClickRefPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserClickRefPayload.toolResult.metadata).toMatchObject({
        name: 'browser.clickRef'
      });
    }

    const socketBrowserWaitFor = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.wait',
            arguments: { selector: '#app', timeoutMs: 500 }
          }
        }
      })
    }));
    const socketBrowserWaitForPayload = await socketBrowserWaitFor.json() as {
      contract: { toolExecutionMode: string; nestedRequestedToolName?: string | null; nestedDirectToolName?: string | null; nestedCanonicalToolName?: string | null; nestedAliasApplied?: boolean; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserWaitForPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserWaitForPayload.contract.nestedRequestedToolName).toBe('browser.wait');
    expect(socketBrowserWaitForPayload.contract.nestedDirectToolName).toBe('browser.waitFor');
    expect(socketBrowserWaitForPayload.contract.nestedCanonicalToolName).toBe('browser.waitFor');
    expect(socketBrowserWaitForPayload.contract.nestedAliasApplied).toBe(true);
    if (socketBrowserWaitForPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserWaitForPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserWaitForPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.waitFor',
        direct: true
      });
    } else {
      expect(socketBrowserWaitForPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserWaitForPayload.toolResult.metadata).toMatchObject({
        name: 'browser.waitFor'
      });
    }

    const socketBrowserScreenshot = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeCall)}?transport=socket`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'bridge-process-1',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.screenshot',
            arguments: { path: '/tmp/direct.png', url: 'https://example.com/direct' }
          }
        }
      })
    }));
    const socketBrowserScreenshotPayload = await socketBrowserScreenshot.json() as {
      contract: { toolExecutionMode: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean };
      toolResult: { toolName: string; output?: string; metadata?: Record<string, unknown> };
    };
    expect(socketBrowserScreenshotPayload.toolResult.toolName).toBe('mcp.callTool');
    expect(socketBrowserScreenshotPayload.contract.nestedDirectToolName).toBe('browser.screenshot');
    if (socketBrowserScreenshotPayload.contract.toolExecutionMode === 'direct-socket') {
      expect(socketBrowserScreenshotPayload.contract.nestedDirectToolExecution).toBe(true);
      expect(JSON.parse(socketBrowserScreenshotPayload.toolResult.output ?? '{}')).toMatchObject({
        name: 'browser.screenshot',
        direct: true
      });
    } else {
      expect(socketBrowserScreenshotPayload.contract.nestedDirectToolExecution).toBe(false);
      expect(socketBrowserScreenshotPayload.toolResult.metadata).toMatchObject({
        name: 'browser.screenshot'
      });
    }

    const nestedTranscript = await runtime.fetch(new Request(`${localRoute(routePaths.code.bridgeTranscript)}?sessionId=bridge-process-1`));
    const nestedTranscriptPayload = await nestedTranscript.json() as {
      transcriptSummary: { byExecutionMode: { runtime: number; directSocket: number; fallbackRuntime: number }; nestedAliasAppliedEntries: number; aliasUsageCounts: Record<string, number>; directRequestedAliasCounts: Record<string, number>; nestedRequestedAliasCounts: Record<string, number>; nestedDirectToolCounts: Record<string, number> };
      transcript: Array<{ toolName: string; transport?: string; executionMode?: string; nestedDirectToolName?: string | null; nestedDirectToolExecution?: boolean }>;
    };
    expect(
      nestedTranscriptPayload.transcriptSummary.byExecutionMode.directSocket
      + nestedTranscriptPayload.transcriptSummary.byExecutionMode.fallbackRuntime
    ).toBeGreaterThanOrEqual(1);
    expect(nestedTranscriptPayload.transcriptSummary.nestedAliasAppliedEntries).toBeGreaterThanOrEqual(1);
    expect(nestedTranscriptPayload.transcriptSummary.aliasUsageCounts['browser.waitFor'] ?? 0).toBeGreaterThanOrEqual(0);
    expect(nestedTranscriptPayload.transcriptSummary.directRequestedAliasCounts['browser.wait-for'] ?? 0).toBeGreaterThanOrEqual(0);
    expect(nestedTranscriptPayload.transcriptSummary.nestedRequestedAliasCounts['browser.wait'] ?? 0).toBeGreaterThanOrEqual(1);
    expect(nestedTranscriptPayload.transcriptSummary.nestedDirectToolCounts['browser.screenshot']).toBeGreaterThanOrEqual(1);
    expect(nestedTranscriptPayload.transcript.some((entry) => (
      entry.toolName === 'mcp.callTool'
      && entry.transport === 'socket'
      && entry.nestedDirectToolName === 'browser.screenshot'
    ))).toBe(true);

    const terminated = await runtime.fetch(new Request(localRoute(routePaths.code.bridgeTerminate), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'bridge-process-1' })
    }));
    expect(await terminated.json()).toMatchObject({
      ok: true,
      sessionId: 'bridge-process-1',
      terminated: true,
      process: {
        alive: false
      }
    });
  });

  it('forwards top-level Cloudflare node.exec and python.exec requests', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const nodeResponse = await runtimeCloudflare.fetch(new Request('https://example.com/api/node/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'console.log("hi")', cwd: '/workspace/node-app', timeoutMs: 1800, toolBridge: true, maxToolCalls: 2 })
    }), env as never);
    const nodePayload = await nodeResponse.json() as { forwardedTo: string; body: { code: string; cwd: string; timeoutMs: number; toolBridge: boolean; maxToolCalls: number } };

    const pythonResponse = await runtimeCloudflare.fetch(new Request('https://example.com/api/python/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'print(\"hi\")', cwd: '/workspace/python-app', timeoutMs: 900 })
    }), env as never);
    const pythonPayload = await pythonResponse.json() as { forwardedTo: string; body: { code: string; cwd: string; timeoutMs: number } };

    expect(nodePayload.forwardedTo).toContain('/node/exec');
    expect(nodePayload.body).toEqual({ code: 'console.log("hi")', cwd: '/workspace/node-app', timeoutMs: 1800, toolBridge: true, maxToolCalls: 2 });

    expect(pythonPayload.forwardedTo).toContain('/python/exec');
    expect(pythonPayload.body).toEqual({ code: 'print("hi")', cwd: '/workspace/python-app', timeoutMs: 900 });
  });

  it('executes code directly inside the Cloudflare durable object route', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-code-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/code/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ language: 'javascript', code: 'console.log("hi")', cwd: '/workspace/app', timeoutMs: 1200, toolBridge: true, maxToolCalls: 2 })
    }));

    const payload = await response.json() as { ok: boolean; output: string; metadata: { language: string; exitCode: number; timeoutMs: number; stdout: string; stderr: string; toolBridgeRequested: boolean; maxToolCalls: number; toolBridgeMode: string; bridgeArtifacts?: { modulePath: string } } };
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('sandbox:node -e');
    expect(payload.metadata).toMatchObject({ language: 'javascript', exitCode: 0, timeoutMs: 1200, toolBridgeRequested: true, maxToolCalls: 2 });
    expect(payload.metadata.stdout).toContain('sandbox:node -e');
    expect(payload.metadata.stderr).toBe('');
    expect(payload.metadata.toolBridgeMode).toBe('session-artifacts');
    expect(payload.metadata.bridgeArtifacts?.modulePath).toContain('crow_tools_');
  });

  it('executes node.exec and python.exec directly inside the Cloudflare durable object route', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-code-2' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const nodeResponse = await obj.fetch(new Request('https://internal/session/node/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'console.log("hi")', cwd: '/workspace/node-app', timeoutMs: 1800, toolBridge: true, maxToolCalls: 2 })
    }));
    const nodePayload = await nodeResponse.json() as { toolName: string; ok: boolean; output: string; metadata: { language: string; exitCode: number; timeoutMs: number; toolBridgeRequested: boolean; maxToolCalls: number; bridgeArtifacts?: { transcriptPath: string } } };

    const pythonResponse = await obj.fetch(new Request('https://internal/session/python/exec', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'print("hi")', cwd: '/workspace/python-app', timeoutMs: 900 })
    }));
    const pythonPayload = await pythonResponse.json() as { toolName: string; ok: boolean; output: string; metadata: { language: string; exitCode: number } };

    expect(nodePayload.ok).toBe(true);
    expect(nodePayload.toolName).toBe('node.exec');
    expect(nodePayload.output).toContain('sandbox:node -e');
    expect(nodePayload.metadata).toMatchObject({ language: 'javascript', exitCode: 0, timeoutMs: 1800, toolBridgeRequested: true, maxToolCalls: 2 });
    expect(nodePayload.metadata.bridgeArtifacts?.transcriptPath).toContain('transcript_');

    expect(pythonPayload.ok).toBe(true);
    expect(pythonPayload.toolName).toBe('python.exec');
    expect(pythonPayload.output).toContain('sandbox:python -c');
    expect(pythonPayload.metadata).toMatchObject({ language: 'python', exitCode: 0, timeoutMs: 900 });
  });

  it('returns explicit tool-bridge artifacts inside the Cloudflare durable object route', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-bridge-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/code/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxToolCalls: 5 })
    }));
    const payload = await response.json() as { sessionId: string; protocolVersion: string; modulePath: string; bootstrapPython: string };
    expect(payload.sessionId).toBe('cf-bridge-1');
    expect(payload.protocolVersion).toBe('crowclaw-tool-bridge/v1');
    expect(payload.modulePath).toContain('crow_tools_cf-bridge-1');
    expect(payload.bootstrapPython).toContain('maxToolCalls');
  });

  it('supports live bridge tool calls and transcript inspection inside the Cloudflare durable object route', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-bridge-live-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    await obj.fetch(new Request('https://internal/session/code/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1', maxToolCalls: 1 })
    }));

    const call = await obj.fetch(new Request('https://internal/session/code/bridge/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1', name: 'echo', arguments: { value: 'hi' } })
    }));
    const callPayload = await call.json() as { transcriptLength: number; result: { toolName: string; ok: boolean }; status: string };
    expect(callPayload.transcriptLength).toBe(1);
    expect(callPayload.result).toMatchObject({ toolName: 'echo', ok: true });
    expect(callPayload.status).toBe('open');

    const transcript = await obj.fetch(new Request('https://internal/session/code/bridge/transcript?sessionId=cf-bridge-live-1'));
    const transcriptPayload = await transcript.json() as { transcript: Array<{ toolName: string }>; maxToolCalls: number };
    expect(transcriptPayload.maxToolCalls).toBe(1);
    expect(transcriptPayload.transcript[0]?.toolName).toBe('echo');

    const status = await obj.fetch(new Request('https://internal/session/code/bridge/status?sessionId=cf-bridge-live-1'));
    expect(await status.json()).toMatchObject({
      sessionId: 'cf-bridge-live-1',
      exists: true,
      status: 'open',
      openedAt: expect.any(String),
      lastActivityAt: expect.any(String),
      reopenCount: 0,
      maxToolCalls: 1,
      transcriptLength: 1
    });

    const blocked = await obj.fetch(new Request('https://internal/session/code/bridge/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1', name: 'time' })
    }));
    expect(blocked.status).toBe(429);

    const closed = await obj.fetch(new Request('https://internal/session/code/bridge/close', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1' })
    }));
    expect(await closed.json()).toMatchObject({
      ok: true,
      sessionId: 'cf-bridge-live-1',
      closed: true,
      status: 'closed',
      reopenCount: 0,
      transcriptLength: 1
    });

    const afterCloseCall = await obj.fetch(new Request('https://internal/session/code/bridge/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1', name: 'time' })
    }));
    expect(afterCloseCall.status).toBe(409);

    await obj.fetch(new Request('https://internal/session/code/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-bridge-live-1', maxToolCalls: 2 })
    }));

    const reopenedStatus = await obj.fetch(new Request('https://internal/session/code/bridge/status?sessionId=cf-bridge-live-1'));
    expect(await reopenedStatus.json()).toMatchObject({
      sessionId: 'cf-bridge-live-1',
      exists: true,
      status: 'open',
      maxToolCalls: 2,
      reopenCount: 1,
      transcriptLength: 0
    });
  });
});

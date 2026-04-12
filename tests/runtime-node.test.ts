import { describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

describe('runtime-node', () => {
  it('serves health, message, history/state, remember, and search routes', async () => {
    const runtime = createNodeRuntime();

    const health = await runtime.fetch(new Request('http://localhost/health'));
    expect(await health.json()).toMatchObject({ ok: true, runtime: 'node' });

    const post = await runtime.fetch(new Request('http://localhost/api/sessions/demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'hello from node runtime' })
    }));
    const payload = await post.json() as { finalResponse: string };
    expect(payload.finalResponse).toContain('CrowClaw received');

    const remember = await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Remember node runtime note', tags: ['node'] })
    }));
    expect(await remember.json()).toMatchObject({ sessionId: 'demo', summary: 'Remember node runtime note' });

    const search = await runtime.fetch(new Request('http://localhost/api/sessions/demo/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'node', source: 'memory' })
    }));
    const searchPayload = await search.json() as { results: Array<{ summary: string }> };
    expect(searchPayload.results.some((record) => record.summary.includes('Remember node runtime note'))).toBe(true);

    const get = await runtime.fetch(new Request('http://localhost/api/sessions/demo/history'));
    const session = await get.json() as { sessionId: string; messages: Array<{ role: string }> };
    expect(session.sessionId).toBe('demo');
    expect(session.messages.length).toBeGreaterThan(0);

    const state = await runtime.fetch(new Request('http://localhost/api/sessions/demo/state'));
    const statePayload = await state.json() as { sessionId: string; messages: Array<{ role: string }> };
    expect(statePayload.sessionId).toBe('demo');
    expect(statePayload.messages.length).toBeGreaterThan(0);
  });

  it('creates and lists sessions from the top-level sessions API', async () => {
    const runtime = createNodeRuntime();

    const created = await runtime.fetch(new Request('http://localhost/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'dashboard-demo' })
    }));
    const createdPayload = await created.json() as { ok: boolean; session: { sessionId: string; messageCount: number } };
    expect(createdPayload.ok).toBe(true);
    expect(createdPayload.session.sessionId).toBe('dashboard-demo');
    expect(createdPayload.session.messageCount).toBe(0);

    await runtime.fetch(new Request('http://localhost/api/sessions/dashboard-demo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'hello dashboard' })
    }));

    const listed = await runtime.fetch(new Request('http://localhost/api/sessions?limit=10'));
    const listedPayload = await listed.json() as {
      ok: boolean;
      supported: boolean;
      count: number;
      sessions: Array<{ sessionId: string; messageCount: number; preview: string }>;
    };
    expect(listedPayload.ok).toBe(true);
    expect(listedPayload.supported).toBe(true);
    expect(listedPayload.sessions.some((session) => session.sessionId === 'dashboard-demo')).toBe(true);
    expect(listedPayload.sessions.find((session) => session.sessionId === 'dashboard-demo')?.messageCount).toBeGreaterThan(0);
  });

  it('serves a system status/doctor route for operational inspection', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/status'));
    const payload = await response.json() as {
      ok: boolean;
      deployment: string;
      runtime: string;
      service: string;
      plugins: string[];
      counts: { bridgeSessions: number; bridgeProcesses: number; bridgeAliveProcesses: number; browserSessions: number; schedulerJobs: number };
      bridgeSummary: { totalSessions: number; openSessions: number; busySessions: number; closedSessions: number; directToolCount: number; directBrowserToolCount: number; directMcpToolCount: number; directRuntimeToolCount: number; totalTranscriptEntries: number; runtimeTranscriptEntries: number; socketTranscriptEntries: number; directSocketEntries: number; fallbackRuntimeEntries: number; aliasAppliedEntries: number; nestedAliasAppliedEntries: number; averageTranscriptEntriesPerSession: number; sessionsWithRuntimeTraffic: number; sessionsWithSocketTraffic: number; sessionsWithDirectSocketTraffic: number; sessionsWithFallbackRuntimeTraffic: number; sessionsWithAliasTraffic: number; sessionsWithNestedAliasTraffic: number; directToolAliases: Record<string, string>; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; aliasUsageCounts: Record<string, number>; directRequestedAliasCounts: Record<string, number>; nestedRequestedAliasCounts: Record<string, number>; toolUsageCounts: Record<string, number>; nestedDirectToolCounts: Record<string, number> };
      bridgeSessions: Array<{ sessionId: string; directToolCount: number; transcriptSummary: { total: number } }>;
      bridgeProcesses: Array<{ sessionId: string; protocolVersion: string; mode: string; socketPath: string; socketReady: boolean; directToolAliases: Record<string, string>; supportedRequestedAliasCount: number; supportedAliasTargetCount: number; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; supportedDirectTools: string[]; alive: boolean; directToolCount: number; directBrowserTools: string[]; directMcpTools: string[]; directRuntimeTools: string[]; transcriptSummary: { total: number } }>;
      bridgeCapabilities: { supportsNestedCallToolDirect: boolean; directToolAliases: Record<string, string>; supportedRequestedAliasCount: number; supportedAliasTargetCount: number; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; directToolCount: number; nestedDirectTools: string[]; directBrowserTools: string[]; directMcpTools: string[]; directRuntimeTools: string[] };
      gateway: { slackSigningSecretConfigured: boolean };
      tools: Array<{ name: string; description: string; runtime: string; dangerLevel: string }>;
      release: { candidate: boolean; verification: { note: string } };
    };

    expect(payload.ok).toBe(true);
    expect(payload.deployment).toBe('crowclaw-local');
    expect(payload.runtime).toBe('node');
    expect(payload.service).toBe('crowclaw');
    expect(payload.plugins.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.counts).toMatchObject({ bridgeSessions: 0, bridgeProcesses: 0, bridgeAliveProcesses: 0, browserSessions: 0, schedulerJobs: 0 });
    expect(payload.bridgeSummary).toEqual({
      totalSessions: 0,
      openSessions: 0,
      busySessions: 0,
      closedSessions: 0,
      directToolCount: 0,
      directBrowserToolCount: 0,
      directMcpToolCount: 0,
      directRuntimeToolCount: 0,
      totalTranscriptEntries: 0,
      runtimeTranscriptEntries: 0,
      socketTranscriptEntries: 0,
      directSocketEntries: 0,
      fallbackRuntimeEntries: 0,
      aliasAppliedEntries: 0,
      nestedAliasAppliedEntries: 0,
      averageTranscriptEntriesPerSession: 0,
      sessionsWithRuntimeTraffic: 0,
      sessionsWithSocketTraffic: 0,
      sessionsWithDirectSocketTraffic: 0,
      sessionsWithFallbackRuntimeTraffic: 0,
      sessionsWithAliasTraffic: 0,
      sessionsWithNestedAliasTraffic: 0,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliasCount: 0,
      supportedAliasTargetCount: 0,
      supportedRequestedAliases: [],
      supportedAliasTargets: [],
      aliasUsageCounts: {},
      directRequestedAliasCounts: {},
      nestedRequestedAliasCounts: {},
      toolUsageCounts: {},
      nestedDirectToolCounts: {}
    });
    expect(payload.bridgeSessions).toEqual([]);
    expect(payload.bridgeProcesses).toEqual([]);
    expect(payload.bridgeCapabilities).toEqual({
      supportsNestedCallToolDirect: true,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliasCount: 0,
      supportedAliasTargetCount: 0,
      supportedRequestedAliases: [],
      supportedAliasTargets: [],
      directToolCount: 0,
      nestedDirectTools: [],
      directBrowserTools: [],
      directMcpTools: [],
      directRuntimeTools: []
    });
    expect(payload.gateway).toMatchObject({ slackSigningSecretConfigured: false });
    expect(payload.release).toEqual({
      candidate: true,
      verification: {
        note: expect.any(String)
      }
    });
  });

  it('includes a tools array in the system status response', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/status'));
    const payload = await response.json() as { tools: Array<{ name: string; description: string; runtime: string; dangerLevel: string }> };
    expect(Array.isArray(payload.tools)).toBe(true);
    expect(payload.tools.length).toBeGreaterThan(0);
    // every entry should be a tool manifest object with expected fields
    for (const tool of payload.tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.description).toBe('string');
      expect(typeof tool.runtime).toBe('string');
      expect(typeof tool.dangerLevel).toBe('string');
    }
  });

  it('serves a system version route', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local', version: '0.1.0' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/version'));
    expect(await response.json()).toEqual({
      service: 'crowclaw',
      runtime: 'node',
      deployment: 'crowclaw-local',
      version: '0.1.0'
    });
  });

  it('serves a release-check route for operator/release readiness', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local', version: '0.1.0' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/release-check'));
    const payload = await response.json() as {
      doctor: { deployment: string; runtime: string; release: { candidate: boolean } };
      bridgeSummary: { totalSessions: number; directToolCount: number; directBrowserToolCount: number; directMcpToolCount: number; directRuntimeToolCount: number; runtimeTranscriptEntries: number; socketTranscriptEntries: number; aliasAppliedEntries: number; nestedAliasAppliedEntries: number; averageTranscriptEntriesPerSession: number; sessionsWithRuntimeTraffic: number; sessionsWithSocketTraffic: number; sessionsWithDirectSocketTraffic: number; sessionsWithFallbackRuntimeTraffic: number; sessionsWithAliasTraffic: number; sessionsWithNestedAliasTraffic: number; directToolAliases: Record<string, string>; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; aliasUsageCounts: Record<string, number>; directRequestedAliasCounts: Record<string, number>; nestedRequestedAliasCounts: Record<string, number>; toolUsageCounts: Record<string, number>; nestedDirectToolCounts: Record<string, number> };
      preflight: { checks: { bridgeReady: boolean; mcpReady: boolean } };
      bridge: { capabilities: string[]; nestedDirectTools: string[]; directToolAliases: Record<string, string>; supportedRequestedAliasCount: number; supportedAliasTargetCount: number; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; directToolCount: number; directBrowserTools: string[]; directMcpTools: string[]; directRuntimeTools: string[]; supportsNestedCallToolDirect: boolean; transcriptSummary: { total: number; byTransport: { runtime: number; socket: number } }; sessionSummary: null | { sessionId: string; transcriptSummary: { total: number } } };
      recommendation: string;
    };
    expect(payload.doctor).toMatchObject({
      deployment: 'crowclaw-local',
      runtime: 'node',
      release: { candidate: true }
    });
    expect(payload.preflight.checks).toMatchObject({
      bridgeReady: true,
      mcpReady: true
    });
    expect(payload.bridgeSummary).toEqual({
      totalSessions: 0,
      directToolCount: 0,
      directBrowserToolCount: 0,
      directMcpToolCount: 0,
      directRuntimeToolCount: 0,
      openSessions: 0,
      busySessions: 0,
      closedSessions: 0,
      totalTranscriptEntries: 0,
      runtimeTranscriptEntries: 0,
      socketTranscriptEntries: 0,
      directSocketEntries: 0,
      fallbackRuntimeEntries: 0,
      aliasAppliedEntries: 0,
      nestedAliasAppliedEntries: 0,
      averageTranscriptEntriesPerSession: 0,
      sessionsWithRuntimeTraffic: 0,
      sessionsWithSocketTraffic: 0,
      sessionsWithDirectSocketTraffic: 0,
      sessionsWithFallbackRuntimeTraffic: 0,
      sessionsWithAliasTraffic: 0,
      sessionsWithNestedAliasTraffic: 0,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliasCount: 0,
      supportedAliasTargetCount: 0,
      supportedRequestedAliases: [],
      supportedAliasTargets: [],
      aliasUsageCounts: {},
      directRequestedAliasCounts: {},
      nestedRequestedAliasCounts: {},
      toolUsageCounts: {},
      nestedDirectToolCounts: {}
    });
    expect(payload.bridge.capabilities).toEqual([]);
    expect(payload.bridge.directToolAliases).toEqual({
      'browser.wait': 'browser.waitFor',
      'browser.wait-for': 'browser.waitFor',
      'browser.click-ref': 'browser.clickRef'
    });
    expect(payload.bridge.supportedRequestedAliasCount).toBe(0);
    expect(payload.bridge.supportedAliasTargetCount).toBe(0);
    expect(payload.bridge.supportedRequestedAliases).toEqual([]);
    expect(payload.bridge.supportedAliasTargets).toEqual([]);
    expect(payload.bridge.nestedDirectTools).toEqual([]);
    expect(payload.bridge.directToolCount).toBe(0);
    expect(payload.bridge.directBrowserTools).toEqual([]);
    expect(payload.bridge.directMcpTools).toEqual([]);
    expect(payload.bridge.directRuntimeTools).toEqual([]);
    expect(payload.bridge.supportsNestedCallToolDirect).toBe(true);
    expect(payload.bridge.sessionSummary).toBeNull();
    expect(payload.bridge.transcriptSummary).toEqual({
      total: 0,
      byTransport: { runtime: 0, socket: 0 },
      byExecutionMode: { runtime: 0, directSocket: 0, fallbackRuntime: 0 },
      aliasAppliedEntries: 0,
      nestedAliasAppliedEntries: 0,
      aliasUsageCounts: {},
      directRequestedAliasCounts: {},
      toolUsageCounts: {},
      nestedDirectToolCounts: {},
      nestedRequestedAliasCounts: {},
      lastEntry: null
    });
    expect(payload.recommendation).toBe('release-candidate-if-docs-and-versioning-are-ready');
  });

  it('keeps release-check usable even when MCP network inspection fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('network down');
    }));

    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local', version: '0.1.0' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/release-check'));
    const payload = await response.json() as {
      doctor: { deployment: string };
      preflight: { checks: { mcpReady: boolean } };
      mcp: { status: { degraded: boolean } | null; tools: unknown[]; resources: unknown[]; prompts: unknown[] };
      recommendation: string;
    };

    expect(payload.doctor.deployment).toBe('crowclaw-local');
    expect(payload.preflight.checks.mcpReady).toBe(true);
    expect(payload.mcp).toMatchObject({
      tools: [],
      resources: [],
      prompts: []
    });
    expect(payload.recommendation).toBe('release-candidate-if-docs-and-versioning-are-ready');
  });

  it('serves a system preflight route for deployment/readiness inspection', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local' });
    const response = await runtime.fetch(new Request('http://localhost/api/system/preflight'));
    const payload = await response.json() as {
      ok: boolean;
      deployment: string;
      runtime: string;
      checks: {
        providerConfigured: boolean;
        workspaceReady: boolean;
        schedulerReady: boolean;
        bridgeReady: boolean;
        bridgeProcessRuntimeAvailable: boolean;
        mcpReady: boolean;
        mcpDegraded: boolean;
        slackSigningSecretConfigured: boolean;
      };
    };

    expect(payload.ok).toBe(true);
    expect(payload.deployment).toBe('crowclaw-local');
    expect(payload.runtime).toBe('node');
    expect(payload.checks).toMatchObject({
      providerConfigured: false,
      workspaceReady: true,
      schedulerReady: true,
      bridgeReady: true,
      bridgeProcessRuntimeAvailable: true,
      mcpReady: true,
      mcpDegraded: false,
      slackSigningSecretConfigured: false
    });
  });

  it('reflects active bridge processes in system status', async () => {
    const runtime = createNodeRuntime({ deploymentName: 'crowclaw-local' });

    await runtime.fetch(new Request('http://localhost/api/code/bridge/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'status-bridge-1' })
    }));

    const response = await runtime.fetch(new Request('http://localhost/api/system/status'));
    const payload = await response.json() as {
      counts: { bridgeProcesses: number; bridgeAliveProcesses: number };
      bridgeSummary: { totalSessions: number; openSessions: number; directToolCount: number; directBrowserToolCount: number; directMcpToolCount: number; directRuntimeToolCount: number; totalTranscriptEntries: number; aliasAppliedEntries: number; nestedAliasAppliedEntries: number; averageTranscriptEntriesPerSession: number; sessionsWithRuntimeTraffic: number; sessionsWithSocketTraffic: number; sessionsWithDirectSocketTraffic: number; sessionsWithFallbackRuntimeTraffic: number; sessionsWithAliasTraffic: number; sessionsWithNestedAliasTraffic: number; directToolAliases: Record<string, string>; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; aliasUsageCounts: Record<string, number>; directRequestedAliasCounts: Record<string, number>; nestedRequestedAliasCounts: Record<string, number>; toolUsageCounts: Record<string, number>; nestedDirectToolCounts: Record<string, number> };
      bridgeSessions: Array<{ sessionId: string; directToolCount: number; transcriptSummary: { total: number } }>;
      bridgeProcesses: Array<{ sessionId: string; mode: string; socketPath: string; socketReady: boolean; directToolAliases: Record<string, string>; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; alive: boolean; directToolCount: number; transcriptSummary: { total: number } }>;
      bridgeCapabilities: { supportsNestedCallToolDirect: boolean; directToolAliases: Record<string, string>; supportedRequestedAliasCount: number; supportedAliasTargetCount: number; supportedRequestedAliases: string[]; supportedAliasTargets: string[]; directToolCount: number; nestedDirectTools: string[]; directBrowserTools: string[]; directMcpTools: string[]; directRuntimeTools: string[] };
    };
    expect(payload.counts.bridgeProcesses).toBeGreaterThanOrEqual(1);
    expect(payload.counts.bridgeAliveProcesses).toBeGreaterThanOrEqual(0);
    expect(payload.bridgeSummary).toEqual(expect.objectContaining({
      totalSessions: 1,
      openSessions: 1,
      directToolCount: expect.any(Number),
      directBrowserToolCount: expect.any(Number),
      directMcpToolCount: expect.any(Number),
      directRuntimeToolCount: expect.any(Number),
      totalTranscriptEntries: 0,
      aliasAppliedEntries: 0,
      nestedAliasAppliedEntries: 0,
      averageTranscriptEntriesPerSession: 0,
      sessionsWithRuntimeTraffic: 0,
      sessionsWithSocketTraffic: 0,
      sessionsWithDirectSocketTraffic: 0,
      sessionsWithFallbackRuntimeTraffic: 0,
      sessionsWithAliasTraffic: 0,
      sessionsWithNestedAliasTraffic: 0,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
      supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
      aliasUsageCounts: {},
      directRequestedAliasCounts: {},
      nestedRequestedAliasCounts: {},
      toolUsageCounts: {},
      nestedDirectToolCounts: {}
    }));
    expect(payload.bridgeSessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: 'status-bridge-1',
        directToolCount: expect.any(Number),
        transcriptSummary: expect.objectContaining({ total: 0 })
      })
    ]));
    expect(payload.bridgeProcesses[0]).toMatchObject({
      sessionId: 'status-bridge-1',
      protocolVersion: 'crowclaw-tool-bridge/v1',
      mode: expect.any(String),
      socketPath: expect.any(String),
      socketReady: expect.any(Boolean),
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
      supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
      supportedDirectTools: expect.any(Array),
      directToolCount: expect.any(Number),
      transcriptSummary: {
        total: 0
      }
    });
    expect(payload.bridgeCapabilities.supportsNestedCallToolDirect).toBe(true);
    expect(payload.bridgeCapabilities.directToolAliases).toEqual({
      'browser.wait': 'browser.waitFor',
      'browser.wait-for': 'browser.waitFor',
      'browser.click-ref': 'browser.clickRef'
    });
    expect(payload.bridgeProcesses[0]?.supportedRequestedAliasCount).toBeGreaterThan(0);
    expect(payload.bridgeProcesses[0]?.supportedAliasTargetCount).toBeGreaterThan(0);
    expect(payload.bridgeCapabilities.supportedRequestedAliasCount).toBeGreaterThan(0);
    expect(payload.bridgeCapabilities.supportedAliasTargetCount).toBeGreaterThan(0);
    expect(payload.bridgeCapabilities.supportedRequestedAliases).toEqual(expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']));
    expect(payload.bridgeCapabilities.supportedAliasTargets).toEqual(expect.arrayContaining(['browser.waitFor', 'browser.clickRef']));
    expect(payload.bridgeCapabilities.directToolCount).toBeGreaterThan(0);
    expect(payload.bridgeCapabilities.nestedDirectTools).toEqual(expect.arrayContaining(['echo', 'mcp.status']));
    expect(payload.bridgeCapabilities.directBrowserTools).toEqual(expect.arrayContaining(['browser.session', 'browser.open']));
    expect(payload.bridgeCapabilities.directMcpTools).toEqual(expect.arrayContaining(['mcp.status', 'mcp.listTools']));
  });
});

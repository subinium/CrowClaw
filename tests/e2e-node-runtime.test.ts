import { describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { runCliInputLine } from '../packages/cli/src/index.js';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('e2e node runtime integration', () => {
  it('connects bridge, browser, gateway, MCP, CLI, memory, and system status in one flow', async () => {
    const runtime = createNodeRuntime({
      deploymentName: 'crowclaw-e2e',
      mcpClient: {
        listTools: async () => [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }],
        listResources: async () => [{ uri: 'file://repo', name: 'Repo' }],
        listPrompts: async () => [{ name: 'summarize-repo' }],
        getStatus: () => ({
          toolsRevision: 0,
          cachedTools: 0,
          supportsResources: true,
          supportsPrompts: true,
          degraded: false,
          lastError: undefined,
          lastRefreshAt: undefined
        }),
        inspect: async () => ({
          status: {
            toolsRevision: 0,
            cachedTools: 0,
            supportsResources: true,
            supportsPrompts: true,
            degraded: false,
            lastError: undefined,
            lastRefreshAt: undefined
          },
          tools: [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }],
          resources: [{ uri: 'file://repo', name: 'Repo' }],
          prompts: [{ name: 'summarize-repo' }]
        }),
        refreshTools: async () => [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }],
        notifyToolsChanged: async () => ({ ok: true, refreshed: [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }] }),
        callTool: async (name: string, args: Record<string, unknown>) => ({ ok: true, content: { name, args } })
      } as never
    });

    // Bridge session lifecycle
    const bridgeCreate = await runtime.fetch(new Request('http://localhost/api/code/bridge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-bridge', maxToolCalls: 2, idleTimeoutMs: 5000 })
    }));
    expect((await bridgeCreate.json() as { sessionId: string }).sessionId).toBe('e2e-bridge');

    const bridgeCall = await runtime.fetch(new Request('http://localhost/api/code/bridge/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-bridge', name: 'echo', arguments: { hello: 'world' } })
    }));
    expect((await bridgeCall.json() as { result: { toolName: string } }).result.toolName).toBe('echo');

    const bridgeStatus = await runtime.fetch(new Request('http://localhost/api/code/bridge/status?sessionId=e2e-bridge'));
    expect(await bridgeStatus.json()).toMatchObject({
      sessionId: 'e2e-bridge',
      exists: true,
      status: 'open',
      transcriptLength: 1,
      transcriptSummary: {
        total: 1,
        byTransport: { runtime: 1, socket: 0 },
        toolUsageCounts: { echo: 1 }
      }
    });

    const bridgeSpawn = await runtime.fetch(new Request('http://localhost/api/code/bridge/spawn', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-bridge-process', maxToolCalls: 2 })
    }));
    expect(await bridgeSpawn.json()).toMatchObject({
      ok: true,
      sessionId: 'e2e-bridge-process',
      process: {
        protocolVersion: 'crowclaw-tool-bridge/v1',
        supportedDirectTools: expect.arrayContaining(['mcp.inspect', 'browser.session'])
      }
    });

    const bridgeSocketAliasCall = await runtime.fetch(new Request('http://localhost/api/code/bridge/call?transport=socket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'e2e-bridge-process',
        payload: {
          name: 'mcp.callTool',
          arguments: {
            name: 'browser.wait',
            arguments: { selector: '#app', timeoutMs: 250 }
          }
        }
      })
    }));
    expect(await bridgeSocketAliasCall.json()).toMatchObject({
      sessionId: 'e2e-bridge-process',
      contract: {
        nestedRequestedToolName: 'browser.wait',
        nestedCanonicalToolName: 'browser.waitFor',
        nestedAliasApplied: true
      },
      toolResult: {
        toolName: 'mcp.callTool'
      }
    });

    const bridgeDirectAliasCall = await runtime.fetch(new Request('http://localhost/api/code/bridge/call?transport=socket', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: 'e2e-bridge-process',
        payload: {
          name: 'browser.wait-for',
          arguments: { selector: '#alias', timeoutMs: 150 }
        }
      })
    }));
    expect(await bridgeDirectAliasCall.json()).toMatchObject({
      sessionId: 'e2e-bridge-process',
      contract: {
        requestedToolName: 'browser.wait-for',
        canonicalToolName: 'browser.waitFor',
        aliasApplied: true
      },
      toolResult: {
        toolName: 'browser.waitFor'
      }
    });

    const bridgeCapabilities = await runtime.fetch(new Request('http://localhost/api/code/bridge/capabilities?sessionId=e2e-bridge-process'));
    expect(await bridgeCapabilities.json()).toMatchObject({
      sessionId: 'e2e-bridge-process',
      protocolVersion: 'crowclaw-tool-bridge/v1',
      supportsNestedCallToolDirect: true,
      directToolAliases: {
        'browser.wait': 'browser.waitFor',
        'browser.wait-for': 'browser.waitFor',
        'browser.click-ref': 'browser.clickRef'
      },
      supportedRequestedAliasCount: expect.any(Number),
      supportedAliasTargetCount: expect.any(Number),
      supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
      supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
      directToolCount: expect.any(Number),
      directBrowserTools: expect.arrayContaining(['browser.open', 'browser.screenshot']),
      directMcpTools: expect.arrayContaining(['mcp.status', 'mcp.inspect']),
      nestedDirectTools: expect.arrayContaining(['mcp.status', 'browser.session', 'browser.open', 'browser.goto', 'browser.navigate', 'browser.snapshot', 'browser.console', 'browser.images', 'browser.vision', 'browser.back', 'browser.scroll', 'browser.press', 'browser.clickRef', 'browser.waitFor', 'browser.extract', 'browser.click', 'browser.type', 'browser.screenshot'])
    });

    // Browser session flow
    await runtime.fetch(new Request('http://localhost/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-browser', url: 'https://example.com/e2e' })
    }));
    await runtime.fetch(new Request('http://localhost/api/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'e2e-browser', full: true })
    }));
    const browserSession = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=e2e-browser'));
    expect(await browserSession.json()).toMatchObject({
      sessionId: 'e2e-browser',
      currentUrl: 'https://example.com/e2e',
      lastRefs: ['@e1', '@e2', '@e3']
    });

    // Gateway inspect
    const gatewayInspect = await runtime.fetch(new Request('http://localhost/api/gateway/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: 'email',
        payload: {
          messageId: 'email-e2e-1',
          from: 'user@example.com',
          to: 'agent@example.com',
          subject: 'Ship it',
          text: 'please deploy crowclaw',
          inboxId: 'inbox-e2e'
        }
      })
    }));
    expect(await gatewayInspect.json()).toMatchObject({
      ok: true,
      deliveryPlan: {
        platform: 'email',
        sessionId: 'email:inbox-e2e'
      }
    });

    // Session + memory path
    await runtime.fetch(new Request('http://localhost/api/sessions/e2e-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'hello from e2e' })
    }));
    await runtime.fetch(new Request('http://localhost/api/sessions/e2e-chat/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'remember this e2e fact', tags: ['e2e'] })
    }));

    // MCP inspect
    const mcpInspect = await runtime.fetch(new Request('http://localhost/api/mcp/inspect'));
    expect(await mcpInspect.json()).toMatchObject({
      status: {
        supportsResources: true,
        supportsPrompts: true
      },
      tools: [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }]
    });

    // CLI integration over same runtime
    const doctor = await runCliInputLine('/doctor', { sessionId: 'e2e-chat' }, { runtime });
    expect(doctor.output).toContain('"deployment": "crowclaw-e2e"');

    const history = await runCliInputLine('/history', { sessionId: 'e2e-chat' }, { runtime });
    expect(history.output).toContain('user: hello from e2e');

    const memories = await runCliInputLine('/memories', { sessionId: 'e2e-chat' }, { runtime });
    expect(memories.output).toContain('remember this e2e fact');

    const bridge = await runCliInputLine('/bridge-status', { sessionId: 'e2e-bridge' }, { runtime });
    expect(bridge.output).toContain('"transcriptLength": 1');
    expect(bridge.output).toContain('"transcriptSummary"');

    const bridgeCapsCli = await runCliInputLine('/bridge-capabilities', { sessionId: 'e2e-bridge-process' }, { runtime });
    expect(bridgeCapsCli.output).toContain('"supportsNestedCallToolDirect": true');

    const releaseCheck = await runCliInputLine('/release-check', { sessionId: 'e2e-bridge-process' }, { runtime });
    expect(releaseCheck.output).toContain('"nestedDirectTools"');
    expect(releaseCheck.output).toContain('"directBrowserTools"');
    expect(releaseCheck.output).toContain('"transcriptSummary"');

    const mcp = await runCliInputLine('/mcp-inspect', { sessionId: 'e2e-chat' }, { runtime });
    expect(mcp.output).toContain('"tools"');

    // System status should reflect active sessions
    const systemStatus = await runtime.fetch(new Request('http://localhost/api/system/status'));
    expect(await systemStatus.json()).toMatchObject({
      ok: true,
      deployment: 'crowclaw-e2e',
      counts: {
        bridgeSessions: 2,
        browserSessions: 1
      },
      bridgeSummary: {
        totalSessions: 2,
        openSessions: 2,
        directToolCount: expect.any(Number),
        directBrowserToolCount: expect.any(Number),
        directMcpToolCount: expect.any(Number),
        directRuntimeToolCount: expect.any(Number),
        totalTranscriptEntries: 3,
        runtimeTranscriptEntries: 1,
        socketTranscriptEntries: 2,
        aliasAppliedEntries: 1,
        nestedAliasAppliedEntries: 1,
        averageTranscriptEntriesPerSession: 1.5,
        sessionsWithRuntimeTraffic: 1,
        sessionsWithSocketTraffic: 1,
        sessionsWithDirectSocketTraffic: expect.any(Number),
        sessionsWithFallbackRuntimeTraffic: expect.any(Number),
        sessionsWithAliasTraffic: 1,
        sessionsWithNestedAliasTraffic: 1,
        directToolAliases: {
          'browser.wait': 'browser.waitFor',
          'browser.wait-for': 'browser.waitFor',
          'browser.click-ref': 'browser.clickRef'
        },
        supportedRequestedAliasCount: expect.any(Number),
        supportedAliasTargetCount: expect.any(Number),
        supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
        supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
        aliasUsageCounts: {
          'browser.wait-for': 1,
          'browser.waitFor': 1
        },
        directRequestedAliasCounts: {
          'browser.wait-for': 1
        },
        nestedRequestedAliasCounts: {
          'browser.wait': 1
        },
        toolUsageCounts: {
          echo: 1,
          'mcp.callTool': 1,
          'browser.waitFor': 1
        },
        nestedDirectToolCounts: {
          'browser.waitFor': 1
        }
      },
      bridgeSessions: expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'e2e-bridge',
          transcriptSummary: expect.objectContaining({ total: 1, toolUsageCounts: { echo: 1 } })
        }),
        expect.objectContaining({
          sessionId: 'e2e-bridge-process',
          directToolCount: expect.any(Number),
          transcriptSummary: expect.objectContaining({
            total: 2,
            aliasAppliedEntries: 1,
            nestedAliasAppliedEntries: 1
          })
        })
      ]),
      bridgeCapabilities: {
        supportsNestedCallToolDirect: true,
        directToolAliases: {
          'browser.wait': 'browser.waitFor',
          'browser.wait-for': 'browser.waitFor',
          'browser.click-ref': 'browser.clickRef'
        },
        supportedRequestedAliasCount: expect.any(Number),
        supportedAliasTargetCount: expect.any(Number),
        supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
        supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
        directToolCount: expect.any(Number),
        directBrowserTools: expect.arrayContaining(['browser.open', 'browser.screenshot']),
        nestedDirectTools: expect.arrayContaining(['mcp.status', 'browser.session', 'browser.open', 'browser.goto', 'browser.navigate', 'browser.snapshot', 'browser.console', 'browser.images', 'browser.vision', 'browser.back', 'browser.scroll', 'browser.press', 'browser.clickRef', 'browser.waitFor', 'browser.extract', 'browser.click', 'browser.type', 'browser.screenshot'])
      },
      bridgeProcesses: expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'e2e-bridge-process',
          directToolAliases: {
            'browser.wait': 'browser.waitFor',
            'browser.wait-for': 'browser.waitFor',
            'browser.click-ref': 'browser.clickRef'
          },
          supportedRequestedAliasCount: expect.any(Number),
          supportedAliasTargetCount: expect.any(Number),
          supportedRequestedAliases: expect.arrayContaining(['browser.wait', 'browser.wait-for', 'browser.click-ref']),
          supportedAliasTargets: expect.arrayContaining(['browser.waitFor', 'browser.clickRef']),
          directToolCount: expect.any(Number),
          transcriptSummary: expect.objectContaining({ total: 2, aliasAppliedEntries: 1, nestedAliasAppliedEntries: 1 })
        })
      ])
    });
  });
});

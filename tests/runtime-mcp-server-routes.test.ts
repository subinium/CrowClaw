import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';

describe('runtime mcp server routes', () => {
  it('exposes embedded MCP server tools and handles tool calls', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-runtime-mcp'
    });

    const toolsResponse = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverTools)));
    const toolsPayload = await toolsResponse.json() as {
      server: { name: string };
      tools: Array<{ name: string }>;
    };
    expect(toolsPayload.server.name).toBe('crowclaw-runtime-mcp');
    expect(toolsPayload.tools.map((tool) => tool.name)).toContain('crowclaw.chat');

    const callResponse = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverRequest), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'crowclaw.chat',
          arguments: {
            sessionId: 'mcp-runtime-session',
            message: 'hello from mcp server route'
          }
        }
      })
    }));
    const callPayload = await callResponse.json() as {
      result?: { content: Array<{ text: string }> };
      error?: { message: string };
    };
    expect(callPayload.error).toBeUndefined();
    expect(callPayload.result?.content[0]?.text).toContain('CrowClaw received');
  });

  it('wires embedded MCP session tools to the live runtime session store (#202)', async () => {
    const sessionStore = new InMemorySessionStore();
    await sessionStore.put({
      agentId: 'crowclaw-runtime-mcp',
      sessionId: 'embedded-live-session',
      updatedAt: '2026-05-03T00:00:00.000Z',
      messages: [
        {
          role: 'user',
          content: 'stored before runtime starts',
          createdAt: '2026-05-03T00:00:00.000Z',
        },
      ],
    });

    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-runtime-mcp',
      sessionStore,
    });

    const response = await runtime.fetch(new Request(localRoute(routePaths.mcp.serverRequest), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 202,
        method: 'tools/call',
        params: {
          name: 'crowclaw.sessions.list',
          arguments: {},
        },
      }),
    }));
    const payload = await response.json() as {
      result?: { content: Array<{ text: string }> };
      error?: { message: string };
    };

    expect(payload.error).toBeUndefined();
    const body = JSON.parse(payload.result?.content[0]?.text ?? '{}') as {
      sessions: Array<{ sessionId: string }>;
    };
    expect(body.sessions.map((session) => session.sessionId)).toContain('embedded-live-session');
  });
});

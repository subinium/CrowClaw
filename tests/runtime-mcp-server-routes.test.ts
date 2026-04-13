import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';

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
});

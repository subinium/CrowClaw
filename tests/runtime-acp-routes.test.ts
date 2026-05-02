import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { localRoute, routePaths } from '../packages/runtime-node/src/route-paths.js';
import { EchoProvider } from '@crowclaw/providers';
import { ToolRegistry, createEchoTool, createTimeTool } from '@crowclaw/tools';

describe('runtime acp routes', () => {
  it('exposes embedded ACP info, sessions, and prompt execution', async () => {
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-runtime-acp'
    });

    const infoResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.info)));
    const infoPayload = await infoResponse.json() as { result: { name: string; display_name: string } };
    expect(infoPayload.result.name).toBe('crowclaw-runtime-acp');

    const createResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.sessions), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ACP Demo' })
    }));
    const createPayload = await createResponse.json() as { result: { id: string; title?: string } };
    expect(createPayload.result.title).toBe('ACP Demo');

    const listResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.sessions)));
    const listPayload = await listResponse.json() as { result: { sessions: Array<{ id: string }> } };
    expect(listPayload.result.sessions.map((session) => session.id)).toContain(createPayload.result.id);

    const deleteResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.request), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'sessions/delete',
        params: { sessionId: createPayload.result.id }
      })
    }));
    const deletePayload = await deleteResponse.json() as { result: { deleted: boolean } };
    expect(deletePayload.result.deleted).toBe(true);

    const promptSessionResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.sessions), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'ACP Prompt Session' })
    }));
    const promptSessionPayload = await promptSessionResponse.json() as { result: { id: string } };

    const promptResponse = await runtime.fetch(new Request(localRoute(routePaths.acp.prompt), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: promptSessionPayload.result.id,
        message: 'hello from acp route'
      })
    }));
    const promptPayload = await promptResponse.json() as { result: { response: string } };
    expect(promptPayload.result.response).toContain('CrowClaw received');
  });

  it('wires embedded ACP tools/list to the live runtime tool registry (#203)', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const runtime = createNodeRuntime({
      provider: new EchoProvider(),
      agentId: 'crowclaw-runtime-acp',
      tools,
    });

    tools.register(createTimeTool());

    const response = await runtime.fetch(new Request(localRoute(routePaths.acp.request), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 203,
        method: 'tools/list',
      }),
    }));
    const payload = await response.json() as {
      result: { tools: Array<{ name: string }>; available: boolean };
    };

    expect(payload.result.available).toBe(true);
    const names = payload.result.tools.map((tool) => tool.name);
    expect(names).toContain('echo');
    expect(names).toContain('time');
  });
});

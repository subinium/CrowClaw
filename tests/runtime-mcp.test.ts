import { describe, expect, it } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime MCP integration', () => {
  it('lists and calls MCP tools through the node runtime routes', async () => {
    const tools = [{ name: 'mcp-docs.search', originalName: 'search', registeredName: 'mcp-docs.search' }];
    const resources = [{ uri: 'file://repo', name: 'Repo' }];
    const prompts = [{ name: 'summarize-repo' }];
    const runtime = createNodeRuntime({
      mcpClient: {
        listTools: async () => tools,
        listResources: async () => resources,
        listPrompts: async () => prompts,
        getStatus: () => ({
          toolsRevision: 0,
          cachedTools: 0,
          supportsResources: true,
          supportsPrompts: true,
          degraded: false,
          lastError: undefined,
          lastRefreshAt: undefined
        }),
        refreshTools: async () => tools,
        notifyToolsChanged: async () => ({ ok: true, refreshed: tools }),
        callTool: async (name, args) => ({ ok: true, content: { name, args } })
      } as never
    });

    const list = await runtime.fetch(new Request('http://localhost/api/mcp/tools'));
    expect(await list.json()).toEqual(tools);

    const resourceList = await runtime.fetch(new Request('http://localhost/api/mcp/resources'));
    expect(await resourceList.json()).toEqual(resources);

    const promptList = await runtime.fetch(new Request('http://localhost/api/mcp/prompts'));
    expect(await promptList.json()).toEqual(prompts);

    const status = await runtime.fetch(new Request('http://localhost/api/mcp/status'));
    expect(await status.json()).toEqual({
      toolsRevision: 0,
      cachedTools: 0,
      supportsResources: true,
      supportsPrompts: true,
      degraded: false,
      lastError: undefined,
      lastRefreshAt: undefined
    });

    const inspect = await runtime.fetch(new Request('http://localhost/api/mcp/inspect?refresh=true'));
    expect(await inspect.json()).toEqual({
      status: {
        toolsRevision: 0,
        cachedTools: 0,
        supportsResources: true,
        supportsPrompts: true,
        degraded: false,
        lastError: undefined,
        lastRefreshAt: undefined
      },
      tools,
      resources,
      prompts
    });

    const reload = await runtime.fetch(new Request('http://localhost/api/mcp/reload', {
      method: 'POST'
    }));
    expect(await reload.json()).toEqual(tools);

    const changed = await runtime.fetch(new Request('http://localhost/api/mcp/list-changed', {
      method: 'POST'
    }));
    expect(await changed.json()).toEqual({ ok: true, refreshed: tools });

    const call = await runtime.fetch(new Request('http://localhost/api/mcp/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp-docs.search', arguments: { query: 'crowclaw' } })
    }));
    expect(await call.json()).toEqual({ ok: true, content: { name: 'mcp-docs.search', args: { query: 'crowclaw' } } });
  });
});

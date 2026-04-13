import { afterEach, describe, expect, it, vi } from 'vitest';
import { McpClient, McpHttpTransport, MultiServerMcpManager } from '../packages/mcp/src/index.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP client', () => {
  it('lists tools through the HTTP transport', async () => {
    const fetchMock = vi.fn(async () => Response.json({ tools: [{ name: 'search', description: 'Search docs' }] }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient(new McpHttpTransport({ baseUrl: 'https://mcp.example.com' }));
    await expect(client.listTools()).resolves.toEqual([{
      name: 'search',
      description: 'Search docs',
      originalName: 'search',
      registeredName: 'search'
    }]);
  });

  it('calls tools through the HTTP transport', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Response.json({ tools: [{ name: 'search', description: 'Search docs' }] });
      }
      return Response.json({ ok: true, content: JSON.parse(String(init?.body)) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new McpClient(new McpHttpTransport({ baseUrl: 'https://mcp.example.com' }));
    const result = await client.callTool('search', { query: 'crowclaw' });

    expect(result.ok).toBe(true);
    expect(result.content).toEqual({ name: 'search', arguments: { query: 'crowclaw' } });
  });

  it('supports cached refreshable tool discovery with prefixing and filtering', async () => {
    const transport = {
      listTools: vi.fn(async () => ([
        { name: 'search', description: 'Search docs' },
        { name: 'fetch', description: 'Fetch pages' }
      ])),
      callTool: vi.fn(async (name: string, arguments_: Record<string, unknown>) => ({
        ok: true,
        content: { name, arguments: arguments_ }
      }))
    };

    const client = new McpClient(transport, {
      toolPrefix: 'mcp-filesystem',
      allowTools: ['search']
    });

    const discovered = await client.refreshTools();
    expect(discovered).toEqual([
      {
        name: 'mcp-filesystem.search',
        registeredName: 'mcp-filesystem.search',
        originalName: 'search',
        description: 'Search docs'
      }
    ]);

    const cached = await client.listTools();
    expect(cached).toHaveLength(1);
    expect(transport.listTools).toHaveBeenCalledTimes(1);

    const result = await client.callTool('mcp-filesystem.search', { query: 'crowclaw' });
    expect(result.ok).toBe(true);
    expect(transport.callTool).toHaveBeenCalledWith('search', { query: 'crowclaw' });
  });

  it('supports resources, prompts, and list_changed cache invalidation', async () => {
    const transport = {
      listTools: vi.fn(async () => ([{ name: 'search' }])),
      listResources: vi.fn(async () => ([{ uri: 'file://README.md', name: 'README' }])),
      listPrompts: vi.fn(async () => ([{ name: 'summarize', description: 'Summarize context' }])),
      callTool: vi.fn(async () => ({ ok: true, content: { ok: true } }))
    };

    const client = new McpClient(transport);
    await expect(client.listResources()).resolves.toEqual([{ uri: 'file://README.md', name: 'README' }]);
    await expect(client.listPrompts()).resolves.toEqual([{ name: 'summarize', description: 'Summarize context' }]);

    await client.listTools();
    expect(client.getToolsRevision()).toBe(0);
    client.markToolsChanged();
    expect(client.getToolsRevision()).toBe(1);
    await client.listTools();
    expect(transport.listTools).toHaveBeenCalledTimes(2);
  });

  it('returns a full inspect bundle', async () => {
    const client = new McpClient({
      listTools: async () => [{ name: 'search' }],
      listResources: async () => [{ uri: 'file://README.md', name: 'README' }],
      listPrompts: async () => [{ name: 'summarize' }],
      callTool: async () => ({ ok: true, content: {} })
    });

    const inspect = await client.inspect({ refresh: true });
    expect(inspect).toEqual({
      status: {
        toolsRevision: 0,
        cachedTools: 1,
        supportsResources: true,
        supportsPrompts: true,
        degraded: false,
        lastError: undefined,
        lastRefreshAt: expect.any(String)
      },
      tools: [{ name: 'search', originalName: 'search', registeredName: 'search' }],
      resources: [{ uri: 'file://README.md', name: 'README' }],
      prompts: [{ name: 'summarize' }]
    });
  });

  it('reports degraded MCP status after refresh failures', async () => {
    const client = new McpClient({
      listTools: vi.fn(async () => {
        throw new Error('upstream unavailable');
      }),
      callTool: vi.fn(async () => ({ ok: true, content: {} }))
    });

    await expect(client.refreshTools()).rejects.toThrow('upstream unavailable');
    expect(client.getStatus()).toMatchObject({
      degraded: true,
      lastError: 'upstream unavailable',
      lastRefreshAt: expect.any(String)
    });
  });

  it('aggregates multiple MCP servers with prefixed names', async () => {
    const docs = new McpClient({
      listTools: async () => [{ name: 'search' }],
      listResources: async () => [{ uri: 'docs://intro', name: 'Intro' }],
      listPrompts: async () => [{ name: 'summarize-docs' }],
      callTool: async (name, arguments_) => ({ ok: true, content: { server: 'docs', name, arguments_ } })
    });
    const files = new McpClient({
      listTools: async () => [{ name: 'read' }],
      listResources: async () => [{ uri: 'file://README.md', name: 'README' }],
      listPrompts: async () => [{ name: 'summarize-files' }],
      callTool: async (name, arguments_) => ({ ok: true, content: { server: 'files', name, arguments_ } })
    });

    const manager = new MultiServerMcpManager({ docs, files });
    const tools = await manager.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['docs.search', 'files.read']);

    const resources = await manager.listResources();
    expect(resources).toEqual([
      { uri: 'docs://intro', name: 'Intro', serverName: 'docs' },
      { uri: 'file://README.md', name: 'README', serverName: 'files' }
    ]);

    const prompts = await manager.listPrompts();
    expect(prompts).toEqual([
      { name: 'summarize-docs', serverName: 'docs' },
      { name: 'summarize-files', serverName: 'files' }
    ]);

    const result = await manager.callTool('files.read', { path: 'README.md' });
    expect(result.ok).toBe(true);
    expect(result.content).toEqual({ server: 'files', name: 'read', arguments_: { path: 'README.md' } });

    manager.notifyToolsChanged('docs');
    expect(docs.getToolsRevision()).toBe(1);
    expect(files.getToolsRevision()).toBe(0);
    expect(manager.getServerStatus()).toEqual({
      docs: {
        toolsRevision: 1,
        cachedTools: 0,
        supportsResources: true,
        supportsPrompts: true,
        degraded: false,
        lastError: undefined,
        lastRefreshAt: expect.any(String)
      },
      files: {
        toolsRevision: 0,
        cachedTools: 1,
        supportsResources: true,
        supportsPrompts: true,
        degraded: false,
        lastError: undefined,
        lastRefreshAt: expect.any(String)
      }
    });
  });
});

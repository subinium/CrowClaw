import { describe, expect, it } from 'vitest';
import { ToolRegistry, createMcpCallTool, createMcpInspectTool, createMcpListPromptsTool, createMcpListResourcesTool, createMcpListToolsTool, createMcpStatusTool } from '@crowclaw/tools';
import { McpClient, type McpToolDefinition, type McpCallResult, type McpTransport } from '@crowclaw/mcp';

class FakeMcpTransport implements McpTransport {
  async listTools(): Promise<McpToolDefinition[]> {
    return [
      { name: 'search', description: 'Searches docs' },
      { name: 'fetch', description: 'Fetches pages' }
    ];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    return {
      ok: true,
      content: { name, arguments: arguments_ }
    };
  }

  async listResources() {
    return [{ uri: 'file://README.md', name: 'README' }];
  }

  async listPrompts() {
    return [{ name: 'summarize', description: 'Summarize context' }];
  }
}

describe('MCP tool integrations', () => {
  it('lists MCP tools through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry().register(createMcpListToolsTool(client));

    const result = await registry.execute('mcp.listTools', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('search');
    expect(result.output).toContain('fetch');
  });

  it('calls MCP tools through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry().register(createMcpCallTool(client));

    const result = await registry.execute('mcp.callTool', {
      name: 'search',
      arguments: { q: 'crowclaw' }
    }, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-2'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('crowclaw');
    expect(result.metadata).toMatchObject({ name: 'search', isError: false });
  });

  it('calls prefixed registered MCP tools through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport(), { toolPrefix: 'mcp-demo' });
    await client.refreshTools();
    const registry = new ToolRegistry()
      .register(createMcpListToolsTool(client))
      .register(createMcpCallTool(client));

    const list = await registry.execute('mcp.listTools', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-2a'
    });
    expect(list.output).toContain('mcp-demo.search');

    const result = await registry.execute('mcp.callTool', {
      name: 'mcp-demo.search',
      arguments: { q: 'prefixed' }
    }, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-2b'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('prefixed');
    expect(result.metadata).toMatchObject({ name: 'mcp-demo.search', isError: false });
  });

  it('returns a useful error when MCP tool name is missing', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry().register(createMcpCallTool(client));

    const result = await registry.execute('mcp.callTool', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-3'
    });

    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing MCP tool name');
  });

  it('lists MCP resources and prompts through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry()
      .register(createMcpListResourcesTool(client))
      .register(createMcpListPromptsTool(client));

    const resources = await registry.execute('mcp.listResources', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-3a'
    });
    expect(resources.ok).toBe(true);
    expect(resources.output).toContain('README');

    const prompts = await registry.execute('mcp.listPrompts', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-3b'
    });
    expect(prompts.ok).toBe(true);
    expect(prompts.output).toContain('summarize');
  });

  it('reports MCP status through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry().register(createMcpStatusTool(client));

    const result = await registry.execute('mcp.status', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-3c'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('supportsResources');
    expect(result.metadata).toMatchObject({ supportsResources: true, supportsPrompts: true });
  });

  it('reports MCP inspect bundles through the tool registry', async () => {
    const client = new McpClient(new FakeMcpTransport());
    const registry = new ToolRegistry().register(createMcpInspectTool(client));

    const result = await registry.execute('mcp.inspect', { refresh: true }, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-3d'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('"tools"');
    expect(result.output).toContain('"resources"');
    expect(result.output).toContain('"prompts"');
    expect(result.metadata).toMatchObject({ refresh: true, tools: 2, resources: 1, prompts: 1, degraded: false });
  });

  it('exposes registered tool metadata that can support multi-server naming', async () => {
    const client = new McpClient(new FakeMcpTransport(), { toolPrefix: 'server-a' });
    const registry = new ToolRegistry().register(createMcpListToolsTool(client));

    const result = await registry.execute('mcp.listTools', {}, {
      agentId: 'crowclaw',
      sessionId: 'mcp-tools-4'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('server-a.search');
    expect(result.output).toContain('registeredName');
    expect(result.output).toContain('originalName');
  });
});

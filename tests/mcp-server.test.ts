import { describe, expect, it } from 'vitest';
import { CrowClawMcpServer } from '@crowclaw/mcp-server';

describe('MCP server', () => {
  function createTestServer() {
    return new CrowClawMcpServer({
      run: async (input) => ({
        finalResponse: `Reply: ${input.userMessage}`
      })
    }, {
      name: 'crowclaw-test',
      version: '0.1.0'
    });
  }

  it('handles initialize', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    expect(response.result).toBeDefined();
    const result = response.result as { serverInfo: { name: string }; capabilities: Record<string, unknown> };
    expect(result.serverInfo.name).toBe('crowclaw-test');
    expect(result.capabilities).toHaveProperty('tools');
  });

  it('lists tool definitions', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/list'
    });

    const result = response.result as { tools: Array<{ name: string }> };
    expect(result.tools.length).toBeGreaterThanOrEqual(1);
    const names = result.tools.map(t => t.name);
    expect(names).toContain('crowclaw.chat');
  });

  it('calls crowclaw.chat tool', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'crowclaw.chat',
        arguments: { sessionId: 'test-session', message: 'Hello MCP!' }
      }
    });

    const result = response.result as { content: Array<{ type: string; text: string }> };
    expect(result.content).toBeDefined();
    expect(result.content[0].text).toContain('Reply: Hello MCP!');
  });

  it('returns error for unknown tool', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'nonexistent.tool',
        arguments: {}
      }
    });

    expect(response.error).toBeDefined();
  });

  it('returns empty resources and prompts', async () => {
    const server = createTestServer();

    const resources = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'resources/list'
    });
    expect((resources.result as { resources: unknown[] }).resources).toEqual([]);

    const prompts = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'prompts/list'
    });
    expect((prompts.result as { prompts: unknown[] }).prompts).toEqual([]);
  });

  it('exposes tool definitions via getToolDefinitions', () => {
    const server = createTestServer();
    const tools = server.getToolDefinitions();
    expect(tools.length).toBeGreaterThanOrEqual(1);
    expect(tools.every(t => t.inputSchema.type === 'object')).toBe(true);
  });
});

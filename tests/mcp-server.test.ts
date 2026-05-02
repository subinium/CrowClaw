import { describe, expect, it } from 'vitest';
import { CrowClawMcpServer } from '@crowclaw/mcp-server';
import { InMemoryMemoryStore, InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

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

  it('uses wired runtime stores for sessions, memories, and tool catalog', async () => {
    const sessionStore = new InMemorySessionStore();
    const memoryStore = new InMemoryMemoryStore();
    const toolCatalog = new ToolRegistry().register(createEchoTool());
    await sessionStore.put({
      agentId: 'crowclaw',
      sessionId: 'mcp-real-session',
      updatedAt: '2026-05-02T00:00:00.000Z',
      messages: [
        { role: 'user', content: 'remember runtime data', createdAt: '2026-05-02T00:00:00.000Z' },
      ],
    });
    await memoryStore.write({
      id: 'mem-1',
      sessionId: 'mcp-real-session',
      scope: 'session',
      summary: 'runtime memory result',
      tags: ['runtime'],
      createdAt: '2026-05-02T00:00:00.000Z',
    });

    const server = new CrowClawMcpServer({
      run: async (input) => ({ finalResponse: `Reply: ${input.userMessage}` })
    }, { sessionStore, memoryStore, toolCatalog });

    const sessions = await server.handleRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'tools/call',
      params: { name: 'crowclaw.sessions.list', arguments: {} },
    });
    expect(JSON.parse((sessions.result as { content: Array<{ text: string }> }).content[0]!.text).sessions[0].sessionId).toBe('mcp-real-session');

    const memories = await server.handleRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'tools/call',
      params: { name: 'crowclaw.memories.search', arguments: { query: 'runtime' } },
    });
    expect((memories.result as { content: Array<{ text: string }> }).content[0]!.text).toContain('runtime memory result');

    const tools = await server.handleRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'tools/call',
      params: { name: 'crowclaw.tools.list', arguments: {} },
    });
    expect(JSON.parse((tools.result as { content: Array<{ text: string }> }).content[0]!.text).tools).toEqual(['echo']);
  });

  // ------------------------------------------------------------------------
  // #27 — owner-only tool gating at the MCP bridge boundary
  // ------------------------------------------------------------------------

  describe('owner-only tool gating (#27)', () => {
    function createGatedServer() {
      return new CrowClawMcpServer(
        {
          run: async (input) => ({ finalResponse: `Reply: ${input.userMessage}` })
        },
        { name: 'crowclaw-test', version: '0.1.0', ownerToken: 'secret-owner-token' }
      );
    }

    it('hides ownerOnly tools from non-owner tools/list responses', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list'
        // no _meta.token
      });

      const result = response.result as { tools: Array<{ name: string; ownerOnly?: boolean }> };
      const names = result.tools.map(t => t.name);
      expect(names).not.toContain('crowclaw.chat');
      expect(names).not.toContain('crowclaw.sessions.list');
      expect(names).not.toContain('crowclaw.sessions.get');
      expect(names).not.toContain('crowclaw.memories.search');
      // Non-owner-only tools remain visible
      expect(names).toContain('crowclaw.tools.list');
    });

    it('exposes ownerOnly tools to callers that present the owner token', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        _meta: { token: 'secret-owner-token' }
      });

      const result = response.result as { tools: Array<{ name: string }> };
      const names = result.tools.map(t => t.name);
      expect(names).toContain('crowclaw.chat');
      expect(names).toContain('crowclaw.sessions.list');
    });

    it('rejects ownerOnly tools/call from non-owner clients', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'crowclaw.chat',
          arguments: { sessionId: 's1', message: 'hi' }
        }
      });

      expect(response.error).toBeDefined();
      // Result must NOT execute the agent loop
      expect(response.result).toBeUndefined();
    });

    it('rejects ownerOnly tools/call when token mismatches', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'crowclaw.chat',
          arguments: { sessionId: 's1', message: 'hi' }
        },
        _meta: { token: 'wrong-token' }
      });

      expect(response.error).toBeDefined();
      expect(response.result).toBeUndefined();
    });

    it('allows ownerOnly tools/call when caller presents owner token', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: {
          name: 'crowclaw.chat',
          arguments: { sessionId: 's1', message: 'hi' }
        },
        _meta: { token: 'secret-owner-token' }
      });

      expect(response.error).toBeUndefined();
      const result = response.result as { content: Array<{ text: string }> };
      expect(result.content[0].text).toContain('Reply: hi');
    });

    it('crowclaw.tools.list filters ownerOnly tool names for non-owner callers', async () => {
      const server = createGatedServer();
      const response = await server.handleRequest({
        jsonrpc: '2.0',
        id: 6,
        method: 'tools/call',
        params: {
          name: 'crowclaw.tools.list',
          arguments: {}
        }
      });

      const result = response.result as { content: Array<{ text: string }> };
      const payload = JSON.parse(result.content[0].text) as { tools: string[] };
      expect(payload.tools).not.toContain('crowclaw.chat');
      expect(payload.tools).not.toContain('crowclaw.memories.search');
    });

    it('legacy mode (no ownerToken configured) treats every caller as owner', async () => {
      const server = createTestServer(); // no ownerToken
      const list = await server.handleRequest({
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/list'
      });

      const names = (list.result as { tools: Array<{ name: string }> }).tools.map(t => t.name);
      expect(names).toContain('crowclaw.chat');
    });
  });
});

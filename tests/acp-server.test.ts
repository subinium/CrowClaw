import { describe, expect, it } from 'vitest';
import { AcpServer, generateAcpManifest } from '@crowclaw/acp';

describe('ACP server', () => {
  function createTestServer() {
    return new AcpServer({
      run: async (input) => ({
        finalResponse: `Echo: ${input.userMessage}`,
        toolResults: []
      })
    }, {
      agentId: 'test-agent',
      displayName: 'Test CrowClaw',
      version: '0.1.0'
    });
  }

  it('handles initialize request', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {}
    });

    expect(response.id).toBe(1);
    expect(response.result).toBeDefined();
    const result = response.result as { capabilities: Record<string, unknown>; agent: Record<string, unknown> };
    expect(result.capabilities).toBeDefined();
    expect(result.agent.name).toBe('test-agent');
  });

  it('handles agent/info request', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 2,
      method: 'agent/info'
    });

    expect(response.result).toBeDefined();
    const info = response.result as { name: string; display_name: string };
    expect(info.display_name).toBe('Test CrowClaw');
  });

  it('handles sessions/create and sessions/list', async () => {
    const server = createTestServer();

    const create = await server.handleRequest({
      jsonrpc: '2.0',
      id: 3,
      method: 'sessions/create',
      params: { title: 'Test Session' }
    });
    expect(create.result).toBeDefined();
    const session = create.result as { id: string; title: string };
    expect(session.title).toBe('Test Session');

    const list = await server.handleRequest({
      jsonrpc: '2.0',
      id: 4,
      method: 'sessions/list'
    });
    const listResult = list.result as { sessions: Array<{ id: string }> };
    expect(listResult.sessions).toHaveLength(1);
    expect(listResult.sessions[0].id).toBe(session.id);
  });

  it('handles prompt/execute', async () => {
    const server = createTestServer();

    // Create a session first
    const create = await server.handleRequest({
      jsonrpc: '2.0',
      id: 5,
      method: 'sessions/create'
    });
    const sessionId = (create.result as { id: string }).id;

    const execute = await server.handleRequest({
      jsonrpc: '2.0',
      id: 6,
      method: 'prompt/execute',
      params: { sessionId, message: 'Hello ACP!' }
    });

    expect(execute.result).toBeDefined();
    const result = execute.result as { response: string };
    expect(result.response).toBe('Echo: Hello ACP!');
  });

  it('returns error for unknown method', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 99,
      method: 'nonexistent/method'
    });

    expect(response.error).toBeDefined();
    expect(response.error?.code).toBe(-32601);
  });

  it('handles shutdown', async () => {
    const server = createTestServer();
    const response = await server.handleRequest({
      jsonrpc: '2.0',
      id: 100,
      method: 'shutdown'
    });

    expect(response.result).toBeDefined();
    expect((response.result as { ok: boolean }).ok).toBe(true);
  });
});

describe('ACP manifest', () => {
  it('generates a valid manifest', () => {
    const manifest = generateAcpManifest({
      name: 'crowclaw',
      displayName: 'CrowClaw Agent',
      version: '0.1.0',
      description: 'TypeScript agent framework'
    });

    expect(manifest.schema_version).toBe(1);
    expect(manifest.name).toBe('crowclaw');
    expect(manifest.display_name).toBe('CrowClaw Agent');
    expect(manifest.version).toBe('0.1.0');
  });
});

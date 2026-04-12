import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

vi.mock('@crowclaw/mcp', () => ({
  McpHttpTransport: class McpHttpTransport {
    constructor(_options: unknown) {}
  },
  McpClient: class McpClient {
    async listTools() {
      return [{ name: 'search' }];
    }
    async callTool(name: string, args: Record<string, unknown>) {
      return { ok: true, content: { name, args } };
    }
  }
}));

describe('runtime-cloudflare plugin routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists plugins inside the durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-plugins-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/plugins', { method: 'GET' }));
    const payload = await response.json() as Array<{ name: string }>;
    expect(payload).toEqual([{ name: 'memory-capture' }]);
  });
});

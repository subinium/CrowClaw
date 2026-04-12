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
    async listResources() {
      return [{ uri: 'file://repo', name: 'Repo' }];
    }
    async listPrompts() {
      return [{ name: 'summarize-repo' }];
    }
    getStatus() {
      return { toolsRevision: 0, cachedTools: 0, supportsResources: true, supportsPrompts: true };
    }
    async refreshTools() {
      return [{ name: 'search' }];
    }
    async notifyToolsChanged() {
      return { ok: true, refreshed: [{ name: 'search' }] };
    }
    async callTool(name: string, args: Record<string, unknown>) {
      return { ok: true, content: { name, args } };
    }
  }
}));

describe('runtime-cloudflare MCP routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists and calls MCP tools inside the durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-mcp-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const list = await obj.fetch(new Request('https://internal/session/mcp/tools', { method: 'GET' }));
    expect(await list.json()).toEqual([{ name: 'search' }]);

    const resources = await obj.fetch(new Request('https://internal/session/mcp/resources', { method: 'GET' }));
    expect(await resources.json()).toEqual([{ uri: 'file://repo', name: 'Repo' }]);

    const prompts = await obj.fetch(new Request('https://internal/session/mcp/prompts', { method: 'GET' }));
    expect(await prompts.json()).toEqual([{ name: 'summarize-repo' }]);

    const status = await obj.fetch(new Request('https://internal/session/mcp/status', { method: 'GET' }));
    expect(await status.json()).toEqual({ toolsRevision: 0, cachedTools: 0, supportsResources: true, supportsPrompts: true });

    const reload = await obj.fetch(new Request('https://internal/session/mcp/reload', { method: 'POST' }));
    expect(await reload.json()).toEqual([{ name: 'search' }]);

    const changed = await obj.fetch(new Request('https://internal/session/mcp/list-changed', { method: 'POST' }));
    expect(await changed.json()).toEqual({ ok: true, refreshed: [{ name: 'search' }] });

    const call = await obj.fetch(new Request('https://internal/session/mcp/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'search', arguments: { query: 'crowclaw' } })
    }));
    expect(await call.json()).toEqual({ ok: true, content: { name: 'search', args: { query: 'crowclaw' } } });
  });
});

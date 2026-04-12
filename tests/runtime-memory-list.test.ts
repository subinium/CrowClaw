import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

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
      return [];
    }
    async callTool() {
      return { ok: true };
    }
  }
}));

describe('runtime memory list routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists session memory records through the node runtime', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Session note for listing', tags: ['list'] })
    }));

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/demo/memories'));
    const payload = await response.json() as { ok: boolean; sessionId: string; records: Array<{ summary: string }> };

    expect(payload.ok).toBe(true);
    expect(payload.sessionId).toBe('demo');
    expect(payload.records[0]?.summary).toContain('Session note for listing');
  });

  it('lists scope-keyed memory records through the node runtime', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Workspace A memory', scope: 'workspace', scopeKey: 'workspace-a' })
    }));

    await runtime.fetch(new Request('http://localhost/api/sessions/demo/remember', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: 'Workspace B memory', scope: 'workspace', scopeKey: 'workspace-b' })
    }));

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/demo/memories?scope=workspace&scopeKey=workspace-a'));
    const payload = await response.json() as { ok: boolean; scope: string; scopeKey?: string; records: Array<{ summary: string; scopeKey?: string }> };

    expect(payload.ok).toBe(true);
    expect(payload.scope).toBe('workspace');
    expect(payload.scopeKey).toBe('workspace-a');
    expect(payload.records).toHaveLength(1);
    expect(payload.records[0]?.summary).toContain('Workspace A memory');
    expect(payload.records[0]?.scopeKey).toBe('workspace-a');
  });

  it('forwards scoped memory list requests through the Cloudflare runtime', async () => {
    const runtimeCloudflare = (await import('@crowclaw/runtime-cloudflare')).default;
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      MCP_BASE_URL: 'https://mcp.example.com'
    };

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/memories?scope=workspace&scopeKey=workspace-a&limit=5', {
      method: 'GET'
    }), env as never);
    const payload = await response.json() as { forwardedTo: string };

    expect(payload.forwardedTo).toContain('/memories?scope=workspace&scopeKey=workspace-a&limit=5');
  });
});

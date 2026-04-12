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

describe('runtime-cloudflare scheduler routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates, lists, and ticks scheduler jobs inside the durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-scheduler-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const create = await obj.fetch(new Request('https://internal/session/scheduler/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'job-1', everyMinutes: 5, task: 'sync' })
    }));
    expect((await create.json() as { id: string }).id).toBe('job-1');

    const list = await obj.fetch(new Request('https://internal/session/scheduler/jobs', { method: 'GET' }));
    const jobs = await list.json() as Array<{ id: string }>;
    expect(jobs).toHaveLength(1);

    const tick = await obj.fetch(new Request('https://internal/session/scheduler/tick', { method: 'POST' }));
    const payload = await tick.json() as { ok: boolean; results: unknown[] };
    expect(payload.ok).toBe(true);
    expect(Array.isArray(payload.results)).toBe(true);
  });
});

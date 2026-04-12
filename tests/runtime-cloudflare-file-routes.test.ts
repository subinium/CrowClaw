import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

const getSandboxMock = vi.hoisted(() => vi.fn());

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: getSandboxMock
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

describe('runtime-cloudflare file routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards top-level file routes through the Cloudflare worker surface', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json() }));
    const stub = { fetch };
    const env = {
      AGENT_SESSIONS: {
        idFromName: (name: string) => ({ toString: () => name }),
        get: () => stub
      },
      Sandbox: {
        idFromName: () => ({ toString: () => 'sandbox' }),
        get: () => ({ fetch: vi.fn() })
      },
      DB: { prepare: vi.fn() },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() }
    };

    const read = await runtimeCloudflare.fetch(new Request('https://example.com/api/file/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }), env as never);
    expect((await read.json() as { forwardedTo: string }).forwardedTo).toContain('/file/read');

    const write = await runtimeCloudflare.fetch(new Request('https://example.com/api/file/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt', content: 'alpha' })
    }), env as never);
    expect((await write.json() as { forwardedTo: string }).forwardedTo).toContain('/file/write');

    const exists = await runtimeCloudflare.fetch(new Request('https://example.com/api/file/exists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }), env as never);
    expect((await exists.json() as { forwardedTo: string }).forwardedTo).toContain('/file/exists');

    const del = await runtimeCloudflare.fetch(new Request('https://example.com/api/file/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }), env as never);
    expect((await del.json() as { forwardedTo: string }).forwardedTo).toContain('/file/delete');
  });

  it('handles file routes directly inside the Cloudflare durable object', async () => {
    getSandboxMock.mockReturnValue({
      readFile: vi.fn(async (path: string) => ({
        success: path === '/workspace/app.txt',
        content: 'alpha',
        mimeType: 'text/plain'
      })),
      writeFile: vi.fn(async () => ({ success: true })),
      deleteFile: vi.fn(async () => ({ success: true })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-file-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const read = await obj.fetch(new Request('https://internal/session/file/read', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }));
    expect((await read.json() as { ok: boolean; output: string }).output).toBe('alpha');

    const write = await obj.fetch(new Request('https://internal/session/file/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt', content: 'beta' })
    }));
    expect((await write.json() as { ok: boolean; output: string }).output).toContain('Wrote /workspace/app.txt');

    const exists = await obj.fetch(new Request('https://internal/session/file/exists', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }));
    expect((await exists.json() as { ok: boolean; output: string }).output).toContain('"exists":true');

    const del = await obj.fetch(new Request('https://internal/session/file/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/workspace/app.txt' })
    }));
    expect((await del.json() as { ok: boolean; output: string }).output).toContain('Deleted /workspace/app.txt');
  });
});

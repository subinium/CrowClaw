import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

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

describe('runtime browser screenshot routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes screenshot requests through the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/api/browser/screenshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', path: '/workspace/page.png' })
    }));

    const payload = await response.json() as { ok: boolean; output: string; metadata: { simulated?: boolean; path: string } };
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Simulated screenshot');
    expect(payload.metadata).toMatchObject({ simulated: true, path: '/workspace/page.png' });
  });

  it('forwards top-level Cloudflare browser screenshot requests', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/screenshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', path: '/workspace/page.png', fullPage: true })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { url: string; path: string; fullPage: boolean } };
    expect(payload.forwardedTo).toContain('/browser/screenshot');
    expect(payload.body).toEqual({ url: 'https://example.com', path: '/workspace/page.png', fullPage: true });
  });

  it('executes screenshot requests directly inside the Cloudflare durable object', async () => {
    getSandboxMock.mockReturnValue({
      screenshot: vi.fn(async (_url: string, options?: { path?: string }) => ({
        success: true,
        path: options?.path ?? '/workspace/page.png'
      })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/browser/screenshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', path: '/workspace/page.png' })
    }));

    const payload = await response.json() as { ok: boolean; output: string; metadata: { path: string } };
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Captured screenshot');
    expect(payload.metadata).toMatchObject({ path: '/workspace/page.png' });
  });
});

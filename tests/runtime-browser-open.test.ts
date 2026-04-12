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

describe('runtime browser open routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes open requests through the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/open' })
    }));

    const payload = await response.json() as { toolName: string; ok: boolean; output: string; metadata: { simulated?: boolean; finalUrl: string } };
    expect(payload.toolName).toBe('browser.open');
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Simulated browser navigation');
    expect(payload.metadata).toMatchObject({ simulated: true, finalUrl: 'https://example.com/open' });
  });

  it('forwards top-level Cloudflare browser open requests', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/open' })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { url: string } };
    expect(payload.forwardedTo).toContain('/browser/open');
    expect(payload.body).toEqual({ url: 'https://example.com/open' });
  });

  it('executes open requests directly inside the Cloudflare durable object', async () => {
    getSandboxMock.mockReturnValue({
      goto: vi.fn(async (url: string) => ({
        success: true,
        finalUrl: `${url}/opened`,
        title: 'Opened Title'
      })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-open-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/open' })
    }));

    const payload = await response.json() as { toolName: string; ok: boolean; output: string; metadata: { finalUrl: string; title: string } };
    expect(payload.toolName).toBe('browser.open');
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Opened https://example.com/open/opened');
    expect(payload.metadata).toMatchObject({ finalUrl: 'https://example.com/open/opened', title: 'Opened Title' });
  });
});

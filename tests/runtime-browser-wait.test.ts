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

describe('runtime browser wait routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes wait requests through the node runtime', async () => {
    const runtime = createNodeRuntime();
    const response = await runtime.fetch(new Request('http://localhost/api/browser/wait-for', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', selector: '#ready', timeoutMs: 1200 })
    }));

    const payload = await response.json() as { toolName: string; ok: boolean; output: string; metadata: { simulated?: boolean; selector: string; timeoutMs: number; matched: boolean } };
    expect(payload.toolName).toBe('browser.waitFor');
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Simulated wait');
    expect(payload.metadata).toMatchObject({ simulated: true, selector: '#ready', timeoutMs: 1200, matched: true });
  });

  it('forwards top-level Cloudflare browser wait requests', async () => {
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/wait-for', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', selector: '#ready', timeoutMs: 1200 })
    }), env as never);

    const payload = await response.json() as { forwardedTo: string; body: { url: string; selector: string; timeoutMs: number } };
    expect(payload.forwardedTo).toContain('/browser/wait-for');
    expect(payload.body).toEqual({ url: 'https://example.com', selector: '#ready', timeoutMs: 1200 });
  });

  it('executes wait requests directly inside the Cloudflare durable object', async () => {
    getSandboxMock.mockReturnValue({
      waitFor: vi.fn(async (url: string, options?: { selector?: string; timeoutMs?: number }) => ({
        success: true,
        selector: options?.selector,
        timeoutMs: options?.timeoutMs,
        finalUrl: `${url}/ready`,
        matched: true
      })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-wait-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const response = await obj.fetch(new Request('https://internal/session/browser/wait-for', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', selector: '#ready', timeoutMs: 1200 })
    }));

    const payload = await response.json() as { toolName: string; ok: boolean; output: string; metadata: { selector: string; timeoutMs: number; finalUrl: string; matched: boolean } };
    expect(payload.toolName).toBe('browser.waitFor');
    expect(payload.ok).toBe(true);
    expect(payload.output).toContain('Waited for #ready');
    expect(payload.metadata).toMatchObject({ selector: '#ready', timeoutMs: 1200, finalUrl: 'https://example.com/ready', matched: true });
  });
});

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

describe('runtime browser advanced routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executes advanced browser requests through the node runtime', async () => {
    const runtime = createNodeRuntime();

    const back = await runtime.fetch(new Request('http://localhost/api/browser/back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: 2 })
    }));
    expect((await back.json() as { toolName: string }).toolName).toBe('browser.back');

    const scroll = await runtime.fetch(new Request('http://localhost/api/browser/scroll', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', direction: 'down', amount: 3 })
    }));
    expect((await scroll.json() as { output: string }).output).toContain('Simulated scroll down');

    const press = await runtime.fetch(new Request('http://localhost/api/browser/press', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', key: 'Enter' })
    }));
    expect((await press.json() as { output: string }).output).toContain('Simulated key press Enter');

    const consoleResult = await runtime.fetch(new Request('http://localhost/api/browser/console', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' })
    }));
    expect((await consoleResult.json() as { output: string }).output).toContain('Simulated console log');

    const vision = await runtime.fetch(new Request('http://localhost/api/browser/vision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', prompt: 'Summarize' })
    }));
    expect((await vision.json() as { output: string }).output).toContain('Simulated vision analysis');

    const images = await runtime.fetch(new Request('http://localhost/api/browser/images', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', limit: 1 })
    }));
    expect((await images.json() as { output: string }).output).toContain('@img1');

    const clickRef = await runtime.fetch(new Request('http://localhost/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', ref: '@e1' })
    }));
    expect((await clickRef.json() as { output: string }).output).toContain('Simulated click on ref @e1');
  });

  it('forwards advanced browser requests through the Cloudflare runtime', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: await request.json().catch(() => null) }));
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

    const back = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: 2 })
    }), env as never);
    expect((await back.json() as { forwardedTo: string }).forwardedTo).toContain('/browser/back');

    const clickRef = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', ref: '@e1' })
    }), env as never);
    expect((await clickRef.json() as { forwardedTo: string }).forwardedTo).toContain('/browser/click-ref');
  });

  it('executes advanced browser requests directly inside the Cloudflare durable object', async () => {
    getSandboxMock.mockReturnValue({
      back: vi.fn(async (options?: { steps?: number }) => ({ success: true, steps: options?.steps ?? 1, finalUrl: 'https://example.com/back' })),
      scroll: vi.fn(async (_url: string, options?: { direction?: string; amount?: number }) => ({ success: true, direction: options?.direction, amount: options?.amount, finalUrl: 'https://example.com/scrolled' })),
      press: vi.fn(async (_url: string, options?: { key?: string }) => ({ success: true, key: options?.key, finalUrl: 'https://example.com/pressed' })),
      consoleMessages: vi.fn(async () => ({ success: true, logs: [{ level: 'warn', message: 'warn log' }] })),
      vision: vi.fn(async (_url: string, options?: { prompt?: string }) => ({ success: true, analysis: `analysis:${options?.prompt}` })),
      images: vi.fn(async () => ({ success: true, images: [{ ref: '@img9', src: 'https://example.com/asset.png', alt: 'Asset' }] })),
      clickRef: vi.fn(async (_url: string, options?: { ref?: string }) => ({ success: true, ref: options?.ref, finalUrl: 'https://example.com/ref-clicked' })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-advanced-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const back = await obj.fetch(new Request('https://internal/session/browser/back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ steps: 2 })
    }));
    expect((await back.json() as { metadata: { finalUrl: string } }).metadata.finalUrl).toBe('https://example.com/back');

    const vision = await obj.fetch(new Request('https://internal/session/browser/vision', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', prompt: 'Summarize' })
    }));
    expect((await vision.json() as { output: string }).output).toBe('analysis:Summarize');

    const images = await obj.fetch(new Request('https://internal/session/browser/images', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', limit: 1 })
    }));
    expect((await images.json() as { output: string }).output).toContain('@img9');

    const clickRef = await obj.fetch(new Request('https://internal/session/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com', ref: '@e1' })
    }));
    expect((await clickRef.json() as { metadata: { finalUrl: string } }).metadata.finalUrl).toBe('https://example.com/ref-clicked');
  });
});

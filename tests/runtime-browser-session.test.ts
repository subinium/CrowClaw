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

describe('runtime browser session state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks browser session state across multi-step node runtime flows', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', url: 'https://example.com' })
    }));

    await runtime.fetch(new Request('http://localhost/api/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', full: true })
    }));

    const clickRef = await runtime.fetch(new Request('http://localhost/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1', ref: '@e1' })
    }));
    expect((await clickRef.json() as { ok: boolean }).ok).toBe(true);

    const session = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=browser-session-1'));
    const sessionPayload = await session.json() as { currentUrl: string; lastRefs: string[]; lastSnapshot: string };
    expect(sessionPayload.currentUrl).toBe('https://example.com');
    expect(sessionPayload.lastRefs).toContain('@e1');
    expect(sessionPayload.lastSnapshot).toContain('[@e1]');

    const reset = await runtime.fetch(new Request('http://localhost/api/browser/session/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-session-1' })
    }));
    expect(await reset.json()).toEqual({ ok: true, sessionId: 'browser-session-1', reset: true });
  });

  it('tracks browser session state inside the Cloudflare durable object and through top-level forwarding', async () => {
    getSandboxMock.mockReturnValue({
      snapshot: vi.fn(async (_url: string, options?: { full?: boolean }) => ({
        success: true,
        snapshot: options?.full ? '[@e1] button "Run"' : '[@e1] link "Home"',
        refs: ['@e1'],
        title: 'Snapshot Title',
        full: options?.full ?? false
      })),
      clickRef: vi.fn(async (_url: string, options?: { ref?: string }) => ({
        success: true,
        ref: options?.ref,
        finalUrl: 'https://example.com/ref-clicked'
      })),
      exec: vi.fn(async () => ({ success: true, stdout: '', stderr: '', exitCode: 0 }))
    });

    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-session-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    await obj.fetch(new Request('https://internal/session/browser/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-session', url: 'https://example.com' })
    }));
    await obj.fetch(new Request('https://internal/session/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-session', full: true })
    }));
    await obj.fetch(new Request('https://internal/session/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'cf-session', ref: '@e1' })
    }));

    const session = await obj.fetch(new Request('https://internal/session/browser/session?sessionId=cf-session'));
    const sessionPayload = await session.json() as { currentUrl: string; lastRefs: string[]; lastSnapshot: string };
    expect(sessionPayload.currentUrl).toBe('https://example.com');
    expect(sessionPayload.lastRefs).toContain('@e1');
    expect(sessionPayload.lastSnapshot).toContain('[@e1]');

    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: request.method === 'POST' ? await request.json() : null }));
    const stub = { fetch };
    const workerEnv = {
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

    const forwarded = await runtimeCloudflare.fetch(new Request('https://example.com/api/browser/session?sessionId=cf-session'), workerEnv as never);
    expect((await forwarded.json() as { forwardedTo: string }).forwardedTo).toContain('/browser/session?sessionId=cf-session');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('stateful browser session flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tracks browser session history and current url in the node runtime', async () => {
    const runtime = createNodeRuntime();

    await runtime.fetch(new Request('http://localhost/api/browser/goto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-1', url: 'https://example.com/a' })
    }));

    await runtime.fetch(new Request('http://localhost/api/browser/navigate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-1', url: 'https://example.com/b' })
    }));

    const back = await runtime.fetch(new Request('http://localhost/api/browser/back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-1', steps: 1 })
    }));
    expect((await back.json() as { metadata: { finalUrl: string } }).metadata.finalUrl).toBe('https://example.com/a');

    const snapshot = await runtime.fetch(new Request('http://localhost/api/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-1', full: false })
    }));
    const snapshotPayload = await snapshot.json() as { output: string };
    expect(snapshotPayload.output).toContain('https://example.com/a');

    const clickRef = await runtime.fetch(new Request('http://localhost/api/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-1', ref: '@e1' })
    }));
    expect((await clickRef.json() as { ok: boolean }).ok).toBe(true);

    const state = await runtime.fetch(new Request('http://localhost/api/browser/session?sessionId=browser-1'));
    const statePayload = await state.json() as { currentUrl: string; history: string[]; lastRefs: string[] };
    expect(statePayload.currentUrl).toBe('https://example.com/a');
    expect(statePayload.history).toEqual(['https://example.com/a']);
    expect(statePayload.lastRefs).toContain('@e1');
  });

  it('tracks browser session history and ref state inside the Cloudflare durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-browser-state-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    await obj.fetch(new Request('https://internal/session/browser/goto', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-cf-1', url: 'https://example.com/a' })
    }));

    await obj.fetch(new Request('https://internal/session/browser/navigate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-cf-1', url: 'https://example.com/b' })
    }));

    const back = await obj.fetch(new Request('https://internal/session/browser/back', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-cf-1', steps: 1 })
    }));
    expect((await back.json() as { metadata: { finalUrl: string } }).metadata.finalUrl).toBe('https://example.com/a');

    const snapshot = await obj.fetch(new Request('https://internal/session/browser/snapshot', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-cf-1', full: false })
    }));
    expect((await snapshot.json() as { output: string }).output).toContain('https://example.com/a');

    const clickRef = await obj.fetch(new Request('https://internal/session/browser/click-ref', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'browser-cf-1', ref: '@e1' })
    }));
    expect((await clickRef.json() as { ok: boolean }).ok).toBe(true);

    const session = await obj.fetch(new Request('https://internal/session/browser/session?sessionId=browser-cf-1'));
    const sessionPayload = await session.json() as { currentUrl: string; history: string[]; lastRefs: string[] };
    expect(sessionPayload.currentUrl).toBe('https://example.com/a');
    expect(sessionPayload.history).toEqual(['https://example.com/a']);
    expect(sessionPayload.lastRefs).toContain('@e1');
  });
});

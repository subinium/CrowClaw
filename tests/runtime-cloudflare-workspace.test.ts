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
      return [];
    }
    async callTool() {
      return { ok: true };
    }
  }
}));

describe('runtime-cloudflare workspace routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('supports workspace write/exists/delete/rename inside the durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-workspace-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn(), all: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const write = await obj.fetch(new Request('https://internal/session/workspace/write', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', content: 'alpha' })
    }));
    expect((await write.json() as { path: string }).path).toBe('src/app.ts');

    const patchText = await obj.fetch(new Request('https://internal/session/workspace/patch-text', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/app.ts', replacements: [{ from: 'alpha', to: 'ALPHA' }] })
    }));
    expect((await patchText.json() as { content: string }).content).toBe('ALPHA');

    const pathRead = await obj.fetch(new Request('https://internal/session/workspace/src/app.ts'));
    expect((await pathRead.json() as { content: string }).content).toBe('ALPHA');

    const exists = await obj.fetch(new Request('https://internal/session/workspace/exists?path=src/app.ts'));
    expect((await exists.json() as { exists: boolean }).exists).toBe(true);

    const rename = await obj.fetch(new Request('https://internal/session/workspace/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fromPath: 'src/app.ts', toPath: 'src/main.ts' })
    }));
    expect((await rename.json() as { path: string }).path).toBe('src/main.ts');

    const oldExists = await obj.fetch(new Request('https://internal/session/workspace/exists?path=src/app.ts'));
    const newExists = await obj.fetch(new Request('https://internal/session/workspace/exists?path=src/main.ts'));
    expect((await oldExists.json() as { exists: boolean }).exists).toBe(false);
    expect((await newExists.json() as { exists: boolean }).exists).toBe(true);

    const remove = await obj.fetch(new Request('https://internal/session/workspace/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'src/main.ts' })
    }));
    expect((await remove.json() as { removed: boolean }).removed).toBe(true);

    const existsAfterDelete = await obj.fetch(new Request('https://internal/session/workspace/exists?path=src/main.ts'));
    expect((await existsAfterDelete.json() as { exists: boolean }).exists).toBe(false);
  });
});

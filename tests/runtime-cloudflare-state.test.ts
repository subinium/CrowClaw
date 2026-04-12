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

describe('runtime-cloudflare session state routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards session state requests through the worker surface', async () => {
    const runtimeCloudflare = (await import('@crowclaw/runtime-cloudflare')).default;
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, method: request.method }));
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

    const response = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions/demo/state'), env as never);
    const payload = await response.json() as { forwardedTo: string; method: string };

    expect(payload.forwardedTo).toContain('/state');
    expect(payload.method).toBe('GET');
  });

  it('serves state directly from the durable object after a message run', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-state-1' } };
    const sessions = new Map<string, { payload: string }>();
    const db = {
      prepare: (query: string) => ({
        bind: (...values: unknown[]) => ({
          first: async () => {
            if (query.includes('SELECT payload FROM sessions WHERE id = ?1')) {
              const sessionId = String(values[0]);
              return sessions.get(sessionId) ?? null;
            }
            return null;
          },
          all: async () => ({ results: [] }),
          run: async () => {
            if (query.includes('INSERT INTO sessions (id, payload, updated_at)')) {
              const [sessionId, payload] = values;
              sessions.set(String(sessionId), { payload: String(payload) });
            }
            return { success: true };
          }
        })
      })
    };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: db,
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() },
      OPENAI_API_KEY: undefined,
      MCP_BASE_URL: 'https://mcp.example.com'
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    await obj.fetch(new Request('https://internal/session/message', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'state check message' })
    }));

    const response = await obj.fetch(new Request('https://internal/session/state'));
    const payload = await response.json() as { ok: boolean; session: { sessionId: string; messages: Array<{ content: string }> } };

    expect(payload.ok).toBe(true);
    expect(payload.session.sessionId).toBe('cf-state-1');
    expect(payload.session.messages.some((message) => message.content.includes('state check message'))).toBe(true);
  });
});

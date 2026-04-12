import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare learning routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('captures, lists, and publishes drafts inside the durable object', async () => {
    const { AgentSessionDurableObject } = await import('@crowclaw/runtime-cloudflare');
    const state = { id: { toString: () => 'cf-learning-1' } };
    const env = {
      Sandbox: { idFromName: () => ({ toString: () => 'sandbox' }), get: () => ({ fetch: vi.fn() }) },
      DB: { prepare: vi.fn(() => ({ bind: () => ({ first: vi.fn(), run: vi.fn() }) })) },
      ARTIFACTS: { put: vi.fn(), get: vi.fn() },
      AGENT_SESSIONS: { idFromName: vi.fn(), get: vi.fn() }
    };
    const obj = new AgentSessionDurableObject(state as never, env as never);

    const create = await obj.fetch(new Request('https://internal/session/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Cloudflare Draft',
        messages: [
          { role: 'user', content: 'draft this skill' },
          { role: 'assistant', content: 'done' }
        ]
      })
    }));
    const created = await create.json() as { id: string; status: string };
    expect(created.status).toBe('draft');

    const list = await obj.fetch(new Request('https://internal/session/learning/drafts', { method: 'GET' }));
    const drafts = await list.json() as Array<{ id: string }>;
    expect(drafts).toHaveLength(1);

    const publish = await obj.fetch(new Request(`https://internal/session/learning/drafts/${created.id}`, {
      method: 'POST'
    }));
    const published = await publish.json() as { status: string };
    expect(published.status).toBe('published');
  });
});

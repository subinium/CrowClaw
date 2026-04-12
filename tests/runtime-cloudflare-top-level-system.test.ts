import { beforeEach, describe, expect, it, vi } from 'vitest';
import runtimeCloudflare from '@crowclaw/runtime-cloudflare';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class Sandbox {},
  proxyToSandbox: vi.fn(async () => null),
  getSandbox: vi.fn(() => ({ exec: vi.fn() }))
}));

describe('runtime-cloudflare top-level system routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards top-level system, catalog, session, plugin, and MCP routes', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: request.method === 'POST' ? await request.json().catch(() => null) : null }));
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

    const systemStatus = await runtimeCloudflare.fetch(new Request('https://example.com/api/system/status'), env as never);
    expect((await systemStatus.json() as { forwardedTo: string }).forwardedTo).toContain('/system/status');

    const skills = await runtimeCloudflare.fetch(new Request('https://example.com/api/skills'), env as never);
    expect((await skills.json() as { forwardedTo: string }).forwardedTo).toContain('/skills');

    const presets = await runtimeCloudflare.fetch(new Request('https://example.com/api/presets'), env as never);
    expect((await presets.json() as { forwardedTo: string }).forwardedTo).toContain('/presets');

    const sessionList = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions'), env as never);
    expect((await sessionList.json() as { forwardedTo: string }).forwardedTo).toContain('/sessions');

    const sessionCreate = await runtimeCloudflare.fetch(new Request('https://example.com/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: 'dashboard-demo' })
    }), env as never);
    expect((await sessionCreate.json() as { forwardedTo: string }).forwardedTo).toContain('/create');

    const plugins = await runtimeCloudflare.fetch(new Request('https://example.com/api/plugins'), env as never);
    expect((await plugins.json() as { forwardedTo: string }).forwardedTo).toContain('/plugins');

    const tools = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/tools'), env as never);
    expect((await tools.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/tools');

    const resources = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/resources'), env as never);
    expect((await resources.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/resources');

    const prompts = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/prompts'), env as never);
    expect((await prompts.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/prompts');

    const status = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/status'), env as never);
    expect((await status.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/status');

    const reload = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/reload', {
      method: 'POST'
    }), env as never);
    expect((await reload.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/reload');

    const changed = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/list-changed', {
      method: 'POST'
    }), env as never);
    expect((await changed.json() as { forwardedTo: string }).forwardedTo).toContain('/mcp/list-changed');

    const gatewayInspect = await runtimeCloudflare.fetch(new Request('https://example.com/api/gateway/inspect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'webhook', payload: { chatId: 'room-1', userId: 'user-1', text: 'hello' } })
    }), env as never);
    expect((await gatewayInspect.json() as { forwardedTo: string }).forwardedTo).toContain('/gateway/inspect');

    const gatewayStatus = await runtimeCloudflare.fetch(new Request('https://example.com/api/gateway/status'), env as never);
    expect((await gatewayStatus.json() as { forwardedTo: string }).forwardedTo).toContain('/gateway/status');

    const call = await runtimeCloudflare.fetch(new Request('https://example.com/api/mcp/call', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'search', arguments: { q: 'crowclaw' } })
    }), env as never);
    const callPayload = await call.json() as { forwardedTo: string; body: { name: string } };
    expect(callPayload.forwardedTo).toContain('/mcp/call');
    expect(callPayload.body.name).toBe('search');
  });

  it('forwards top-level learning and scheduler routes', async () => {
    const fetch = vi.fn(async (request: Request) => Response.json({ forwardedTo: request.url, body: request.method === 'POST' ? await request.json().catch(() => null) : null }));
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

    const drafts = await runtimeCloudflare.fetch(new Request('https://example.com/api/learning/drafts'), env as never);
    expect((await drafts.json() as { forwardedTo: string }).forwardedTo).toContain('/learning/drafts');

    const createDraft = await runtimeCloudflare.fetch(new Request('https://example.com/api/learning/drafts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Draft', messages: [] })
    }), env as never);
    expect((await createDraft.json() as { forwardedTo: string }).forwardedTo).toContain('/learning/drafts');

    const publishDraft = await runtimeCloudflare.fetch(new Request('https://example.com/api/learning/drafts/draft-1', {
      method: 'POST'
    }), env as never);
    expect((await publishDraft.json() as { forwardedTo: string }).forwardedTo).toContain('/learning/drafts/draft-1');

    const jobs = await runtimeCloudflare.fetch(new Request('https://example.com/api/scheduler/jobs'), env as never);
    expect((await jobs.json() as { forwardedTo: string }).forwardedTo).toContain('/scheduler/jobs');

    const createJob = await runtimeCloudflare.fetch(new Request('https://example.com/api/scheduler/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'job-1', everyMinutes: 5, task: 'sync' })
    }), env as never);
    expect((await createJob.json() as { forwardedTo: string }).forwardedTo).toContain('/scheduler/jobs');

    const tick = await runtimeCloudflare.fetch(new Request('https://example.com/api/scheduler/tick', {
      method: 'POST'
    }), env as never);
    expect((await tick.json() as { forwardedTo: string }).forwardedTo).toContain('/scheduler/tick');
  });
});

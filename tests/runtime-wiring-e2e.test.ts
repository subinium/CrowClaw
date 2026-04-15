import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AgentLoop, type ParsedSkillFile, type ProviderRequest, type ProviderResponse } from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

// Gateway config/pairings routes require auth
const TEST_TOKEN = 'test-wiring-token';
beforeAll(() => { process.env.CROWCLAW_DASHBOARD_TOKEN = TEST_TOKEN; });
afterAll(() => { delete process.env.CROWCLAW_DASHBOARD_TOKEN; });
const authHeaders = { authorization: `Bearer ${TEST_TOKEN}` };

class InspectingProvider {
  readonly requests: ProviderRequest[] = [];

  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    this.requests.push(request);
    return {
      assistantMessage: `handled:${request.messages.at(-1)?.content ?? ''}`
    };
  }
}

function telegramWebhook(updateId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 1_700_000_000,
      text: 'hello from telegram',
      from: { id: 42 },
      chat: { id: 99, type: 'private' }
    }
  };
}

describe('runtime wiring e2e', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('AgentLoop injects matched skill manifests into the provider prompt', async () => {
    const provider = new InspectingProvider();
    const skills: ParsedSkillFile[] = [{
      manifest: {
        name: 'write-tests',
        description: 'Write focused regression tests.',
        triggers: ['write tests'],
        tools: ['echo']
      },
      instructions: '1. Add a failing test\n2. Make it pass',
      raw: 'test skill'
    }];

    const loop = new AgentLoop(
      provider,
      new ToolRegistry().register(createEchoTool()),
      new InMemorySessionStore(),
      { runtimeName: 'test', skills }
    );

    await loop.run({
      agentId: 'crowclaw',
      sessionId: 'skill-injection',
      userMessage: 'please write tests for the login flow'
    });

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.systemPrompt).toContain('<skill name="write-tests"');
    expect(provider.requests[0]?.systemPrompt).toContain('Add a failing test');
  });

  it('runtime-node enforces pairing policy before agent execution and approves via gateway approvePairing', async () => {
    const provider = new InspectingProvider();
    const runtime = createNodeRuntime({ provider, telegramWebhookSecret: 'tg-wiring-secret', configStorePath: null });

    const firstPolicyResponse = await runtime.fetch(new Request('http://localhost/api/gateway/telegram/policy', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ dmPolicy: 'pairing', allowlist: [] })
    }));
    expect(firstPolicyResponse.ok).toBe(true);

    const firstAttempt = await runtime.fetch(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-wiring-secret' },
      body: JSON.stringify(telegramWebhook(1))
    }));
    expect(firstAttempt.status).toBe(403);

    const firstPayload = await firstAttempt.json() as { ok: boolean; reason: string; pairingCode: string };
    expect(firstPayload.ok).toBe(false);
    expect(firstPayload.reason).toBe('pairing-required');
    expect(firstPayload.pairingCode).toHaveLength(8);
    expect(provider.requests).toHaveLength(0);

    const pairingsResponse = await runtime.fetch(new Request('http://localhost/api/gateway/pairings', { headers: authHeaders }));
    const pairingsPayload = await pairingsResponse.json() as { pairings: Array<{ code: string; senderId: string; platform: string }> };
    expect(pairingsPayload.pairings).toContainEqual(expect.objectContaining({
      code: firstPayload.pairingCode,
      senderId: '42',
      platform: 'telegram'
    }));

    const approveResponse = await runtime.fetch(new Request('http://localhost/api/gateway/pairing/approve', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ code: firstPayload.pairingCode })
    }));
    const approvePayload = await approveResponse.json() as { ok: boolean; approved: boolean; senderId: string; platform: string };
    expect(approvePayload).toMatchObject({
      ok: true,
      approved: true,
      senderId: '42',
      platform: 'telegram'
    });

    const secondAttempt = await runtime.fetch(new Request('http://localhost/webhooks/telegram', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': 'tg-wiring-secret' },
      body: JSON.stringify(telegramWebhook(2))
    }));
    expect(secondAttempt.ok).toBe(true);

    const secondPayload = await secondAttempt.json() as { session: { sessionId: string }; finalResponse: string };
    expect(secondPayload.session.sessionId).toBe('telegram:99');
    expect(secondPayload.finalResponse).toContain('handled:hello from telegram');
    expect(provider.requests).toHaveLength(1);
  });

  it('RuntimeConfigStore state reconfigures agent preset, toolset, and enabled skills for each run', async () => {
    const provider = new InspectingProvider();
    const runtime = createNodeRuntime({ provider, configStorePath: null });

    await runtime.fetch(new Request('http://localhost/api/agent/preset', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({
        name: 'custom-reviewer',
        role: 'Senior reviewer',
        goal: 'Ship verified changes'
      })
    }));

    await runtime.fetch(new Request('http://localhost/api/toolset/select', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ name: 'minimal' })
    }));

    const firstRun = await runtime.fetch(new Request('http://localhost/api/sessions/configured-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ userMessage: 'write tests for auth edge cases' })
    }));
    expect(firstRun.ok).toBe(true);

    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]?.systemPrompt).toContain('Senior reviewer');
    expect(provider.requests[0]?.systemPrompt).toContain('<skill name="write-tests"');
    expect(provider.requests[0]?.availableTools.map((tool) => tool.name)).toEqual(['echo', 'time', 'tool.list']);

    await runtime.fetch(new Request('http://localhost/api/skills/write-tests/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ enabled: false })
    }));

    const secondRun = await runtime.fetch(new Request('http://localhost/api/sessions/configured-2', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ userMessage: 'write tests for auth edge cases' })
    }));
    expect(secondRun.ok).toBe(true);

    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]?.systemPrompt).toContain('Senior reviewer');
    expect(provider.requests[1]?.systemPrompt).not.toContain('<skill name="write-tests"');
    expect(provider.requests[1]?.availableTools.map((tool) => tool.name)).toEqual(['echo', 'time', 'tool.list']);
  });

  it('/api/web/fetch reuses the web.fetch guard instead of bypassing SSRF checks', async () => {
    const fetchMock = vi.fn(async () => new Response('unexpected'));
    vi.stubGlobal('fetch', fetchMock);

    const runtime = createNodeRuntime({ configStorePath: null });
    const response = await runtime.fetch(new Request('http://localhost/api/web/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders },
      body: JSON.stringify({ url: 'http://localhost/internal' })
    }));

    expect(response.status).toBe(400);
    const payload = await response.json() as { ok: boolean; output: string };
    expect(payload.ok).toBe(false);
    expect(payload.output).toContain('URL blocked');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

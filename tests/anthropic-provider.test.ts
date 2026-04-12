import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '@crowclaw/providers';
import type { ProviderRequest } from '@crowclaw/core';

const baseRequest: ProviderRequest = {
  systemPrompt: 'You are CrowClaw',
  messages: [{ role: 'user', content: 'run the terminal tool', createdAt: new Date().toISOString() }],
  availableTools: [
    {
      name: 'terminal.exec',
      description: 'Runs shell commands.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    }
  ]
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnthropicProvider', () => {
  it('serializes requests and normalizes text responses', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.model).toBe('claude-test');
      expect(parsed.system).toBe('You are CrowClaw');
      expect(parsed.messages[0]).toMatchObject({ role: 'user', content: 'run the terminal tool' });
      return new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Anthropic says hello' }]
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('Anthropic says hello');
  });

  it('supports slash-style tool scheduling from anthropic text output', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      content: [{ type: 'text', text: '/tool terminal.exec pwd' }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-test',
      promptCaching: true
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toContain('Scheduling tool terminal.exec');
    expect(result.toolCalls).toEqual([{ name: 'terminal.exec', input: { command: 'pwd' } }]);
  });
});

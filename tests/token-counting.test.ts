import { afterEach, describe, it, expect, vi } from 'vitest';
import { OpenAICompatibleProvider, AnthropicProvider } from '@crowclaw/providers';
import type { ConversationMessage, ProviderRequest } from '@crowclaw/core';

const now = new Date().toISOString();

const baseRequest: ProviderRequest = {
  systemPrompt: 'You are CrowClaw',
  messages: [{ role: 'user', content: 'Hello', createdAt: now }],
  availableTools: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAICompatibleProvider.countTokens', () => {
  const provider = new OpenAICompatibleProvider({
    apiKey: 'test',
    baseUrl: 'https://api.example.com/v1',
    model: 'gpt-4o',
  });

  it('estimates tokens for simple text messages with model encoding overhead', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Hello world', createdAt: now },
    ];
    expect(provider.countTokens(messages)).toBe(8);
  });

  it('estimates tokens for multiple messages', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Hello world', createdAt: now },
      { role: 'assistant', content: 'Hi there! How can I help you today?', createdAt: now },
    ];
    expect(provider.countTokens(messages)).toBe(26);
  });

  it('counts tool result content', () => {
    const messages: ConversationMessage[] = [
      { role: 'tool', content: 'Result of running command', createdAt: now, name: 'terminal.exec' },
    ];
    expect(provider.countTokens(messages)).toBe(15);
  });

  it('returns 0 for empty messages', () => {
    expect(provider.countTokens([])).toBe(0);
  });

  it('handles messages with metadata', () => {
    const messages: ConversationMessage[] = [
      {
        role: 'assistant',
        content: 'test',
        createdAt: now,
        metadata: { toolCount: 2, iteration: 1 },
      },
    ];
    // content: 4 chars + metadata values serialized
    const count = provider.countTokens(messages);
    expect(count).toBeGreaterThan(0);
  });

  it('uses different encoding families for older OpenAI-compatible models', () => {
    const older = new OpenAICompatibleProvider({
      apiKey: 'test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-3.5-turbo',
    });
    const newer = new OpenAICompatibleProvider({
      apiKey: 'test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-5.5',
    });
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'antidisestablishmentarianism', createdAt: now },
    ];
    expect(older.countTokens(messages)).toBeGreaterThan(newer.countTokens(messages));
  });
});

describe('AnthropicProvider.countTokens', () => {
  const provider = new AnthropicProvider({
    apiKey: 'test',
    baseUrl: 'https://api.anthropic.example/v1',
    model: 'claude-sonnet-4',
  });

  it('estimates tokens for simple text messages (~3.5 chars per token)', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'Hello world', createdAt: now },
    ];
    // "Hello world" = 11 chars -> ceil(11/3.5) = 4 tokens (3.14 -> 4)
    expect(provider.countTokens(messages)).toBe(4);
  });

  it('keeps Anthropic and OpenAI token estimates provider-specific', () => {
    const openai = new OpenAICompatibleProvider({
      apiKey: 'test',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'A moderately long message to compare token estimation across providers.', createdAt: now },
    ];

    expect(provider.countTokens(messages)).toBeGreaterThan(0);
    expect(openai.countTokens(messages)).toBeGreaterThan(0);
    expect(provider.countTokens(messages)).not.toBe(openai.countTokens(messages));
  });

  it('returns 0 for empty messages', () => {
    expect(provider.countTokens([])).toBe(0);
  });
});

describe('OpenAI generate() returns usage', () => {
  it('extracts usage from API response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello!' } }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });

    const result = await provider.generate(baseRequest);
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it('returns undefined usage when API omits it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello!' } }],
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });

    const result = await provider.generate(baseRequest);
    expect(result.usage).toBeUndefined();
  });

  it('includes usage even when slash tool call is resolved', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: '/tool terminal.exec pwd' } }],
        usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-4o',
    });

    const result = await provider.generate({
      ...baseRequest,
      availableTools: [{
        name: 'terminal.exec',
        description: 'Runs shell commands.',
        runtime: 'sandbox',
        streaming: true,
        stateful: true,
        requiresWorkspace: true,
        requiresNetwork: false,
        dangerLevel: 'high',
      }],
    });
    expect(result.toolCalls).toBeDefined();
    expect(result.usage).toEqual({
      inputTokens: 20,
      outputTokens: 8,
      totalTokens: 28,
    });
  });
});

describe('Anthropic generate() returns usage', () => {
  it('extracts usage from API response', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Hello from Claude!' }],
        usage: {
          input_tokens: 15,
          output_tokens: 8,
        },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-sonnet-4',
    });

    const result = await provider.generate(baseRequest);
    expect(result.usage).toEqual({
      inputTokens: 15,
      outputTokens: 8,
      totalTokens: 23,
    });
  });

  it('includes cached tokens from prompt caching', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'Cached response' }],
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 50,
          cache_creation_input_tokens: 10,
        },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-sonnet-4',
      promptCaching: true,
    });

    const result = await provider.generate(baseRequest);
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedTokens: 60,
    });
  });

  it('returns undefined usage when API omits it', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        content: [{ type: 'text', text: 'No usage info' }],
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-sonnet-4',
    });

    const result = await provider.generate(baseRequest);
    expect(result.usage).toBeUndefined();
  });

  it('includes usage alongside native tool calls', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({
        content: [
          { type: 'text', text: 'Running command' },
          { type: 'tool_use', name: 'terminal.exec', id: 'tc_1', input: { command: 'ls' } },
        ],
        usage: { input_tokens: 50, output_tokens: 30 },
      }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'anthropic-key',
      baseUrl: 'https://api.anthropic.example/v1',
      model: 'claude-sonnet-4',
    });

    const result = await provider.generate({
      ...baseRequest,
      availableTools: [{
        name: 'terminal.exec',
        description: 'Runs shell commands.',
        runtime: 'sandbox',
        streaming: true,
        stateful: true,
        requiresWorkspace: true,
        requiresNetwork: false,
        dangerLevel: 'high',
      }],
    });

    expect(result.toolCalls).toHaveLength(1);
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 30,
      totalTokens: 80,
    });
  });
});

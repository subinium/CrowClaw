import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '@crowclaw/providers';
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

describe('OpenAICompatibleProvider', () => {
  it('serializes tools and parses tool calls from chat completions', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.tools).toHaveLength(1);
      expect(parsed.tool_choice).toBe('auto');

      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'Calling a tool',
              tool_calls: [
                {
                  function: {
                    name: 'terminal.exec',
                    arguments: '{"command":"pwd"}'
                  }
                }
              ]
            }
          }
        ]
      }), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('Calling a tool');
    expect(result.toolCalls).toEqual([{ name: 'terminal.exec', input: { command: 'pwd' } }]);
  });

  it('normalizes structured content arrays from chat completions', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.messages[0]).toMatchObject({ role: 'system' });

      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: [
                { type: 'output_text', text: 'First line' },
                { type: 'text', text: 'Second line' }
              ]
            }
          }
        ]
      }), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('First line\nSecond line');
  });

  it('converts tool messages to user messages for provider compatibility', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body));
      expect(parsed.messages.at(-1)).toMatchObject({
        role: 'user',
        content: '[Tool result: web.fetch]\ntool output'
      });

      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Observed tool output' } }]
      }), { status: 200 });
    });

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate({
      ...baseRequest,
      messages: [
        ...baseRequest.messages,
        { role: 'tool', name: 'web.fetch', content: 'tool output', createdAt: new Date().toISOString() }
      ]
    });
    expect(result.assistantMessage).toBe('Observed tool output');
  });

  it('falls back to slash-style tool scheduling when provider content contains a tool shortcut', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: '/tool terminal.exec pwd'
          }
        }
      ]
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toContain('Scheduling tool terminal.exec');
    expect(result.toolCalls).toEqual([{ name: 'terminal.exec', input: { command: 'pwd' } }]);
  });

  it('parses legacy function_call payloads when tool_calls are absent', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            function_call: {
              name: 'terminal.exec',
              arguments: '{"command":"ls"}'
            }
          }
        }
      ]
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.toolCalls).toEqual([{ name: 'terminal.exec', input: { command: 'ls' } }]);
  });

  it('normalizes nested text values and refusal fallback fields', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            refusal: 'Cannot comply.',
            content: [
              { type: 'text', text: { value: 'Primary text' } },
              { type: 'refusal', refusal: 'Secondary refusal' }
            ]
          }
        }
      ]
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toContain('Primary text');
    expect(result.assistantMessage).toContain('Secondary refusal');
  });

  it('uses top-level refusal when content is null', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            content: null,
            refusal: 'Refused for safety reasons.'
          }
        }
      ]
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('Refused for safety reasons.');
  });

  it('passes AbortSignal through to fetch', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'ok' } }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const controller = new AbortController();
    await provider.generate({ ...baseRequest, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.example.com/v1/chat/completions',
      expect.objectContaining({ signal: controller.signal })
    );
  });

  it('falls back to raw arguments when legacy function_call arguments are not JSON', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [
        {
          message: {
            function_call: {
              name: 'terminal.exec',
              arguments: 'pwd'
            }
          }
        }
      ]
    }), { status: 200 }));

    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    const result = await provider.generate(baseRequest);
    expect(result.toolCalls).toEqual([{ name: 'terminal.exec', input: { raw: 'pwd' } }]);
  });

  it('throws a useful error on non-ok provider responses', async () => {
    const fetchMock = vi.fn(async () => new Response('upstream error', { status: 503, statusText: 'Service Unavailable' }));
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.example.com/v1',
      model: 'gpt-test'
    });

    await expect(provider.generate(baseRequest)).rejects.toThrow('Provider request failed: 503 Service Unavailable');
  });
});

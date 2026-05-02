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

  it('sets token fields per OpenAI endpoint family', async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const responsesProvider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'o4-mini',
      reasoningEffort: 'high',
      temperature: 0.2,
    });

    await responsesProvider.generate({ ...baseRequest, availableTools: [], maxTokens: 2048 });
    expect(bodies[0]).toMatchObject({
      max_output_tokens: 2048,
      reasoning_effort: 'high',
    });
    expect(bodies[0]).not.toHaveProperty('temperature');

    const chatProvider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      temperature: 0,
    });
    vi.mocked(fetchMock).mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 }));

    await chatProvider.generate({ ...baseRequest, availableTools: [], maxTokens: 1024 });
    const chatBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(chatBody).toMatchObject({
      max_tokens: 1024,
      temperature: 0,
    });
  });

  it('uses Responses API text.format for native structured outputs on o-series', async () => {
    let calledUrl = '';
    let body: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      calledUrl = url;
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        output: [{ type: 'message', content: [{ type: 'output_text', text: '{"answer":"ok"}' }] }],
      }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      endpointPath: '/responses',
      model: 'o4-mini',
    });

    const result = await provider.generateStructured<{ answer: string }>({
      messages: [{ role: 'user', content: 'answer', createdAt: new Date().toISOString() }],
      schema: { type: 'object', required: ['answer'], properties: { answer: { type: 'string' } } },
    });

    expect(calledUrl).toBe('https://api.openai.com/v1/responses');
    expect((body.text as { format?: { type?: string } }).format?.type).toBe('json_schema');
    expect(body).not.toHaveProperty('response_format');
    expect(result).toMatchObject({ ok: true, value: { answer: 'ok' } });
  });

  it('does not use native non-streaming structured calls when streaming is required', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      return new Response('data: {"type":"response.output_text.delta","delta":"{\\"answer\\":\\"ok\\"}"}\n\ndata: {"type":"response.completed"}\n\n', {
        status: 200,
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'test-key',
      baseUrl: 'https://api.openai.com/v1',
      endpointPath: '/responses',
      model: 'o4-mini',
      requireStream: true,
    });

    await provider.generateStructured({
      messages: [{ role: 'user', content: 'answer', createdAt: new Date().toISOString() }],
      schema: { type: 'object', properties: { answer: { type: 'string' } } },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

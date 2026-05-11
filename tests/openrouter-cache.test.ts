/**
 * v0.9.0 (#330) — OpenRouter response caching.
 *
 * Verifies the OpenAICompatibleProvider:
 *   1. attaches `cache_control: { type: 'ephemeral' }` on requests to
 *      `openrouter.ai/api/v1` (and only those — non-OpenRouter endpoints
 *      remain untouched);
 *   2. opts streaming requests into `stream_options.include_usage` so the
 *      final SSE chunk surfaces cache stats;
 *   3. forwards cache-hit / -miss counts to the `onCacheTelemetry` audit hook
 *      using the documented `prompt_tokens_details.cached_tokens` /
 *      `cache_write_tokens` fields from OpenRouter's `ResponseUsage` schema;
 *   4. honours the `openRouterResponseCache: false` opt-out flag.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleProvider } from '@crowclaw/providers';
import type { ProviderRequest } from '@crowclaw/core';
import type { ProviderCacheTelemetry } from '@crowclaw/providers';

const baseRequest: ProviderRequest = {
  systemPrompt: 'You are CrowClaw',
  messages: [{ role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  availableTools: [],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('OpenAICompatibleProvider — OpenRouter response cache (#330)', () => {
  it('attaches cache_control: ephemeral on requests routed to openrouter.ai', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    });

    await provider.generate(baseRequest);
    expect(capturedBody.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('does NOT attach cache_control on non-OpenRouter endpoints', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });

    await provider.generate(baseRequest);
    expect(capturedBody).not.toHaveProperty('cache_control');
  });

  it('skips cache_control when openRouterResponseCache: false', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      openRouterResponseCache: false,
    });

    await provider.generate(baseRequest);
    expect(capturedBody).not.toHaveProperty('cache_control');
  });

  it('forwards cache hit telemetry from prompt_tokens_details.cached_tokens', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'cached!' } }],
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 20,
            total_tokens: 5020,
            prompt_tokens_details: {
              cached_tokens: 4800,
              cache_write_tokens: 0,
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toEqual({
      provider: 'openrouter',
      cacheReadTokens: 4800,
      cacheWriteTokens: 0,
      hit: true,
    });
  });

  it('forwards cache write telemetry when cache_write_tokens > 0 (warm-up)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'first call' } }],
          usage: {
            prompt_tokens: 5000,
            completion_tokens: 20,
            total_tokens: 5020,
            prompt_tokens_details: {
              cached_tokens: 0,
              cache_write_tokens: 5000,
            },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry[0]?.hit).toBe(false);
    expect(telemetry[0]?.cacheWriteTokens).toBe(5000);
    expect(telemetry[0]?.cacheReadTokens).toBe(0);
  });

  it('does not fire telemetry on non-OpenRouter endpoints', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 10,
            total_tokens: 110,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry).toHaveLength(0);
  });

  it('survives a throwing onCacheTelemetry hook (telemetry must not crash request)', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: 'ok' } }],
          usage: {
            prompt_tokens: 100,
            completion_tokens: 5,
            total_tokens: 105,
            prompt_tokens_details: { cached_tokens: 80 },
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      onCacheTelemetry: () => {
        throw new Error('telemetry broke');
      },
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('ok');
  });

  it('opts streaming requests into stream_options.include_usage', async () => {
    let capturedBody: Record<string, unknown> = {};
    const sseChunks = [
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      // OpenRouter trailing usage chunk (empty choices array + top-level usage)
      'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":2,"total_tokens":102,"prompt_tokens_details":{"cached_tokens":90,"cache_write_tokens":0}}}\n\n',
      'data: [DONE]\n\n',
    ];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      const stream = new ReadableStream({
        start(controller) {
          for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    const chunks: string[] = [];
    for await (const chunk of provider.generateStream(baseRequest)) {
      if (chunk.type === 'text') chunks.push(chunk.text);
    }

    expect(capturedBody.cache_control).toEqual({ type: 'ephemeral' });
    expect(capturedBody.stream_options).toMatchObject({ include_usage: true });
    expect(chunks.join('')).toBe('hi');
    // Telemetry should fire once for the trailing usage chunk.
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toEqual({
      provider: 'openrouter',
      cacheReadTokens: 90,
      cacheWriteTokens: 0,
      hit: true,
    });
  });

  it('detects subdomain variants of openrouter.ai (defence in depth)', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-or-key',
      baseUrl: 'https://api.openrouter.ai/api/v1',
      model: 'anthropic/claude-sonnet-4.6',
    });

    await provider.generate(baseRequest);
    expect(capturedBody.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('handles malformed baseUrl gracefully (returns false from host check)', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new OpenAICompatibleProvider({
      apiKey: 'sk-key',
      baseUrl: 'not a valid url at all',
      model: 'gpt-4o',
    });

    await provider.generate(baseRequest);
    expect(capturedBody).not.toHaveProperty('cache_control');
  });
});

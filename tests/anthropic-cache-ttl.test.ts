/**
 * v0.9.0 (#336) — Anthropic configurable prompt-cache TTL.
 *
 * Verifies the AnthropicProvider:
 *   1. Defaults to no cache_control when promptCaching is off (back-compat).
 *   2. With promptCaching: true, attaches `cache_control: { type: 'ephemeral', ttl: '5m' }`
 *      to the trailing system block and the trailing tool entry (the stable
 *      v0.8.2 #275 prefix). TTL defaults to 5m.
 *   3. cacheTtl: '1h' produces ttl: '1h' on every breakpoint AND adds
 *      `extended-cache-ttl-2025-04-11` to the anthropic-beta header.
 *   4. cacheTtl: '5m' keeps the existing prompt-caching-2024-07-31 header only.
 *   5. Forwards `usage.cache_read_input_tokens` / `cache_creation_input_tokens`
 *      plus the configured TTL via `onCacheTelemetry`.
 *   6. Streaming path mirrors the same body + headers + telemetry.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicProvider } from '@crowclaw/providers';
import type { ProviderRequest } from '@crowclaw/core';
import type { ProviderCacheTelemetry } from '@crowclaw/providers';

const baseRequest: ProviderRequest = {
  systemPrompt: 'You are CrowClaw, an exhaustively prompted research assistant.',
  messages: [{ role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  availableTools: [
    {
      name: 'web.search',
      description: 'Search the web.',
      runtime: 'sandbox',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low',
    },
    {
      name: 'terminal.exec',
      description: 'Run shell commands.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high',
    },
  ],
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('AnthropicProvider — configurable prompt-cache TTL (#336)', () => {
  it('does NOT attach cache_control when promptCaching is disabled', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
    });

    await provider.generate(baseRequest);
    // System remains a plain string and tools stay free of cache markers.
    expect(typeof capturedBody.system).toBe('string');
    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools.every((t) => !('cache_control' in t))).toBe(true);
    expect(capturedHeaders).not.toHaveProperty('anthropic-beta');
  });

  it('defaults to ttl: "5m" when promptCaching: true and cacheTtl is omitted', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
    });

    await provider.generate(baseRequest);

    // System lifted to the array-of-content-blocks form so the trailing
    // block can carry a cache_control marker.
    expect(Array.isArray(capturedBody.system)).toBe(true);
    const sys = capturedBody.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]).toMatchObject({
      type: 'text',
      cache_control: { type: 'ephemeral', ttl: '5m' },
    });

    // Trailing tool carries an identical breakpoint.
    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(2);
    expect(tools[tools.length - 1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '5m',
    });
    // Non-trailing tools stay clean to keep the breakpoint at the tools-tail.
    expect(tools[0]).not.toHaveProperty('cache_control');

    // Beta header: just prompt-caching, no extended-cache-ttl.
    expect(capturedHeaders['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('uses ttl: "1h" and adds extended-cache-ttl beta header when cacheTtl: "1h"', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      cacheTtl: '1h',
    });

    await provider.generate(baseRequest);

    const sys = capturedBody.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });

    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools[tools.length - 1]?.cache_control).toEqual({
      type: 'ephemeral',
      ttl: '1h',
    });

    // Beta header: both flags joined by comma.
    expect(capturedHeaders['anthropic-beta']).toContain('prompt-caching-2024-07-31');
    expect(capturedHeaders['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');
  });

  it('explicit cacheTtl: "5m" matches the implicit default (no extended-cache-ttl)', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      cacheTtl: '5m',
    });

    await provider.generate(baseRequest);
    expect(capturedHeaders['anthropic-beta']).toBe('prompt-caching-2024-07-31');
  });

  it('forwards Anthropic cache_read / cache_creation counts and TTL via telemetry', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'cached' }],
          usage: {
            input_tokens: 200,
            output_tokens: 15,
            cache_read_input_tokens: 4800,
            cache_creation_input_tokens: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      cacheTtl: '1h',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toEqual({
      provider: 'anthropic',
      ttl: '1h',
      cacheReadTokens: 4800,
      cacheWriteTokens: 0,
      hit: true,
    });
  });

  it('reports a miss (hit:false) on first warm-up where cache_creation > 0 and read = 0', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'first call' }],
          usage: {
            input_tokens: 5000,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 4800,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry[0]?.hit).toBe(false);
    expect(telemetry[0]?.cacheWriteTokens).toBe(4800);
    expect(telemetry[0]?.cacheReadTokens).toBe(0);
    expect(telemetry[0]?.ttl).toBe('5m'); // default
  });

  it('does not fire telemetry when promptCaching is disabled', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const telemetry: ProviderCacheTelemetry[] = [];
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    await provider.generate(baseRequest);
    expect(telemetry).toHaveLength(0);
  });

  it('survives a throwing onCacheTelemetry hook', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 0,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      onCacheTelemetry: () => {
        throw new Error('telemetry broke');
      },
    });

    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('ok');
  });

  it('streaming path attaches the same cache_control body + beta header + telemetry', async () => {
    let capturedBody: Record<string, unknown> = {};
    let capturedHeaders: Record<string, string> = {};

    // Minimal Anthropic SSE stream. The provider's parser resets currentEvent
    // on every reader.read() iteration, so each `event: + data:` pair must
    // live inside the same enqueued chunk for the pairing to survive.
    const sseChunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m1","usage":{"input_tokens":200,"output_tokens":0,"cache_read_input_tokens":150,"cache_creation_input_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
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
    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
      cacheTtl: '1h',
      onCacheTelemetry: (info) => telemetry.push(info),
    });

    const text: string[] = [];
    for await (const chunk of provider.generateStream(baseRequest)) {
      if (chunk.type === 'text') text.push(chunk.text);
    }

    expect(text.join('')).toBe('hi');

    // Body + headers parity with non-streaming path.
    const sys = capturedBody.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(capturedHeaders['anthropic-beta']).toContain('extended-cache-ttl-2025-04-11');

    // Telemetry fires once, from message_start.
    expect(telemetry).toHaveLength(1);
    expect(telemetry[0]).toEqual({
      provider: 'anthropic',
      ttl: '1h',
      cacheReadTokens: 150,
      cacheWriteTokens: 0,
      hit: true,
    });
  });

  it('preserves cache_control on a single-tool request (only tool is the breakpoint)', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
    });

    await provider.generate({
      ...baseRequest,
      availableTools: [baseRequest.availableTools[0]!],
    });

    const tools = capturedBody.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });

  it('handles a request with no tools (system breakpoint still set)', async () => {
    let capturedBody: Record<string, unknown> = {};
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body));
      return new Response(
        JSON.stringify({ content: [{ type: 'text', text: 'ok' }] }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new AnthropicProvider({
      apiKey: 'sk-ant',
      baseUrl: 'https://api.anthropic.com/v1',
      model: 'claude-sonnet-4-5',
      promptCaching: true,
    });

    await provider.generate({
      ...baseRequest,
      availableTools: [],
    });

    expect(capturedBody.tools).toBeUndefined();
    const sys = capturedBody.system as Array<Record<string, unknown>>;
    expect(sys[sys.length - 1]?.cache_control).toEqual({ type: 'ephemeral', ttl: '5m' });
  });
});

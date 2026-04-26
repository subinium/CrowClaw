import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LocalEmbeddingProvider,
  type LocalEmbeddingProviderConfig,
} from '@crowclaw/providers';
import type { EmbeddingProvider } from '@crowclaw/memory';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function makeFetchMock(
  responder: (url: string, init: RequestInit) => Response | Promise<Response>
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return responder(url, init ?? {});
  }) as unknown as typeof globalThis.fetch;
}

describe('LocalEmbeddingProvider', () => {
  it('issues one POST per text and returns the embedding vectors', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchMock = makeFetchMock((url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      calls.push({ url, body });
      return new Response(JSON.stringify({ embedding: [0.1, 0.2, 0.3] }), {
        status: 200,
      });
    });

    const provider = new LocalEmbeddingProvider({
      baseUrl: 'http://example:11434',
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    const vectors = await provider.embed(['hello', 'world']);

    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3]);
    expect(vectors[1]).toEqual([0.1, 0.2, 0.3]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe('http://example:11434/api/embeddings');
    expect(calls[0]!.body.model).toBe('nomic-embed-text');
    expect(calls[0]!.body.prompt).toBe('hello');
    expect(calls[1]!.body.prompt).toBe('world');
  });

  it('forwards `contextSize` as `options.num_ctx` in the request body', async () => {
    const captured: Record<string, unknown>[] = [];
    const fetchMock = makeFetchMock((_url, init) => {
      captured.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    });

    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      contextSize: 8192,
      fetch: fetchMock,
    });

    await provider.embed(['hi']);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.options).toEqual({ num_ctx: 8192 });
  });

  it('defaults contextSize to 4096 when not provided', async () => {
    const captured: Record<string, unknown>[] = [];
    const fetchMock = makeFetchMock((_url, init) => {
      captured.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    });

    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    await provider.embed(['hi']);

    expect(captured[0]!.options).toEqual({ num_ctx: 4096 });
  });

  it('uses Ollama default base URL when none provided', async () => {
    const calls: string[] = [];
    const fetchMock = makeFetchMock((url) => {
      calls.push(url);
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    });

    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });
    await provider.embed(['hi']);

    expect(calls[0]).toBe('http://localhost:11434/api/embeddings');
  });

  it('strips trailing slash from baseUrl', async () => {
    const calls: string[] = [];
    const fetchMock = makeFetchMock((url) => {
      calls.push(url);
      return new Response(JSON.stringify({ embedding: [1] }), { status: 200 });
    });

    const provider = new LocalEmbeddingProvider({
      baseUrl: 'http://example:11434/',
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });
    await provider.embed(['hi']);

    expect(calls[0]).toBe('http://example:11434/api/embeddings');
  });

  it('returns an empty array for empty input without calling fetch', async () => {
    const fetchMock = vi.fn();
    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock as unknown as typeof globalThis.fetch,
    });

    const vectors = await provider.embed([]);
    expect(vectors).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects construction when model is missing', () => {
    expect(
      () =>
        new LocalEmbeddingProvider({
          model: '',
        } as unknown as LocalEmbeddingProviderConfig)
    ).toThrow(/model/);
  });

  it('rejects non-positive contextSize', () => {
    expect(
      () =>
        new LocalEmbeddingProvider({
          model: 'nomic-embed-text',
          contextSize: 0,
        })
    ).toThrow(/positive integer/);

    expect(
      () =>
        new LocalEmbeddingProvider({
          model: 'nomic-embed-text',
          contextSize: -1,
        })
    ).toThrow(/positive integer/);

    expect(
      () =>
        new LocalEmbeddingProvider({
          model: 'nomic-embed-text',
          contextSize: 1.5,
        })
    ).toThrow(/positive integer/);
  });

  it('rejects non-positive timeoutMs', () => {
    expect(
      () =>
        new LocalEmbeddingProvider({
          model: 'nomic-embed-text',
          timeoutMs: 0,
        })
    ).toThrow(/positive number/);
  });

  it('wraps fetch errors with cause', async () => {
    const cause = new Error('econnrefused');
    const fetchMock = vi.fn(async () => {
      throw cause;
    }) as unknown as typeof globalThis.fetch;

    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    await expect(provider.embed(['hi'])).rejects.toMatchObject({
      message: expect.stringContaining('fetch failed'),
      cause,
    });
  });

  it('throws on non-OK HTTP responses including the body preview', async () => {
    const fetchMock = makeFetchMock(
      () => new Response('model not found', { status: 404 })
    );
    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    await expect(provider.embed(['hi'])).rejects.toThrow(
      /HTTP 404.*model not found/
    );
  });

  it('throws when response is missing the embedding field', async () => {
    const fetchMock = makeFetchMock(
      () => new Response(JSON.stringify({}), { status: 200 })
    );
    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    await expect(provider.embed(['hi'])).rejects.toThrow(/missing\/empty/);
  });

  it('aborts the request when timeoutMs elapses', async () => {
    let abortReason: unknown = null;
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init.signal;
        if (signal) {
          signal.addEventListener('abort', () => {
            abortReason =
              (signal as AbortSignal & { reason?: unknown }).reason ??
              new DOMException('Aborted', 'AbortError');
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      });
    }) as unknown as typeof globalThis.fetch;

    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      timeoutMs: 25,
      fetch: fetchMock,
    });

    await expect(provider.embed(['hi'])).rejects.toThrow(/timed out after 25ms/);
    expect(abortReason).not.toBeNull();
  });

  it('is structurally compatible with the @crowclaw/memory EmbeddingProvider', () => {
    const fetchMock = makeFetchMock(
      () => new Response(JSON.stringify({ embedding: [1] }), { status: 200 })
    );
    const provider = new LocalEmbeddingProvider({
      model: 'nomic-embed-text',
      fetch: fetchMock,
    });

    // Compile-time + runtime structural check: it should slot into the
    // EmbeddingProvider interface that EmbeddingMemoryStore consumes.
    const asEmbeddingProvider: EmbeddingProvider = provider;
    expect(typeof asEmbeddingProvider.embed).toBe('function');
  });
});

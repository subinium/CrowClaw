import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpJsonRpcSseTransport,
  McpClient,
  extractMcpMedia,
  toMediaTag,
  renderMcpContentWithMedia,
  createMcpTransport,
  type McpSseTransportOptions,
} from '../packages/mcp/src/index.js';
import { saveOAuthToken, removeToken } from '../packages/mcp/src/oauth.js';

/**
 * Issue #331: MCP SSE transport tests.
 *
 * We model the server's GET /events SSE stream with a manually-driven
 * ReadableStream so the test can push JSON-RPC responses frame-by-frame, and we
 * capture POST /messages bodies to assert request round-trips, OAuth headers,
 * and keepalive pings.
 */

const ENDPOINT = 'https://mcp.example.com';

interface SseServerHandle {
  /** Push a raw SSE frame (without the trailing blank-line separator). */
  pushFrame: (frame: string) => void;
  /** Push a JSON-RPC message as a `data:` SSE frame. */
  pushMessage: (message: unknown) => void;
  /** Close the SSE stream (server-side EOF). */
  closeStream: () => void;
  /** Error the SSE stream (simulates a broken pipe). */
  errorStream: (error?: Error) => void;
  /** Captured POST request bodies (parsed JSON). */
  posts: Array<{ url: string; body: any; headers: Record<string, string> }>;
  /** Captured GET stream request headers. */
  streamHeaders: Record<string, string>[];
  /** The fetch mock to inject via `fetchImpl`. */
  fetchImpl: typeof fetch;
  /** Number of times the GET /events stream was opened. */
  streamOpenCount: () => number;
}

const headersToObject = (init?: HeadersInit): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!init) return out;
  const h = new Headers(init);
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
};

/**
 * Build a controllable SSE server stub. Each GET to `/events` opens a fresh
 * ReadableStream controller; the most recent one is what `pushFrame` drives.
 */
const makeSseServer = (options?: { postStatus?: number }): SseServerHandle => {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  let openCount = 0;
  const posts: SseServerHandle['posts'] = [];
  const streamHeaders: Record<string, string>[] = [];

  const fetchImpl = (async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET') {
      openCount += 1;
      streamHeaders.push(headersToObject(init?.headers));
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          controller = c;
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }

    // POST /messages
    posts.push({
      url,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: headersToObject(init?.headers),
    });
    return new Response(null, { status: options?.postStatus ?? 202 });
  }) as typeof fetch;

  return {
    pushFrame: (frame: string) => {
      controller?.enqueue(encoder.encode(`${frame}\n\n`));
    },
    pushMessage: (message: unknown) => {
      controller?.enqueue(encoder.encode(`data: ${JSON.stringify(message)}\n\n`));
    },
    closeStream: () => {
      controller?.close();
      controller = null;
    },
    errorStream: (error?: Error) => {
      controller?.error(error ?? new Error('stream broken'));
      controller = null;
    },
    posts,
    streamHeaders,
    fetchImpl,
    streamOpenCount: () => openCount,
  };
};

/**
 * Auto-respond to the next pending JSON-RPC request observed in `posts` by
 * pushing a matching SSE response. Polls the captured posts because the POST
 * and the SSE push are decoupled in the real transport.
 */
const respondTo = async (
  server: SseServerHandle,
  method: string,
  result: unknown
): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    const req = server.posts.find((p) => p.body?.method === method && p.body?.id !== undefined);
    if (req) {
      server.pushMessage({ jsonrpc: '2.0', id: req.body.id, result });
      return;
    }
    await new Promise((r) => setTimeout(r, 1));
  }
  throw new Error(`No POST for method '${method}' observed`);
};

/** Connect a transport while auto-answering the initialize handshake. */
const connectWithHandshake = async (
  transport: McpJsonRpcSseTransport,
  server: SseServerHandle
): Promise<void> => {
  const connectPromise = transport.connect();
  await respondTo(server, 'initialize', { protocolVersion: '2024-11-05', capabilities: {} });
  await connectPromise;
};

describe('MCP SSE transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('completes a request/response round-trip over the SSE stream', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
    );

    await connectWithHandshake(transport, server);

    const listPromise = transport.listTools();
    await respondTo(server, 'tools/list', {
      tools: [{ name: 'search', description: 'Search docs' }],
    });
    const tools = await listPromise;
    expect(tools).toEqual([{ name: 'search', description: 'Search docs' }]);

    // initialize request went to /messages
    expect(server.posts[0].url).toBe(`${ENDPOINT}/messages`);
    expect(server.posts[0].body.method).toBe('initialize');

    await transport.disconnect();
  });

  it('honors a server-advertised endpoint frame for POST target', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
    );

    const connectPromise = transport.connect();
    // Server advertises a session-scoped messages URL before responding.
    server.pushFrame('event: endpoint\ndata: /messages?session=abc123');
    await respondTo(server, 'initialize', { capabilities: {} });
    await connectPromise;

    expect(server.posts.every((p) => p.url === `${ENDPOINT}/messages?session=abc123`)).toBe(true);
    await transport.disconnect();
  });

  it('forwards an explicit OAuth bearer token on stream + POST', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT, bearerToken: 'secret-token-123' },
      { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
    );

    await connectWithHandshake(transport, server);

    expect(server.streamHeaders[0]['authorization']).toBe('Bearer secret-token-123');
    expect(server.posts[0].headers['authorization']).toBe('Bearer secret-token-123');

    await transport.disconnect();
  });

  it('forwards a stored OAuth provider token', async () => {
    // Use a synthetic provider key so we never clobber a developer's real
    // ~/.crowclaw token. getStoredToken reads the store map by key regardless of
    // whether the provider is in OAUTH_CONFIGS.
    const provider = 'sse-test-provider';
    await saveOAuthToken(provider, 'stored-bearer-xyz');
    try {
      const server = makeSseServer();
      const transport = new McpJsonRpcSseTransport(
        { endpoint: ENDPOINT, oauthProvider: provider },
        { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
      );

      await connectWithHandshake(transport, server);
      expect(server.streamHeaders[0]['authorization']).toBe('Bearer stored-bearer-xyz');
      await transport.disconnect();
    } finally {
      await removeToken(provider);
    }
  });

  it('reconnects the stream on a stale pipe with exponential backoff', async () => {
    const server = makeSseServer();
    const onReconnect = vi.fn();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      {
        fetchImpl: server.fetchImpl,
        keepalive: false,
        autoReconnect: true,
        reconnectInitialDelayMs: 10,
        reconnectMaxAttempts: 3,
        stalePipeMs: 0,
        onReconnect,
      }
    );

    await connectWithHandshake(transport, server);
    expect(server.streamOpenCount()).toBe(1);

    // Break the pipe — should trigger a reconnect after the backoff delay.
    server.errorStream(new Error('ECONNRESET'));

    await vi.waitFor(() => {
      expect(onReconnect).toHaveBeenCalledTimes(1);
      expect(server.streamOpenCount()).toBe(2);
    });
    expect(onReconnect.mock.calls[0]).toEqual([1, 10]);

    await transport.disconnect();
  });

  it('emits keepalive pings on the configured interval', async () => {
    vi.useFakeTimers();
    const server = makeSseServer();
    const onKeepalive = vi.fn();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      {
        fetchImpl: server.fetchImpl,
        keepalive: true,
        keepaliveMs: 30_000,
        autoReconnect: false,
        stalePipeMs: 0,
        onKeepalive,
      }
    );

    // Drive connect with fake timers: kick the promise, answer handshake.
    const connectPromise = transport.connect();
    // Allow the GET stream + initialize POST to flush.
    await vi.advanceTimersByTimeAsync(0);
    const initReq = server.posts.find((p) => p.body?.method === 'initialize');
    expect(initReq).toBeTruthy();
    server.pushMessage({ jsonrpc: '2.0', id: initReq!.body.id, result: { capabilities: {} } });
    await vi.advanceTimersByTimeAsync(0);
    await connectPromise;

    const pingsBefore = server.posts.filter((p) => p.body?.method === 'ping').length;
    expect(pingsBefore).toBe(0);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onKeepalive).toHaveBeenCalledTimes(1);
    const pingsAfter = server.posts.filter((p) => p.body?.method === 'ping').length;
    expect(pingsAfter).toBe(1);

    await vi.advanceTimersByTimeAsync(30_000);
    expect(onKeepalive).toHaveBeenCalledTimes(2);

    await transport.disconnect();
  });

  it('parses a MEDIA image result into a media block', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
    );

    await connectWithHandshake(transport, server);

    const base64 = 'iVBORw0KGgoAAAANSUhEUg==';
    const callPromise = transport.callTool('screenshot', {});
    await respondTo(server, 'tools/call', {
      content: [
        { type: 'text', text: 'Here is the screenshot:' },
        { type: 'image', data: base64, mimeType: 'image/png' },
      ],
    });
    const result = await callPromise;

    expect(result.ok).toBe(true);

    const media = extractMcpMedia(result);
    expect(media).toEqual([{ kind: 'image', data: base64, mimeType: 'image/png' }]);
    expect(toMediaTag(media[0])).toBe(`MEDIA[data:image/png;base64,${base64}]`);

    const rendered = renderMcpContentWithMedia(result);
    expect(rendered).toBe(
      `Here is the screenshot:\nMEDIA[data:image/png;base64,${base64}]`
    );

    await transport.disconnect();
  });

  it('reflects MEDIA round-trip through a McpClient', async () => {
    const server = makeSseServer();
    const client = McpClient.fromSse(
      { endpoint: ENDPOINT },
      {
        transport: { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false } as
          McpSseTransportOptions,
      }
    );

    const connectPromise = client.connect();
    await respondTo(server, 'initialize', { capabilities: {} });
    await connectPromise;

    const base64 = 'QUJD';
    const callPromise = client.callTool('snap', {});
    // McpClient.callTool resolves the tool name first (lazy listTools), so the
    // client POSTs tools/list before tools/call — answer both round-trips.
    await respondTo(server, 'tools/list', { tools: [] });
    await respondTo(server, 'tools/call', {
      content: [{ type: 'image', data: base64, mimeType: 'image/jpeg' }],
    });
    const result = await callPromise;

    expect(extractMcpMedia(result)).toEqual([
      { kind: 'image', data: base64, mimeType: 'image/jpeg' },
    ]);

    await client.dispose();
  });

  it('selects the sse transport via createMcpTransport', () => {
    const sse = createMcpTransport({ kind: 'sse', config: { endpoint: ENDPOINT } });
    expect(sse).toBeInstanceOf(McpJsonRpcSseTransport);
    expect(typeof sse.connect).toBe('function');
    expect(typeof sse.disconnect).toBe('function');

    const stdio = createMcpTransport({ kind: 'stdio', config: { command: 'echo' } });
    expect(typeof stdio.connect).toBe('function');
  });

  it('rejects in-flight requests when disconnected', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      { fetchImpl: server.fetchImpl, keepalive: false, autoReconnect: false }
    );

    await connectWithHandshake(transport, server);

    const pending = transport.listTools();
    // Do not answer; disconnect should reject the pending request.
    await transport.disconnect();
    await expect(pending).rejects.toThrow(/disconnected/);
  });

  it('throws when used before connect()', async () => {
    const server = makeSseServer();
    const transport = new McpJsonRpcSseTransport(
      { endpoint: ENDPOINT },
      { fetchImpl: server.fetchImpl }
    );
    await expect(transport.listTools()).rejects.toThrow(/not connected/);
  });

  it('extractMcpMedia ignores non-media content and bare values', () => {
    expect(extractMcpMedia({ ok: true, content: 'plain string' })).toEqual([]);
    expect(extractMcpMedia({ ok: true, content: [{ type: 'text', text: 'hi' }] })).toEqual([]);
    expect(extractMcpMedia(undefined)).toEqual([]);
    expect(
      extractMcpMedia([{ type: 'image' }]) // missing data
    ).toEqual([]);
  });
});

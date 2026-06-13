import type {
  McpTransport,
  McpCallResult,
  McpToolDefinition,
  McpResourceDefinition,
  McpPromptDefinition,
} from './index.js';
import { getStoredToken } from './oauth.js';

// -- v0.9.1 MCP SSE transport BEGIN --
//
// Issue #331 (Hermes v0.13 parity): MCP "HTTP + SSE" client transport.
//
// Wire protocol (MCP 2024-11-05 SSE transport):
//   - GET  {endpoint}/events   — long-lived Server-Sent-Events stream carrying
//                                 server -> client JSON-RPC responses and
//                                 notifications.
//   - POST {endpoint}/messages — client -> server JSON-RPC requests and
//                                 notifications.
//
// Many SSE servers advertise the POST URL dynamically via an initial
// `event: endpoint` SSE frame. We honour that when present and otherwise fall
// back to `{endpoint}/messages`.
//
// Differences from the browser `EventSource`:
//   - We open the GET stream with `fetch` so we can attach the OAuth bearer in
//     the `Authorization` header (EventSource cannot set headers in Node).
//   - We drive reconnect/backoff and keepalive ourselves.

export interface McpSseServerConfig {
  /**
   * Base endpoint of the SSE MCP server, e.g. `https://mcp.example.com`. The
   * transport derives `${endpoint}/events` (GET stream) and
   * `${endpoint}/messages` (POST) unless overridden below.
   */
  endpoint: string;
  /** Override the GET SSE stream URL. Defaults to `${endpoint}/events`. */
  eventsPath?: string;
  /** Override the POST messages URL. Defaults to `${endpoint}/messages`. */
  messagesPath?: string;
  /**
   * OAuth provider key (see oauth.ts OAUTH_CONFIGS). When set, the stored
   * bearer token for this provider is forwarded as `Authorization: Bearer ...`
   * on every request and on the SSE stream.
   */
  oauthProvider?: string;
  /**
   * Explicit bearer token. Takes precedence over `oauthProvider`. Useful when
   * the integrator already resolved the token from config.
   */
  bearerToken?: string;
  /** Extra static headers merged into every request (lowest precedence). */
  headers?: Record<string, string>;
}

export interface McpSseTransportOptions {
  /** Per-request timeout in ms (default 30s). */
  requestTimeoutMs?: number;
  /**
   * Keepalive heartbeat interval in ms (default 30_000). A `ping` notification
   * is POSTed on this cadence while connected to keep intermediaries (proxies,
   * load balancers) from idle-closing the SSE stream. Integrator wires this
   * from `mcp.sse.keepaliveMs`.
   */
  keepaliveMs?: number;
  /**
   * Whether keepalive is enabled (default true). Integrator wires this from
   * `mcp.sse.keepalive`.
   */
  keepalive?: boolean;
  /**
   * Auto-reconnect the SSE stream on stale-pipe / network error (default true),
   * with exponential backoff (initial 1s, doubling) up to `reconnectMaxAttempts`.
   * Disabled once `disconnect()` is called.
   */
  autoReconnect?: boolean;
  /** Max reconnect attempts before giving up (default 5). */
  reconnectMaxAttempts?: number;
  /** Initial backoff delay in ms (default 1000). Doubles each attempt. */
  reconnectInitialDelayMs?: number;
  /**
   * Stale-pipe detector: if no SSE byte (data or comment) arrives within this
   * window, the stream is considered stale and reconnect is triggered. Defaults
   * to `keepaliveMs * 2 + 5_000` so a missed heartbeat round-trip is tolerated.
   * Set to 0 to disable.
   */
  stalePipeMs?: number;
  /** Override `fetch` (tests). Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Override clock (tests). Defaults to `Date.now`. */
  now?: () => number;
  onError?: (error: Error) => void;
  onReconnect?: (attempt: number, delayMs: number) => void;
  /** Fired when a keepalive ping is emitted. Useful for tests/metrics. */
  onKeepalive?: () => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcMessage {
  jsonrpc?: '2.0';
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  params?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_KEEPALIVE_MS = 30_000;
const DEFAULT_RECONNECT_MAX_ATTEMPTS = 5;
const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 1_000;

const trimSlash = (value: string): string => value.replace(/\/$/, '');

export class McpJsonRpcSseTransport implements McpTransport {
  private readonly config: McpSseServerConfig;
  private readonly requestTimeoutMs: number;
  private readonly keepaliveMs: number;
  private readonly keepaliveEnabled: boolean;
  private readonly autoReconnect: boolean;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly stalePipeMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly onError?: (error: Error) => void;
  private readonly onReconnect?: (attempt: number, delayMs: number) => void;
  private readonly onKeepalive?: () => void;

  private nextId = 1;
  private connected = false;
  private disconnectRequested = false;
  private buffer = '';
  /** POST target — may be replaced by a server-advertised `endpoint` frame. */
  private messagesUrl: string;
  private readonly eventsUrl: string;

  private streamController: AbortController | null = null;
  private streamReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;

  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(config: McpSseServerConfig, options?: McpSseTransportOptions) {
    this.config = config;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.keepaliveMs = options?.keepaliveMs ?? DEFAULT_KEEPALIVE_MS;
    this.keepaliveEnabled = options?.keepalive ?? true;
    this.autoReconnect = options?.autoReconnect ?? true;
    this.reconnectMaxAttempts = options?.reconnectMaxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS;
    this.reconnectInitialDelayMs = options?.reconnectInitialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS;
    this.stalePipeMs = options?.stalePipeMs ?? this.keepaliveMs * 2 + 5_000;
    this.fetchImpl = options?.fetchImpl ?? globalThis.fetch;
    this.now = options?.now ?? Date.now;
    this.onError = options?.onError;
    this.onReconnect = options?.onReconnect;
    this.onKeepalive = options?.onKeepalive;

    const base = trimSlash(config.endpoint);
    this.eventsUrl = config.eventsPath ?? `${base}/events`;
    this.messagesUrl = config.messagesPath ?? `${base}/messages`;
  }

  /**
   * Resolve the bearer token for this transport. Explicit `bearerToken` wins,
   * otherwise look up the stored OAuth token for `oauthProvider`. Returns
   * undefined when no credential is configured.
   */
  private resolveBearer(): string | undefined {
    if (this.config.bearerToken) return this.config.bearerToken;
    if (this.config.oauthProvider) return getStoredToken(this.config.oauthProvider);
    return undefined;
  }

  private buildHeaders(extra?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = { ...(this.config.headers ?? {}), ...(extra ?? {}) };
    const bearer = this.resolveBearer();
    if (bearer) {
      headers['Authorization'] = `Bearer ${bearer}`;
    }
    return headers;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }
    this.disconnectRequested = false;
    await this.openStream();
    this.connected = true;
    this.reconnectAttempt = 0;
    this.startKeepalive();

    // MCP handshake.
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'crowclaw-mcp-client',
        version: '0.1.0',
      },
    });
    this.sendNotification('notifications/initialized', {});
  }

  /**
   * Open the GET SSE stream and begin pumping frames. Resolves once the stream
   * response is established (headers received); frame parsing continues
   * asynchronously in the background.
   */
  private async openStream(): Promise<void> {
    const controller = new AbortController();
    this.streamController = controller;

    const response = await this.fetchImpl(this.eventsUrl, {
      method: 'GET',
      headers: this.buildHeaders({ Accept: 'text/event-stream' }),
      signal: controller.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(
        `MCP SSE stream failed to open: ${response.status} ${response.statusText}`
      );
    }

    const reader = response.body.getReader();
    this.streamReader = reader;
    this.armStaleTimer();
    // Background pump — do not await; errors route through `handleStreamError`.
    void this.pumpStream(reader, controller);
  }

  private async pumpStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: AbortController
  ): Promise<void> {
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          // Stream closed by the server — treat as a stale pipe and reconnect.
          this.handleStreamError(new Error('MCP SSE stream closed by server'));
          return;
        }
        this.armStaleTimer();
        if (value) {
          this.handleChunk(decoder.decode(value, { stream: true }));
        }
      }
    } catch (error: unknown) {
      // An explicit disconnect aborts the controller; that is not an error.
      if (controller.signal.aborted && this.disconnectRequested) {
        return;
      }
      this.handleStreamError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private handleChunk(chunk: string): void {
    this.buffer += chunk;
    // SSE frames are separated by a blank line. Normalise CRLF first.
    const normalized = this.buffer.replace(/\r\n/g, '\n');
    const frames = normalized.split('\n\n');
    this.buffer = frames.pop() ?? '';

    for (const frame of frames) {
      this.handleFrame(frame);
    }
  }

  private handleFrame(frame: string): void {
    let eventName = 'message';
    const dataLines: string[] = [];

    for (const rawLine of frame.split('\n')) {
      // Strip a leading UTF-8 BOM (U+FEFF) that some servers prepend.
      const line = rawLine.replace(/^\uFEFF/, '');
      if (line.startsWith(':')) {
        continue; // SSE comment / heartbeat — keeps the pipe alive.
      }
      if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }

    if (dataLines.length === 0) {
      return;
    }
    const data = dataLines.join('\n');

    if (eventName === 'endpoint') {
      // Server-advertised POST URL. May be absolute or relative.
      this.messagesUrl = this.resolveEndpoint(data.trim());
      return;
    }

    try {
      const message = JSON.parse(data) as JsonRpcMessage;
      this.handleMessage(message);
    } catch {
      // Non-JSON data frame (server log/keepalive text) — ignore.
    }
  }

  private resolveEndpoint(value: string): string {
    try {
      return new URL(value, this.eventsUrl).toString();
    } catch {
      return value;
    }
  }

  private handleMessage(message: JsonRpcMessage): void {
    if (message.id === undefined || message.id === null) {
      return; // Server notification — no pending handler.
    }
    const id = typeof message.id === 'string' ? Number(message.id) : message.id;
    const pending = this.pending.get(id);
    if (!pending) {
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        new Error(`MCP JSON-RPC error (${message.error.code}): ${message.error.message}`)
      );
    } else {
      pending.resolve(message.result);
    }
  }

  // ---- stale-pipe detection + reconnect ----

  private armStaleTimer(): void {
    if (this.stalePipeMs <= 0) return;
    if (this.staleTimer) clearTimeout(this.staleTimer);
    this.staleTimer = setTimeout(() => {
      this.handleStreamError(
        new Error(`MCP SSE stream stale: no data for ${this.stalePipeMs}ms`)
      );
    }, this.stalePipeMs);
    (this.staleTimer as { unref?: () => void }).unref?.();
  }

  private clearStaleTimer(): void {
    if (this.staleTimer) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }

  /**
   * Handle a broken/stale SSE stream. Tears down the current stream and, unless
   * disconnect was requested, schedules a reconnect with exponential backoff.
   */
  private handleStreamError(error: Error): void {
    this.onError?.(error);
    this.teardownStream();
    if (this.disconnectRequested) return;
    this.maybeScheduleReconnect();
  }

  private teardownStream(): void {
    this.clearStaleTimer();
    if (this.streamReader) {
      void this.streamReader.cancel().catch(() => {
        // Cancel failures during teardown are non-fatal.
      });
      this.streamReader = null;
    }
    if (this.streamController) {
      try {
        this.streamController.abort();
      } catch {
        // Already aborted — ignore.
      }
      this.streamController = null;
    }
  }

  private maybeScheduleReconnect(): void {
    if (!this.autoReconnect) return;
    if (this.disconnectRequested) return;
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) {
      this.connected = false;
      this.rejectAllPending(new Error('MCP SSE reconnect attempts exhausted'));
      return;
    }
    if (this.reconnectTimer) return;

    const delayMs = this.reconnectInitialDelayMs * Math.pow(2, this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.onReconnect?.(this.reconnectAttempt, delayMs);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reopenStream();
    }, delayMs);
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  /** Re-open just the SSE stream (keeps `pending` and keepalive intact). */
  private async reopenStream(): Promise<void> {
    if (this.disconnectRequested) return;
    try {
      await this.openStream();
      this.connected = true;
      this.reconnectAttempt = 0;
    } catch (error: unknown) {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
      this.maybeScheduleReconnect();
    }
  }

  // ---- keepalive ----

  private startKeepalive(): void {
    if (!this.keepaliveEnabled || this.keepaliveMs <= 0) return;
    if (this.keepaliveTimer) return;
    this.keepaliveTimer = setInterval(() => {
      this.onKeepalive?.();
      // Fire-and-forget ping notification. Failures bubble through onError but
      // do not reject any caller; a dead pipe is caught by the stale detector.
      this.sendNotification('ping', {});
    }, this.keepaliveMs);
    (this.keepaliveTimer as { unref?: () => void }).unref?.();
  }

  private stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // ---- request / notification plumbing ----

  private async post(body: string): Promise<Response> {
    return this.fetchImpl(this.messagesUrl, {
      method: 'POST',
      headers: this.buildHeaders({ 'Content-Type': 'application/json' }),
      body,
    });
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      (timer as { unref?: () => void }).unref?.();

      this.pending.set(id, { resolve, reject, timer });

      this.post(JSON.stringify(request))
        .then((response) => {
          if (!response.ok) {
            clearTimeout(timer);
            this.pending.delete(id);
            reject(
              new Error(`MCP SSE POST '${method}' failed: ${response.status} ${response.statusText}`)
            );
          }
          // On success the JSON-RPC response arrives over the SSE stream and is
          // matched by id in `handleMessage`. Some servers also return the
          // result inline in the POST body; if the stream is the canonical
          // channel we ignore the body here.
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(
            new Error(
              `MCP SSE POST '${method}' failed: ${error instanceof Error ? error.message : String(error)}`,
              { cause: error }
            )
          );
        });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.post(JSON.stringify(notification)).catch((error: unknown) => {
      this.onError?.(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('MCP SSE transport is not connected. Call connect() first.');
    }
  }

  // ---- McpTransport surface ----

  async listTools(): Promise<McpToolDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('tools/list', {})) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    this.ensureConnected();
    const result = (await this.sendRequest('tools/call', { name, arguments: arguments_ })) as {
      content?: unknown;
      isError?: boolean;
    };
    return {
      ok: !result.isError,
      content: result.content,
      isError: result.isError,
    };
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('resources/list', {})) as {
      resources?: McpResourceDefinition[];
    };
    return result.resources ?? [];
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('prompts/list', {})) as {
      prompts?: McpPromptDefinition[];
    };
    return result.prompts ?? [];
  }

  async disconnect(): Promise<void> {
    this.disconnectRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopKeepalive();
    this.teardownStream();
    this.connected = false;
    this.rejectAllPending(new Error('MCP SSE transport disconnected'));
  }
}
// -- v0.9.1 MCP SSE transport END --

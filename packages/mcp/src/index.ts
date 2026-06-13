import { McpJsonRpcStdioTransport, type McpStdioServerConfig } from './stdio-transport.js';
import {
  McpJsonRpcSseTransport,
  type McpSseServerConfig,
  type McpSseTransportOptions,
} from './sse-transport.js';

export { McpJsonRpcStdioTransport } from './stdio-transport.js';
export type { McpStdioServerConfig, McpJsonRpcStdioTransportOptions } from './stdio-transport.js';
export { McpJsonRpcSseTransport } from './sse-transport.js';
export type { McpSseServerConfig, McpSseTransportOptions } from './sse-transport.js';
export { mcpPresets, createMcpFromPreset, listMcpPresetNames, getMcpPresetDescription, verifyPresetAvailability } from './presets.js';
export type {
  McpPresetName,
  FilesystemPresetConfig,
  GithubPresetConfig,
  BraveSearchPresetConfig,
  PostgresPresetConfig,
  SqlitePresetConfig,
  SlackPresetConfig,
  GoogleDrivePresetConfig,
  GoogleMapsPresetConfig,
  PlaywrightPresetConfig,
  ExaPresetConfig,
  SequentialThinkingPresetConfig,
} from './presets.js';

export {
  OAUTH_CONFIGS,
  startDeviceCodeFlow,
  saveOAuthToken,
  hasValidToken,
  getStoredToken,
  removeToken,
  listStoredTokenProviders,
  requestDeviceCode,
  pollForToken,
} from './oauth.js';
export type {
  OAuthConfig,
  DeviceCodeResponse,
  TokenResponse,
  RuntimeTokenStore,
} from './oauth.js';

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface McpResourceDefinition {
  uri: string;
  name?: string;
  description?: string;
  mimeType?: string;
}

export interface McpPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
}

export interface RegisteredMcpToolDefinition extends McpToolDefinition {
  originalName: string;
  registeredName: string;
}

export interface RegisteredMcpResourceDefinition extends McpResourceDefinition {
  serverName?: string;
}

export interface RegisteredMcpPromptDefinition extends McpPromptDefinition {
  serverName?: string;
}

export interface McpServerStatus {
  toolsRevision: number;
  cachedTools: number;
  supportsResources: boolean;
  supportsPrompts: boolean;
  degraded: boolean;
  lastError?: string;
  lastRefreshAt?: string;
}

export interface McpInspectResult {
  status: McpServerStatus;
  tools: RegisteredMcpToolDefinition[];
  resources: RegisteredMcpResourceDefinition[];
  prompts: RegisteredMcpPromptDefinition[];
}

export interface McpCallResult {
  ok: boolean;
  content: unknown;
  isError?: boolean;
}

// -- v0.9.1 MCP media (MEDIA tags) BEGIN --
//
// Issue #331 (Hermes v0.13 parity): MCP tool results may carry image content.
// Previously these were dropped or stringified by consumers. We surface them as
// MEDIA-tagged blocks so the agent context can render/inspect them rather than
// losing the data.
//
// MCP content items follow the shape `{ type: 'image', data: <base64>,
// mimeType: 'image/png' }` (and likewise `type: 'audio'`). We normalise those
// into `McpMediaContent` and a serialisable `MEDIA[...]` tag string.

export type McpMediaKind = 'image' | 'audio';

export interface McpMediaContent {
  kind: McpMediaKind;
  /** Base64-encoded payload as returned by the MCP server. */
  data: string;
  /** IANA media type, e.g. `image/png`. */
  mimeType: string;
}

interface McpRawContentItem {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

const MEDIA_TYPES: Record<string, McpMediaKind> = {
  image: 'image',
  audio: 'audio',
};

/**
 * Issue #331: Extract MEDIA (image/audio) content items from an MCP tool
 * result. Accepts either an `McpCallResult` or a raw content array. Returns the
 * normalised media blocks; non-media items are ignored.
 */
export function extractMcpMedia(result: McpCallResult | unknown): McpMediaContent[] {
  const content = isCallResult(result) ? result.content : result;
  if (!Array.isArray(content)) {
    return [];
  }
  const media: McpMediaContent[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) continue;
    const item = raw as McpRawContentItem;
    const kind = item.type ? MEDIA_TYPES[item.type] : undefined;
    if (!kind) continue;
    if (typeof item.data !== 'string' || item.data.length === 0) continue;
    media.push({
      kind,
      data: item.data,
      mimeType: typeof item.mimeType === 'string' && item.mimeType.length > 0
        ? item.mimeType
        : kind === 'image'
          ? 'image/png'
          : 'audio/wav',
    });
  }
  return media;
}

/**
 * Issue #331: Render a media block as a `MEDIA[...]` tag for embedding in agent
 * context. The data URI keeps the result self-describing and inline-renderable.
 */
export function toMediaTag(media: McpMediaContent): string {
  return `MEDIA[data:${media.mimeType};base64,${media.data}]`;
}

/**
 * Issue #331: Convert an MCP tool result's content array into a flat string,
 * preserving text items verbatim and converting image/audio items into MEDIA
 * tags instead of dropping them. Non-media, non-text items are JSON-stringified.
 */
export function renderMcpContentWithMedia(result: McpCallResult | unknown): string {
  const content = isCallResult(result) ? result.content : result;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return content === undefined || content === null ? '' : JSON.stringify(content);
  }
  const parts: string[] = [];
  for (const raw of content) {
    if (typeof raw !== 'object' || raw === null) {
      parts.push(String(raw));
      continue;
    }
    const item = raw as McpRawContentItem;
    const kind = item.type ? MEDIA_TYPES[item.type] : undefined;
    if (kind && typeof item.data === 'string' && item.data.length > 0) {
      parts.push(
        toMediaTag({
          kind,
          data: item.data,
          mimeType: typeof item.mimeType === 'string' && item.mimeType.length > 0
            ? item.mimeType
            : kind === 'image'
              ? 'image/png'
              : 'audio/wav',
        })
      );
    } else if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text);
    } else {
      parts.push(JSON.stringify(raw));
    }
  }
  return parts.join('\n');
}

const isCallResult = (value: unknown): value is McpCallResult =>
  typeof value === 'object' &&
  value !== null &&
  'content' in value &&
  'ok' in value;
// -- v0.9.1 MCP media (MEDIA tags) END --

export interface McpVerifyResult {
  ok: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount?: number;
  resourceCount?: number;
  promptCount?: number;
  error?: string;
  latencyMs: number;
}

export interface McpTransport {
  callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult>;
  listTools(): Promise<McpToolDefinition[]>;
  listResources?(): Promise<McpResourceDefinition[]>;
  listPrompts?(): Promise<McpPromptDefinition[]>;
}

// -- v0.9.1 MCP transport kind selection BEGIN --
//
// Issue #331: A discriminated config the integrator builds from
// `mcp.<server>.transport` config. `stdio` spawns a child process; `sse`
// connects to an HTTP+SSE endpoint with OAuth bearer forwarding. Both expose a
// `connect()`/`disconnect()` lifecycle (duck-typed; consumed by
// `McpClient.dispose()` and by the manager's connect path).

export type McpTransportKind = 'stdio' | 'sse';

export interface McpStdioTransportSpec {
  kind: 'stdio';
  config: McpStdioServerConfig;
}

export interface McpSseTransportSpec {
  kind: 'sse';
  config: McpSseServerConfig;
  options?: McpSseTransportOptions;
}

export type McpTransportSpec = McpStdioTransportSpec | McpSseTransportSpec;

/**
 * Issue #331: A transport with an explicit connect/disconnect lifecycle. Both
 * the stdio and SSE transports satisfy this; `McpClient.dispose()` calls
 * `disconnect()` when present.
 */
export interface ConnectableMcpTransport extends McpTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * Issue #331: Build a transport from a kind-tagged spec. Lets the integrator
 * select `stdio` vs `sse` from config without importing transport classes
 * directly. The caller must `connect()` before first use.
 */
export function createMcpTransport(spec: McpTransportSpec): ConnectableMcpTransport {
  switch (spec.kind) {
    case 'stdio':
      return new McpJsonRpcStdioTransport(spec.config);
    case 'sse':
      return new McpJsonRpcSseTransport(spec.config, spec.options);
    default: {
      // Exhaustiveness guard — a new kind must be handled above.
      const exhaustive: never = spec;
      throw new Error(`Unknown MCP transport kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
// -- v0.9.1 MCP transport kind selection END --

export interface McpHttpTransportOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface McpClientOptions {
  toolPrefix?: string;
  allowTools?: string[];
  denyTools?: string[];
  /**
   * Issue #80: Idle TTL for one-shot agent sessions. If set, the client tracks
   * `lastUsedAt` on every `callTool` / `listTools` / `listResources` /
   * `listPrompts` call and marks the session evictable once it has been idle
   * for longer than this. Callers (or `MultiServerMcpManager.sweepIdle`) drive
   * the actual eviction by calling {@link McpClient.sweepIfIdle} on a tick.
   *
   * Set to `0` or omit to disable idle eviction (default).
   */
  sessionIdleTtlMs?: number;
  /**
   * Issue #80: Override clock source for tests. Defaults to `Date.now`.
   */
  now?: () => number;
}

export class McpHttpTransport implements McpTransport {
  constructor(private readonly options: McpHttpTransportOptions) {}

  async listTools(): Promise<McpToolDefinition[]> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/tools`, {
      method: 'GET',
      headers: this.options.headers
    });
    if (!response.ok) {
      throw new Error(`MCP listTools failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as { tools?: McpToolDefinition[] };
    return payload.tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/tools/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.options.headers ?? {})
      },
      body: JSON.stringify({ name, arguments: arguments_ })
    });
    if (!response.ok) {
      throw new Error(`MCP callTool failed: ${response.status} ${response.statusText}`);
    }
    return (await response.json()) as McpCallResult;
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/resources`, {
      method: 'GET',
      headers: this.options.headers
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { resources?: McpResourceDefinition[] };
    return payload.resources ?? [];
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    const response = await fetch(`${this.options.baseUrl.replace(/\/$/, '')}/prompts`, {
      method: 'GET',
      headers: this.options.headers
    });
    if (!response.ok) {
      return [];
    }
    const payload = (await response.json()) as { prompts?: McpPromptDefinition[] };
    return payload.prompts ?? [];
  }
}

export class McpClient {
  private cachedTools: RegisteredMcpToolDefinition[] | null = null;
  private toolsRevision = 0;
  private degraded = false;
  private lastError?: string;
  private lastRefreshAt?: string;
  /** Issue #80: epoch ms of last successful activity. */
  private lastUsedAt: number;
  /** Issue #80: set when sweepIfIdle/dispose has evicted this session. */
  private disposed = false;
  private readonly now: () => number;

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.lastUsedAt = this.now();
  }

  static fromStdio(
    config: McpStdioServerConfig,
    options?: McpClientOptions
  ): McpClient {
    const transport = new McpJsonRpcStdioTransport(config);
    return new McpClient(transport, options);
  }

  // -- v0.9.1 MCP SSE transport BEGIN --
  /**
   * Issue #331: Build a client over the SSE (HTTP + Server-Sent-Events)
   * transport. The returned client's `dispose()` tears the SSE stream down via
   * the transport's `disconnect()`. The caller must `connect()` the transport
   * before first use — see {@link McpClient.connect}.
   */
  static fromSse(
    config: McpSseServerConfig,
    options?: McpClientOptions & { transport?: McpSseTransportOptions }
  ): McpClient {
    const { transport: transportOptions, ...clientOptions } = options ?? {};
    const transport = new McpJsonRpcSseTransport(config, transportOptions);
    return new McpClient(transport, clientOptions);
  }
  // -- v0.9.1 MCP SSE transport END --

  // -- v0.9.1 MCP SSE transport BEGIN --
  /**
   * Issue #331: Connect the underlying transport if it exposes a `connect()`
   * lifecycle (stdio + SSE do). No-op for connectionless transports (e.g.
   * `McpHttpTransport`). Idempotent — safe to call before each use.
   */
  async connect(): Promise<void> {
    this.ensureNotDisposed();
    const transport = this.transport as { connect?: () => Promise<void> };
    if (typeof transport.connect === 'function') {
      await transport.connect();
    }
  }
  // -- v0.9.1 MCP SSE transport END --

  private filterTool(tool: McpToolDefinition): boolean {
    if (this.options.allowTools?.length && !this.options.allowTools.includes(tool.name)) {
      return false;
    }
    if (this.options.denyTools?.includes(tool.name)) {
      return false;
    }
    return true;
  }

  private registerTool(tool: McpToolDefinition): RegisteredMcpToolDefinition {
    const registeredName = this.options.toolPrefix
      ? `${this.options.toolPrefix}.${tool.name}`
      : tool.name;

    return {
      ...tool,
      originalName: tool.name,
      registeredName,
      name: registeredName
    };
  }

  async refreshTools(): Promise<RegisteredMcpToolDefinition[]> {
    this.ensureNotDisposed();
    try {
      const discovered = await this.transport.listTools();
      const registered = discovered
        .filter((tool) => this.filterTool(tool))
        .map((tool) => this.registerTool(tool));
      this.cachedTools = registered;
      this.degraded = false;
      this.lastError = undefined;
      this.lastRefreshAt = new Date().toISOString();
      this.touch();
      return registered;
    } catch (error) {
      this.degraded = true;
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastRefreshAt = new Date().toISOString();
      throw error;
    }
  }

  markToolsChanged(): void {
    this.cachedTools = null;
    this.toolsRevision += 1;
  }

  getToolsRevision(): number {
    return this.toolsRevision;
  }

  async listTools(options?: { refresh?: boolean }): Promise<RegisteredMcpToolDefinition[]> {
    if (options?.refresh || !this.cachedTools) {
      return this.refreshTools();
    }
    return this.cachedTools;
  }

  async resolveToolName(name: string): Promise<string> {
    const tools = await this.listTools();
    const match = tools.find((tool) => tool.registeredName === name || tool.originalName === name);
    return match?.originalName ?? name;
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    this.ensureNotDisposed();
    const resolvedName = await this.resolveToolName(name);
    const result = await this.transport.callTool(resolvedName, arguments_);
    this.touch();
    return result;
  }

  async listResources(): Promise<RegisteredMcpResourceDefinition[]> {
    this.ensureNotDisposed();
    const resources = await this.transport.listResources?.() ?? [];
    this.touch();
    return resources.map((resource) => ({ ...resource }));
  }

  async listPrompts(): Promise<RegisteredMcpPromptDefinition[]> {
    this.ensureNotDisposed();
    const prompts = await this.transport.listPrompts?.() ?? [];
    this.touch();
    return prompts.map((prompt) => ({ ...prompt }));
  }

  // ------- Issue #80: idle session eviction -------

  /** Issue #80: Update last-used timestamp. Called after every successful op. */
  private touch(): void {
    this.lastUsedAt = this.now();
  }

  /** Issue #80: Reject calls after `dispose()` has been invoked. */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new Error('McpClient has been disposed (idle TTL exceeded).');
    }
  }

  /** Issue #80: epoch ms of last successful activity. Exposed for diagnostics. */
  getLastUsedAt(): number {
    return this.lastUsedAt;
  }

  /** Issue #80: ms since the last successful op. */
  getIdleMs(now: number = this.now()): number {
    return now - this.lastUsedAt;
  }

  /** Issue #80: True after `dispose()` has been invoked. */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Issue #80: Idle if `sessionIdleTtlMs` is set and `now - lastUsedAt`
   * exceeds it. Sessions without a configured TTL are never idle.
   */
  isIdle(now: number = this.now()): boolean {
    const ttl = this.options.sessionIdleTtlMs;
    if (!ttl || ttl <= 0) return false;
    return now - this.lastUsedAt > ttl;
  }

  /**
   * Issue #80: If the session is idle (per `sessionIdleTtlMs`), dispose it and
   * return true. Returns false otherwise. Drives eviction on a tick — call
   * from a manager-level sweep loop.
   */
  async sweepIfIdle(now: number = this.now()): Promise<boolean> {
    if (this.disposed) return false;
    if (!this.isIdle(now)) return false;
    await this.dispose();
    return true;
  }

  /**
   * Issue #80: Mark the client disposed and best-effort tear down the
   * underlying transport. Idempotent. After dispose, all calls throw.
   *
   * Also invoked when a one-shot agent exits — see runtime wiring.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.cachedTools = null;
    const transport = this.transport as { disconnect?: () => Promise<void> };
    if (typeof transport.disconnect === 'function') {
      try {
        await transport.disconnect();
      } catch {
        // Disconnect failures are non-fatal during eviction.
      }
    }
  }

  getStatus(): McpServerStatus {
    return {
      toolsRevision: this.toolsRevision,
      cachedTools: this.cachedTools?.length ?? 0,
      supportsResources: typeof this.transport.listResources === 'function',
      supportsPrompts: typeof this.transport.listPrompts === 'function',
      degraded: this.degraded,
      lastError: this.lastError,
      lastRefreshAt: this.lastRefreshAt
    };
  }

  async inspect(options?: { refresh?: boolean }): Promise<McpInspectResult> {
    const tools = await this.listTools(options);
    const resources = await this.listResources();
    const prompts = await this.listPrompts();
    return {
      status: this.getStatus(),
      tools,
      resources,
      prompts
    };
  }

  /** Test if the MCP server is reachable and functional */
  async verify(options?: { timeoutMs?: number }): Promise<McpVerifyResult> {
    const timeoutMs = options?.timeoutMs ?? 5_000;
    const start = Date.now();

    const timeout = <T>(promise: Promise<T>, label: string): Promise<T> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);

    try {
      const tools = await timeout(this.transport.listTools(), 'tools/list');
      const toolCount = tools.length;

      let resourceCount: number | undefined;
      if (typeof this.transport.listResources === 'function') {
        try {
          const resources = await timeout(this.transport.listResources(), 'resources/list');
          resourceCount = resources.length;
        } catch {
          // resources not supported or failed — non-fatal
        }
      }

      let promptCount: number | undefined;
      if (typeof this.transport.listPrompts === 'function') {
        try {
          const prompts = await timeout(this.transport.listPrompts(), 'prompts/list');
          promptCount = prompts.length;
        } catch {
          // prompts not supported or failed — non-fatal
        }
      }

      return {
        ok: true,
        toolCount,
        resourceCount,
        promptCount,
        latencyMs: Date.now() - start,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - start,
      };
    }
  }
}

export class MultiServerMcpManager {
  constructor(private readonly servers: Record<string, McpClient>) {}

  async refreshTools(): Promise<RegisteredMcpToolDefinition[]> {
    const toolSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, client]) => {
        const tools = await client.refreshTools();
        return tools.map((tool) => ({
          ...tool,
          registeredName: `${serverName}.${tool.registeredName}`,
          name: `${serverName}.${tool.registeredName}`
        }));
      })
    );
    return toolSets.flat();
  }

  async listTools(options?: { refresh?: boolean }): Promise<RegisteredMcpToolDefinition[]> {
    const toolSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, client]) => {
        const tools = await client.listTools(options);
        return tools.map((tool) => ({
          ...tool,
          registeredName: `${serverName}.${tool.registeredName}`,
          name: `${serverName}.${tool.registeredName}`
        }));
      })
    );
    return toolSets.flat();
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    const [serverName, ...rest] = name.split('.');
    if (!serverName) {
      throw new Error('Invalid MCP tool name.');
    }
    const client = this.servers[serverName];
    if (!client) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }
    const toolName = rest.join('.');
    return client.callTool(toolName, arguments_);
  }

  async listResources(): Promise<RegisteredMcpResourceDefinition[]> {
    const resourceSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, client]) => {
        const resources = await client.listResources();
        return resources.map((resource) => ({ ...resource, serverName }));
      })
    );
    return resourceSets.flat();
  }

  async listPrompts(): Promise<RegisteredMcpPromptDefinition[]> {
    const promptSets = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, client]) => {
        const prompts = await client.listPrompts();
        return prompts.map((prompt) => ({ ...prompt, serverName }));
      })
    );
    return promptSets.flat();
  }

  notifyToolsChanged(serverName?: string): void {
    if (serverName) {
      this.servers[serverName]?.markToolsChanged();
      return;
    }
    Object.values(this.servers).forEach((client) => client.markToolsChanged());
  }

  getServerStatus(): Record<string, McpServerStatus> {
    return Object.fromEntries(
      Object.entries(this.servers).map(([serverName, client]) => [serverName, client.getStatus()])
    );
  }

  async inspect(options?: { refresh?: boolean }): Promise<Record<string, McpInspectResult>> {
    const entries = await Promise.all(
      Object.entries(this.servers).map(async ([serverName, client]) => {
        const inspected = await client.inspect(options);
        return [serverName, inspected] as const;
      })
    );
    return Object.fromEntries(entries);
  }

  /**
   * Issue #80: Sweep all managed clients and dispose any whose idle TTL has
   * expired. Returns the names of evicted servers. Servers without a
   * configured `sessionIdleTtlMs` are never evicted.
   *
   * Wire this on a manager-level interval (default 30s in callers) or call
   * once from a one-shot agent's exit path to release child processes.
   */
  async sweepIdle(now?: number): Promise<string[]> {
    const evicted: string[] = [];
    for (const [serverName, client] of Object.entries(this.servers)) {
      const swept = await client.sweepIfIdle(now);
      if (swept) evicted.push(serverName);
    }
    return evicted;
  }

  /**
   * Issue #80: Dispose every managed client. Used by one-shot agent exit and
   * test teardown. Idempotent.
   */
  async disposeAll(): Promise<void> {
    await Promise.all(Object.values(this.servers).map((client) => client.dispose()));
  }
}

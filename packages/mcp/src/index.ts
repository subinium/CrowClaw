import { McpJsonRpcStdioTransport, type McpStdioServerConfig } from './stdio-transport.js';

export { McpJsonRpcStdioTransport } from './stdio-transport.js';
export type { McpStdioServerConfig, McpJsonRpcStdioTransportOptions } from './stdio-transport.js';
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

export interface McpHttpTransportOptions {
  baseUrl: string;
  headers?: Record<string, string>;
}

export interface McpClientOptions {
  toolPrefix?: string;
  allowTools?: string[];
  denyTools?: string[];
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

  constructor(
    private readonly transport: McpTransport,
    private readonly options: McpClientOptions = {}
  ) {}

  static fromStdio(
    config: McpStdioServerConfig,
    options?: McpClientOptions
  ): McpClient {
    const transport = new McpJsonRpcStdioTransport(config);
    return new McpClient(transport, options);
  }

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
    try {
      const discovered = await this.transport.listTools();
      const registered = discovered
        .filter((tool) => this.filterTool(tool))
        .map((tool) => this.registerTool(tool));
      this.cachedTools = registered;
      this.degraded = false;
      this.lastError = undefined;
      this.lastRefreshAt = new Date().toISOString();
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
    const resolvedName = await this.resolveToolName(name);
    return this.transport.callTool(resolvedName, arguments_);
  }

  async listResources(): Promise<RegisteredMcpResourceDefinition[]> {
    const resources = await this.transport.listResources?.() ?? [];
    return resources.map((resource) => ({ ...resource }));
  }

  async listPrompts(): Promise<RegisteredMcpPromptDefinition[]> {
    const prompts = await this.transport.listPrompts?.() ?? [];
    return prompts.map((prompt) => ({ ...prompt }));
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
}

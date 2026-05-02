// Standalone ACP server — not auto-started by runtime

import { createInterface } from 'node:readline';
import type { ToolCatalog } from '@crowclaw/core';

// ---------------------------------------------------------------------------
// ACP message types (JSON-RPC 2.0 over stdio)
// ---------------------------------------------------------------------------

export interface AcpRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface AcpResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface AcpNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// ACP session & manifest types
// ---------------------------------------------------------------------------

export interface AcpSessionInfo {
  id: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface AcpAgentManifest {
  schema_version: number;
  name: string;
  display_name: string;
  version: string;
  description: string;
  repository?: string;
  install?: { npm?: string; binary?: string };
  features?: string[];
}

/**
 * Issue #148: Tool descriptor surfaced via `tools/list`. Mirrors the MCP
 * shape so callers can pipe straight from a registry without a translation
 * layer. `inputSchema` is optional — registries that don't ship JSON Schema
 * yet just omit it.
 */
export interface AcpToolInfo {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Agent loop interface expected by the ACP server
// ---------------------------------------------------------------------------

export interface AcpAgentLoop {
  run(input: {
    agentId: string;
    sessionId: string;
    userMessage: string;
    systemPrompt?: string;
  }): Promise<{
    finalResponse: string;
    toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
  }>;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;

// ---------------------------------------------------------------------------
// AcpServer
// ---------------------------------------------------------------------------

export class AcpServer {
  private sessions = new Map<string, AcpSessionInfo>();
  private shutdownRequested = false;

  constructor(
    private readonly agentLoop: AcpAgentLoop,
    private readonly options?: {
      agentId?: string;
      displayName?: string;
      version?: string;
      /**
       * Issue #148: Optional registry callback that returns the live tool
       * surface. When provided, `tools/list` returns `{ tools, available: true }`.
       * When omitted, `tools/list` returns `{ tools: [], available: false }`
       * to signal the bridge is wired but no registry is connected — clients
       * can detect the difference and fall back to MCP. Errors thrown by the
       * callback are caught and surface as `available: false` with an
       * `error` field rather than failing the request.
       */
      tools?: () => AcpToolInfo[] | Promise<AcpToolInfo[]>;
      toolCatalog?: ToolCatalog;
    },
  ) {}

  async handleRequest(request: AcpRequest): Promise<AcpResponse> {
    const id = request.id;

    try {
      switch (request.method) {
        case 'initialize':
          return this.respondOk(id, {
            capabilities: { tools: true, streaming: false },
            agent: {
              name: this.options?.agentId ?? 'crowclaw',
              version: this.options?.version ?? '0.1.0',
            },
          });

        case 'agent/info':
          return this.respondOk(
            id,
            generateAcpManifest({
              name: this.options?.agentId,
              displayName: this.options?.displayName,
              version: this.options?.version,
            }),
          );

        case 'sessions/list':
          return this.respondOk(id, {
            sessions: Array.from(this.sessions.values()),
          });

        case 'sessions/create': {
          const title =
            typeof request.params?.['title'] === 'string'
              ? request.params['title']
              : undefined;
          const session = this.createSession(title);
          return this.respondOk(id, session);
        }

        case 'sessions/delete': {
          const sessionId = request.params?.['sessionId'];
          if (typeof sessionId !== 'string') {
            return this.respondError(id, INVALID_REQUEST, 'Missing sessionId');
          }
          const deleted = this.sessions.delete(sessionId);
          return this.respondOk(id, { deleted });
        }

        case 'prompt/execute': {
          const sessionId = request.params?.['sessionId'];
          const message = request.params?.['message'];
          const systemPrompt =
            typeof request.params?.['systemPrompt'] === 'string'
              ? request.params['systemPrompt']
              : undefined;

          if (typeof sessionId !== 'string' || typeof message !== 'string') {
            return this.respondError(
              id,
              INVALID_REQUEST,
              'Missing sessionId or message',
            );
          }

          const session = this.sessions.get(sessionId);
          if (!session) {
            return this.respondError(
              id,
              INVALID_REQUEST,
              `Session not found: ${sessionId}`,
            );
          }

          const result = await this.agentLoop.run({
            agentId: this.options?.agentId ?? 'crowclaw',
            sessionId,
            userMessage: message,
            systemPrompt,
          });

          session.messageCount += 2; // user + assistant
          session.updatedAt = new Date().toISOString();

          return this.respondOk(id, {
            response: result.finalResponse,
            toolResults: result.toolResults,
          });
        }

        case 'tools/list': {
          // Issue #148: surface the registry callback when wired; otherwise
          // signal availability=false so clients can route through MCP.
          const listTools = this.options?.tools ?? (this.options?.toolCatalog
            ? () => this.options!.toolCatalog!.list().map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              }))
            : undefined);
          if (!listTools) {
            return this.respondOk(id, { tools: [], available: false });
          }
          try {
            const tools = await listTools();
            return this.respondOk(id, { tools, available: true });
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            return this.respondOk(id, { tools: [], available: false, error: message });
          }
        }

        case 'shutdown':
          this.shutdownRequested = true;
          return this.respondOk(id, { ok: true });

        default:
          return this.respondError(
            id,
            METHOD_NOT_FOUND,
            `Unknown method: ${request.method}`,
          );
      }
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : String(error);
      return this.respondError(id, INTERNAL_ERROR, message);
    }
  }

  isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  // ------- helpers -------

  private createSession(title?: string): AcpSessionInfo {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const session: AcpSessionInfo = {
      id,
      title,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
    this.sessions.set(id, session);
    return session;
  }

  private respondOk(id: number | string, result: unknown): AcpResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private respondError(
    id: number | string,
    code: number,
    message: string,
    data?: unknown,
  ): AcpResponse {
    return { jsonrpc: '2.0', id, error: { code, message, data } };
  }
}

// ---------------------------------------------------------------------------
// AcpStdioTransport
// ---------------------------------------------------------------------------

export class AcpStdioTransport {
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(private readonly server: AcpServer) {}

  start(): void {
    this.rl = createInterface({ input: process.stdin, terminal: false });

    this.rl.on('line', (line: string) => {
      const trimmed = line.trim();
      if (trimmed.length === 0) return;

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        this.send({
          jsonrpc: '2.0',
          id: 0,
          error: { code: PARSE_ERROR, message: 'Parse error' },
        });
        return;
      }

      const request = parsed as AcpRequest;
      if (
        !request ||
        typeof request !== 'object' ||
        request.jsonrpc !== '2.0' ||
        request.id === undefined ||
        typeof request.method !== 'string'
      ) {
        const rawId = (parsed as Record<string, unknown>)?.['id'];
        this.send({
          jsonrpc: '2.0',
          id: typeof rawId === 'number' || typeof rawId === 'string' ? rawId : 0,
          error: { code: INVALID_REQUEST, message: 'Invalid Request' },
        });
        return;
      }

      this.server
        .handleRequest(request)
        .then((response) => {
          this.send(response);
          if (this.server.isShutdownRequested()) {
            this.stop();
          }
        })
        .catch((error: unknown) => {
          const msg =
            error instanceof Error ? error.message : String(error);
          this.send({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: INTERNAL_ERROR, message: msg },
          });
        });
    });
  }

  private send(message: AcpResponse | AcpNotification): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Manifest generator
// ---------------------------------------------------------------------------

export function generateAcpManifest(options?: {
  name?: string;
  displayName?: string;
  version?: string;
  description?: string;
  repository?: string;
}): AcpAgentManifest {
  return {
    schema_version: 1,
    name: options?.name ?? 'crowclaw',
    display_name: options?.displayName ?? 'CrowClaw Agent',
    version: options?.version ?? '0.1.0',
    description:
      options?.description ??
      'CrowClaw AI coding agent — TypeScript agent framework',
    repository: options?.repository,
    features: ['tools', 'sessions'],
  };
}

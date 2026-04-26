import { createInterface } from 'node:readline';
import { timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// MCP protocol types
// ---------------------------------------------------------------------------

export interface McpServerToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
  /**
   * If true, this tool exposes owner-privileged surfaces (scheduler controls,
   * arbitrary chat → underlying privileged tools, session/memory state).
   * Non-owner MCP clients must not see or execute these. (#27)
   */
  ownerOnly?: boolean;
}

export interface McpServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
  /**
   * Caller identity supplied by the transport layer (#27). When the MCP server
   * is started with `ownerToken`, requests must carry a matching token here to
   * see/invoke `ownerOnly: true` tools. Stdio transport accepts an `_meta.token`
   * field on the JSON-RPC envelope; HTTP/SSE transports should plumb it from
   * `Authorization: Bearer ...`. If absent, the request is treated as non-owner.
   */
  _meta?: { token?: string; [key: string]: unknown };
}

export interface McpServerResponse {
  jsonrpc: '2.0';
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string };
}

// ---------------------------------------------------------------------------
// Agent loop interface expected by CrowClawMcpServer
// ---------------------------------------------------------------------------

export interface McpAgentLoop {
  run(input: {
    agentId: string;
    sessionId: string;
    userMessage: string;
  }): Promise<{ finalResponse: string }>;
}

// ---------------------------------------------------------------------------
// JSON-RPC error codes
// ---------------------------------------------------------------------------

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
/** Application-level: tool exists but caller lacks privilege (#27). */
const FORBIDDEN = -32001;

/** Constant-time token comparison. Returns false on length mismatch or empty. */
function tokensMatch(expected: string | undefined, provided: string | undefined): boolean {
  if (!expected) return true; // no owner token configured → all callers are owner
  if (!provided) return false;
  const a = Buffer.from(expected, 'utf-8');
  const b = Buffer.from(provided, 'utf-8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// CrowClawMcpServer
// ---------------------------------------------------------------------------

export interface CrowClawMcpServerOptions {
  name?: string;
  version?: string;
  /**
   * If set, MCP clients must provide a matching token in `request._meta.token`
   * to see/invoke `ownerOnly: true` tools (#27). The transport layer is
   * responsible for plumbing the token from the underlying connection
   * (stdio: JSON-RPC `_meta`, HTTP/SSE: `Authorization: Bearer ...`).
   *
   * If omitted, the bridge runs in legacy mode where every caller is treated
   * as owner. Stdio is intended for local owner-only use, but operators
   * exposing the bridge to remote clients MUST set this.
   */
  ownerToken?: string;
}

export class CrowClawMcpServer {
  private readonly ownerToken?: string;

  constructor(
    private readonly agentLoop: McpAgentLoop,
    private readonly options?: CrowClawMcpServerOptions,
  ) {
    this.ownerToken = options?.ownerToken;
  }

  /**
   * Returns ALL tool definitions, including owner-only ones. Callers that
   * surface tools to MCP clients must filter via {@link getVisibleTools} based
   * on caller identity. Kept for backwards compatibility with existing tests.
   */
  getToolDefinitions(): McpServerToolDefinition[] {
    return [
      {
        name: 'crowclaw.chat',
        description: 'Send a message to the CrowClaw agent and get a response.',
        // Marked owner-only because the underlying agent loop can call
        // privileged tools (scheduler.create, terminal, sandbox.run) without
        // the MCP bridge being able to introspect intent.
        ownerOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'Session ID for the conversation.',
            },
            message: {
              type: 'string',
              description: 'User message to send to the agent.',
            },
          },
          required: ['sessionId', 'message'],
        },
      },
      {
        name: 'crowclaw.sessions.list',
        description: 'List all active CrowClaw sessions.',
        ownerOnly: true,
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'crowclaw.sessions.get',
        description: 'Get details of a specific CrowClaw session.',
        ownerOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            sessionId: {
              type: 'string',
              description: 'The session ID to retrieve.',
            },
          },
          required: ['sessionId'],
        },
      },
      {
        name: 'crowclaw.tools.list',
        description: 'List tools available to the CrowClaw agent.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'crowclaw.memories.search',
        description: 'Search memories stored by the CrowClaw agent.',
        ownerOnly: true,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Search query for memories.',
            },
            limit: {
              type: 'number',
              description: 'Maximum number of results to return.',
            },
          },
          required: ['query'],
        },
      },
    ];
  }

  /** Filter tool definitions visible to a caller based on their privilege (#27). */
  getVisibleTools(callerToken?: string): McpServerToolDefinition[] {
    const isOwner = tokensMatch(this.ownerToken, callerToken);
    if (isOwner) return this.getToolDefinitions();
    return this.getToolDefinitions().filter((t) => !t.ownerOnly);
  }

  /** True if the caller is allowed to invoke the named tool (#27). */
  private callerCanInvoke(toolName: string, callerToken?: string): boolean {
    const definition = this.getToolDefinitions().find((t) => t.name === toolName);
    if (!definition) return false;
    if (!definition.ownerOnly) return true;
    return tokensMatch(this.ownerToken, callerToken);
  }

  async handleRequest(request: McpServerRequest): Promise<McpServerResponse> {
    const id = request.id;
    const callerToken =
      typeof request._meta?.token === 'string' ? request._meta.token : undefined;

    try {
      switch (request.method) {
        case 'initialize':
          return this.respondOk(id, {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false },
              resources: { subscribe: false, listChanged: false },
              prompts: { listChanged: false },
            },
            serverInfo: {
              name: this.options?.name ?? 'crowclaw-mcp-server',
              version: this.options?.version ?? '0.1.0',
            },
          });

        case 'tools/list':
          // Filter ownerOnly tools out of the listing for non-owner callers (#27).
          return this.respondOk(id, {
            tools: this.getVisibleTools(callerToken),
          });

        case 'tools/call':
          return this.handleToolCall(id, request.params, callerToken);

        case 'resources/list':
          return this.respondOk(id, { resources: [] });

        case 'prompts/list':
          return this.respondOk(id, { prompts: [] });

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

  // ------- internal -------

  private async handleToolCall(
    id: number | string,
    params?: Record<string, unknown>,
    callerToken?: string,
  ): Promise<McpServerResponse> {
    const toolName = params?.['name'];
    const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    if (typeof toolName !== 'string') {
      return this.respondError(id, INVALID_PARAMS, 'Missing tool name');
    }

    // Owner gate: reject ownerOnly tool invocations from non-owner callers (#27).
    // We respond with METHOD_NOT_FOUND for ownerOnly tools rather than a more
    // descriptive code, to avoid leaking that the tool exists at all to
    // unauthenticated callers (mirrors the dashboard-token + scope pattern).
    if (!this.callerCanInvoke(toolName, callerToken)) {
      const definition = this.getToolDefinitions().find((t) => t.name === toolName);
      if (definition?.ownerOnly) {
        return this.respondError(id, FORBIDDEN, `Tool requires owner privilege: ${toolName}`);
      }
      return this.respondError(id, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`);
    }

    switch (toolName) {
      case 'crowclaw.chat': {
        const sessionId = args['sessionId'];
        const message = args['message'];
        if (typeof sessionId !== 'string' || typeof message !== 'string') {
          return this.respondError(
            id,
            INVALID_PARAMS,
            'crowclaw.chat requires sessionId (string) and message (string)',
          );
        }

        const result = await this.agentLoop.run({
          agentId: this.options?.name ?? 'crowclaw',
          sessionId,
          userMessage: message,
        });

        return this.respondOk(id, {
          content: [{ type: 'text', text: result.finalResponse }],
        });
      }

      case 'crowclaw.sessions.list':
        return this.respondOk(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ sessions: [], note: 'Session listing not connected — MCP server runs standalone' }, null, 2),
            },
          ],
        });

      case 'crowclaw.sessions.get': {
        const sessionId = args['sessionId'];
        if (typeof sessionId !== 'string') {
          return this.respondError(
            id,
            INVALID_PARAMS,
            'crowclaw.sessions.get requires sessionId (string)',
          );
        }
        return this.respondOk(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { sessionId, messages: [], note: 'Session history not connected — MCP server runs standalone' },
                null,
                2,
              ),
            },
          ],
        });
      }

      case 'crowclaw.tools.list':
        // Mirror the visibility filter on the meta tool listing — non-owner
        // callers must not learn that ownerOnly tools exist (#27).
        return this.respondOk(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { tools: this.getVisibleTools(callerToken).map((t) => t.name) },
                null,
                2,
              ),
            },
          ],
        });

      case 'crowclaw.memories.search': {
        const query = args['query'];
        if (typeof query !== 'string') {
          return this.respondError(
            id,
            INVALID_PARAMS,
            'crowclaw.memories.search requires query (string)',
          );
        }
        return this.respondOk(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { query, results: [], note: 'Memory search not connected — MCP server runs standalone' },
                null,
                2,
              ),
            },
          ],
        });
      }

      default:
        return this.respondError(
          id,
          METHOD_NOT_FOUND,
          `Unknown tool: ${toolName}`,
        );
    }
  }

  private respondOk(id: number | string, result: unknown): McpServerResponse {
    return { jsonrpc: '2.0', id, result };
  }

  private respondError(
    id: number | string,
    code: number,
    message: string,
  ): McpServerResponse {
    return { jsonrpc: '2.0', id, error: { code, message } };
  }
}

// ---------------------------------------------------------------------------
// McpServerStdioTransport
// ---------------------------------------------------------------------------

export class McpServerStdioTransport {
  private rl: ReturnType<typeof createInterface> | null = null;

  constructor(private readonly server: CrowClawMcpServer) {}

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

      const request = parsed as McpServerRequest;
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

  private send(message: McpServerResponse): void {
    process.stdout.write(JSON.stringify(message) + '\n');
  }

  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }
}

import { createInterface } from 'node:readline';

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
}

export interface McpServerRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
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

// ---------------------------------------------------------------------------
// CrowClawMcpServer
// ---------------------------------------------------------------------------

export class CrowClawMcpServer {
  constructor(
    private readonly agentLoop: McpAgentLoop,
    private readonly options?: {
      name?: string;
      version?: string;
    },
  ) {}

  getToolDefinitions(): McpServerToolDefinition[] {
    return [
      {
        name: 'crowclaw.chat',
        description: 'Send a message to the CrowClaw agent and get a response.',
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
        inputSchema: {
          type: 'object',
          properties: {},
        },
      },
      {
        name: 'crowclaw.sessions.get',
        description: 'Get details of a specific CrowClaw session.',
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

  async handleRequest(request: McpServerRequest): Promise<McpServerResponse> {
    const id = request.id;

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
          return this.respondOk(id, {
            tools: this.getToolDefinitions(),
          });

        case 'tools/call':
          return this.handleToolCall(id, request.params);

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
  ): Promise<McpServerResponse> {
    const toolName = params?.['name'];
    const args = (params?.['arguments'] ?? {}) as Record<string, unknown>;

    if (typeof toolName !== 'string') {
      return this.respondError(id, INVALID_PARAMS, 'Missing tool name');
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
        return this.respondOk(id, {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                { tools: this.getToolDefinitions().map((t) => t.name) },
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

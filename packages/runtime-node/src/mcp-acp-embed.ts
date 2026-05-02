import { CrowClawMcpServer } from '@crowclaw/mcp-server';
import { AcpServer } from '@crowclaw/acp';
import type { SessionState, ToolCatalog } from '@crowclaw/core';

export interface EmbeddedRunResult {
  finalResponse: string;
  toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
}

export type EmbeddedAgentRunner = (input: {
  sessionId: string;
  userMessage: string;
  systemPrompt?: string;
}) => Promise<EmbeddedRunResult>;

export function createEmbeddedProtocolServers(options: {
  run: EmbeddedAgentRunner;
  agentId: string;
  version: string;
  ownerToken?: string;
  sessionStore?: {
    listRecent?(limit?: number): Promise<SessionState[]>;
    list?(): Promise<SessionState[]>;
    get?(sessionId: string): Promise<SessionState | null>;
  };
  toolCatalog?: ToolCatalog;
}) {
  const embeddedMcpServer = new CrowClawMcpServer({
    run: async ({ sessionId, userMessage }) => {
      const result = await options.run({
        sessionId,
        userMessage,
        systemPrompt: 'You are CrowClaw running in embedded MCP server mode.',
      });
      return { finalResponse: result.finalResponse };
    },
  }, {
    name: options.agentId,
    version: options.version,
    ownerToken: options.ownerToken,
    sessionStore: options.sessionStore,
    toolCatalog: options.toolCatalog,
  });

  const embeddedAcpServer = new AcpServer({
    run: async ({ sessionId, userMessage, systemPrompt }) => {
      const result = await options.run({
        sessionId,
        userMessage,
        systemPrompt: systemPrompt ?? 'You are CrowClaw running in embedded ACP server mode.',
      });
      return {
        finalResponse: result.finalResponse,
        toolResults: result.toolResults,
      };
    },
  }, {
    agentId: options.agentId.replace(/mcp-server$/, 'acp'),
    displayName: 'CrowClaw ACP',
    version: options.version,
    toolCatalog: options.toolCatalog,
  });

  return { embeddedMcpServer, embeddedAcpServer };
}

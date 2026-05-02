import { CrowClawMcpServer } from '@crowclaw/mcp-server';
import { AcpServer } from '@crowclaw/acp';

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
  });

  return { embeddedMcpServer, embeddedAcpServer };
}

import { execFile } from 'node:child_process';
import { McpJsonRpcStdioTransport, type McpStdioServerConfig } from './stdio-transport.js';
import { McpClient, type McpClientOptions } from './index.js';

export interface FilesystemPresetConfig {
  roots: string[];
}

export interface GithubPresetConfig {
  token?: string;
}

export interface BraveSearchPresetConfig {
  apiKey: string;
}

export interface PostgresPresetConfig {
  connectionString: string;
}

export interface SqlitePresetConfig {
  dbPath: string;
}

export interface SlackPresetConfig {
  botToken: string;
  teamId?: string;
}

export interface GoogleDrivePresetConfig {
  credentials?: string; // Path to credentials JSON
}

export interface GoogleMapsPresetConfig {
  apiKey: string;
}

export interface SequentialThinkingPresetConfig {
  // no config needed
}

export const mcpPresets = {
  filesystem: (config: FilesystemPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', ...config.roots],
  }),

  github: (config: GithubPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: config.token ? { GITHUB_PERSONAL_ACCESS_TOKEN: config.token } : undefined,
  }),

  braveSearch: (config: BraveSearchPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: config.apiKey },
  }),

  memory: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
  }),

  puppeteer: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
  }),

  fetch: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-fetch'],
  }),

  postgres: (config: PostgresPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', config.connectionString],
  }),

  sqlite: (config: SqlitePresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', config.dbPath],
  }),

  slack: (config: SlackPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: {
      SLACK_BOT_TOKEN: config.botToken,
      ...(config.teamId ? { SLACK_TEAM_ID: config.teamId } : {}),
    },
  }),

  googleDrive: (config: GoogleDrivePresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-drive'],
    ...(config.credentials ? { env: { GOOGLE_APPLICATION_CREDENTIALS: config.credentials } } : {}),
  }),

  googleMaps: (config: GoogleMapsPresetConfig): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: config.apiKey },
  }),

  everart: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everart'],
  }),

  sequentialThinking: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
  }),

  everything: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
  }),

  time: (): McpStdioServerConfig => ({
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-time'],
  }),
} as const;

export type McpPresetName = keyof typeof mcpPresets;

type PresetConfigMap = {
  filesystem: FilesystemPresetConfig;
  github: GithubPresetConfig;
  braveSearch: BraveSearchPresetConfig;
  memory: void;
  puppeteer: void;
  fetch: void;
  postgres: PostgresPresetConfig;
  sqlite: SqlitePresetConfig;
  slack: SlackPresetConfig;
  googleDrive: GoogleDrivePresetConfig;
  googleMaps: GoogleMapsPresetConfig;
  everart: void;
  sequentialThinking: void;
  everything: void;
  time: void;
};

export const createMcpFromPreset = <K extends McpPresetName>(
  presetName: K,
  config: PresetConfigMap[K],
  clientOptions?: McpClientOptions
): McpClient => {
  const presetFn = mcpPresets[presetName] as (config: PresetConfigMap[K]) => McpStdioServerConfig;
  const serverConfig = presetFn(config);
  const transport = new McpJsonRpcStdioTransport(serverConfig);
  return new McpClient(transport, clientOptions);
};

export function listMcpPresetNames(): McpPresetName[] {
  return Object.keys(mcpPresets) as McpPresetName[];
}

/** Env vars required for each preset to be considered "available". */
const presetRequiredEnvVars: Partial<Record<McpPresetName, string[]>> = {
  github: ['GITHUB_PERSONAL_ACCESS_TOKEN', 'GITHUB_TOKEN'],
  braveSearch: ['BRAVE_API_KEY'],
  slack: ['SLACK_BOT_TOKEN'],
  googleMaps: ['GOOGLE_MAPS_API_KEY'],
};

/** Check if the command/binary for a preset is available */
export async function verifyPresetAvailability(presetName: string): Promise<{
  available: boolean;
  command: string;
  error?: string;
}> {
  if (!(presetName in mcpPresets)) {
    return { available: false, command: '', error: `Unknown preset: ${presetName}` };
  }

  const name = presetName as McpPresetName;

  // All current presets use npx — check if npx exists
  const command = 'npx';
  const commandExists = await new Promise<boolean>((resolve) => {
    execFile('which', [command], (error) => {
      resolve(!error);
    });
  });

  if (!commandExists) {
    return { available: false, command, error: `Command '${command}' not found` };
  }

  // Check required env vars (any one of the alternatives must be set)
  const requiredVars = presetRequiredEnvVars[name];
  if (requiredVars && requiredVars.length > 0) {
    const anySet = requiredVars.some((v) => Boolean(process.env[v]));
    if (!anySet) {
      return {
        available: false,
        command,
        error: `${requiredVars.join(' or ')} not set`,
      };
    }
  }

  return { available: true, command };
}

export function getMcpPresetDescription(name: McpPresetName): string {
  const descriptions: Record<McpPresetName, string> = {
    filesystem: 'Access local filesystem with configurable allowed directories',
    github: 'GitHub repository management — issues, PRs, files, search',
    braveSearch: 'Web search via Brave Search API',
    memory: 'Persistent memory using a local knowledge graph',
    puppeteer: 'Browser automation via Puppeteer',
    fetch: 'HTTP fetch with robots.txt compliance',
    postgres: 'Query and manage PostgreSQL databases',
    sqlite: 'Query and manage SQLite databases',
    slack: 'Slack workspace integration — channels, messages, users',
    googleDrive: 'Google Drive file management',
    googleMaps: 'Google Maps geocoding and place search',
    everart: 'AI image generation via EverArt',
    sequentialThinking: 'Dynamic problem-solving through sequential thinking',
    everything: 'Test server with all MCP features (for development)',
    time: 'Current time and timezone conversions',
  };
  return descriptions[name];
}

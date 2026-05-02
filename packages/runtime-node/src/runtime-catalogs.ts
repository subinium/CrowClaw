import type { McpServerConfig } from './config-store.js';

export interface RuntimePluginCatalogEntry {
  slug: string;
  manifest: {
    name: string;
    version?: string;
    description?: string;
    author?: string;
    repo?: string;
    hooks?: string[];
    tools?: string[];
    defaultConfigSchema?: Record<string, unknown>;
    permissions?: {
      tools?: string[];
      memory?: 'none' | 'read' | 'write' | 'readwrite';
      network?: boolean;
    };
  };
  source: 'builtin' | 'community';
}

export interface McpCatalogEnvVar {
  description: string;
  required: boolean;
  secret?: boolean;
}

export interface McpCatalogEntry {
  slug: string;
  name: string;
  description: string;
  runtime: 'npx' | 'uvx';
  package: string;
  args: string[];
  env?: Record<string, McpCatalogEnvVar>;
  permissions: string[];
  sha256?: string;
  repo?: string;
}

export const BUILTIN_PLUGIN_CATALOG: RuntimePluginCatalogEntry[] = [
  {
    slug: 'memory-capture',
    source: 'builtin',
    manifest: {
      name: 'memory-capture',
      version: '0.8.1',
      description: 'Captures agent lifecycle events for memory-aware runs.',
      author: 'CrowClaw',
      hooks: ['agent:beforeRun', 'agent:afterRun'],
      permissions: { memory: 'write' },
    },
  },
  {
    slug: 'reference-pre-tool-call',
    source: 'builtin',
    manifest: {
      name: 'reference-pre-tool-call',
      version: '0.8.1',
      description: 'Reference pre-tool-call veto plugin for policy authors.',
      author: 'CrowClaw',
      hooks: ['tool:preExecute'],
      permissions: { tools: ['workspace.read'] },
      defaultConfigSchema: {
        type: 'object',
        properties: {
          denyTools: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
  {
    slug: 'reference-tool-result',
    source: 'builtin',
    manifest: {
      name: 'reference-tool-result',
      version: '0.8.1',
      description: 'Reference tool-result transform plugin for metadata enrichment.',
      author: 'CrowClaw',
      hooks: ['tool:transformResult'],
      permissions: { tools: ['workspace.read'] },
    },
  },
];

export const BUILTIN_MCP_CATALOG: McpCatalogEntry[] = [
  {
    slug: 'filesystem',
    name: 'Filesystem',
    description: 'Read and edit files in explicitly allowed directories.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-filesystem',
    args: ['${WORKSPACE_DIR}'],
    env: {
      WORKSPACE_DIR: { description: 'Directory the server may access.', required: true },
    },
    permissions: ['filesystem:read', 'filesystem:write'],
    repo: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'git',
    name: 'Git',
    description: 'Inspect repository history and working tree state.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-git',
    args: ['--repository', '${REPOSITORY_DIR}'],
    env: {
      REPOSITORY_DIR: { description: 'Repository directory.', required: true },
    },
    permissions: ['git:read'],
    repo: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'github',
    name: 'GitHub',
    description: 'Work with GitHub repositories, issues, and pull requests.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-github',
    args: [],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: { description: 'GitHub token used by the MCP server.', required: true, secret: true },
    },
    permissions: ['network:github', 'secrets:github-token'],
    repo: 'https://github.com/modelcontextprotocol/servers',
  },
  {
    slug: 'slack',
    name: 'Slack',
    description: 'Search and send Slack workspace messages.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-slack',
    args: [],
    env: {
      SLACK_BOT_TOKEN: { description: 'Slack bot token.', required: true, secret: true },
      SLACK_TEAM_ID: { description: 'Slack team ID.', required: true },
    },
    permissions: ['network:slack', 'secrets:slack-token'],
  },
  {
    slug: 'postgres',
    name: 'Postgres',
    description: 'Query a PostgreSQL database through MCP.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-postgres',
    args: ['${DATABASE_URL}'],
    env: {
      DATABASE_URL: { description: 'Postgres connection string.', required: true, secret: true },
    },
    permissions: ['database:read', 'secrets:database-url'],
  },
  {
    slug: 'sqlite',
    name: 'SQLite',
    description: 'Query a local SQLite database file.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-sqlite',
    args: ['${SQLITE_PATH}'],
    env: {
      SQLITE_PATH: { description: 'SQLite database path.', required: true },
    },
    permissions: ['database:read'],
  },
  {
    slug: 'brave-search',
    name: 'Brave Search',
    description: 'Search the web through Brave Search.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-brave-search',
    args: [],
    env: {
      BRAVE_API_KEY: { description: 'Brave Search API key.', required: true, secret: true },
    },
    permissions: ['network:web-search', 'secrets:brave-api-key'],
  },
  {
    slug: 'fetch',
    name: 'Fetch',
    description: 'Fetch and transform web pages.',
    runtime: 'uvx',
    package: 'mcp-server-fetch',
    args: [],
    permissions: ['network:http'],
  },
  {
    slug: 'playwright',
    name: 'Playwright',
    description: 'Automate browser flows for local and remote pages.',
    runtime: 'npx',
    package: '@playwright/mcp',
    args: [],
    permissions: ['browser:automation', 'network:http'],
  },
  {
    slug: 'puppeteer',
    name: 'Puppeteer',
    description: 'Automate Chromium browser sessions.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-puppeteer',
    args: [],
    permissions: ['browser:automation', 'network:http'],
  },
  {
    slug: 'memory',
    name: 'Memory',
    description: 'Store and retrieve local structured memories.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-memory',
    args: [],
    permissions: ['memory:read', 'memory:write'],
  },
  {
    slug: 'time',
    name: 'Time',
    description: 'Provide timezone and wall-clock utilities.',
    runtime: 'uvx',
    package: 'mcp-server-time',
    args: [],
    permissions: ['time:read'],
  },
  {
    slug: 'linear',
    name: 'Linear',
    description: 'Read and update Linear issues.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-linear',
    args: [],
    env: {
      LINEAR_API_KEY: { description: 'Linear API key.', required: true, secret: true },
    },
    permissions: ['network:linear', 'secrets:linear-api-key'],
  },
  {
    slug: 'notion',
    name: 'Notion',
    description: 'Search and update Notion pages.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-notion',
    args: [],
    env: {
      NOTION_API_KEY: { description: 'Notion integration token.', required: true, secret: true },
    },
    permissions: ['network:notion', 'secrets:notion-api-key'],
  },
  {
    slug: 'redis',
    name: 'Redis',
    description: 'Inspect Redis keys and values.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-redis',
    args: ['${REDIS_URL}'],
    env: {
      REDIS_URL: { description: 'Redis connection URL.', required: true, secret: true },
    },
    permissions: ['database:read', 'secrets:redis-url'],
  },
  {
    slug: 'sentry',
    name: 'Sentry',
    description: 'Inspect Sentry issues and events.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-sentry',
    args: [],
    env: {
      SENTRY_AUTH_TOKEN: { description: 'Sentry auth token.', required: true, secret: true },
    },
    permissions: ['network:sentry', 'secrets:sentry-token'],
  },
  {
    slug: 'google-drive',
    name: 'Google Drive',
    description: 'Search Google Drive files exposed to the integration.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-gdrive',
    args: [],
    permissions: ['network:google-drive'],
  },
  {
    slug: 'sequential-thinking',
    name: 'Sequential Thinking',
    description: 'Structured reasoning scratchpad server.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-sequential-thinking',
    args: [],
    permissions: ['local:reasoning'],
  },
  {
    slug: 'aws-kb-retrieval',
    name: 'AWS Knowledge Base',
    description: 'Retrieve documents from an AWS Bedrock Knowledge Base.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-aws-kb-retrieval',
    args: [],
    env: {
      AWS_REGION: { description: 'AWS region.', required: true },
      AWS_ACCESS_KEY_ID: { description: 'AWS access key ID.', required: true, secret: true },
      AWS_SECRET_ACCESS_KEY: { description: 'AWS secret access key.', required: true, secret: true },
    },
    permissions: ['network:aws', 'secrets:aws-credentials'],
  },
  {
    slug: 'everything',
    name: 'Everything',
    description: 'MCP protocol capability demo server for local testing.',
    runtime: 'npx',
    package: '@modelcontextprotocol/server-everything',
    args: [],
    permissions: ['local:test-server'],
  },
];

export function getPluginCatalogEntry(slug: string): RuntimePluginCatalogEntry | undefined {
  return BUILTIN_PLUGIN_CATALOG.find((entry) => entry.slug === slug || entry.manifest.name === slug);
}

export function getMcpCatalogEntry(slug: string): McpCatalogEntry | undefined {
  return BUILTIN_MCP_CATALOG.find((entry) => entry.slug === slug || entry.name === slug);
}

function substituteCatalogArg(arg: string, env: Record<string, string>): string {
  return arg.replace(/\$\{([A-Z0-9_]+)\}/g, (_match, key: string) => env[key] ?? '');
}

export function buildMcpServerConfigFromCatalog(
  entry: McpCatalogEntry,
  env: Record<string, string>,
): McpServerConfig {
  const command = entry.runtime;
  const packageArgs = entry.runtime === 'npx'
    ? ['-y', entry.package]
    : [entry.package];
  return {
    name: entry.slug,
    command,
    args: [...packageArgs, ...entry.args.map((arg) => substituteCatalogArg(arg, env)).filter(Boolean)],
    env: Object.keys(env).length > 0 ? env : undefined,
    description: entry.description,
    custom: false,
    catalogSlug: entry.slug,
    repo: entry.repo,
  };
}

export function validateMcpCatalogEnv(entry: McpCatalogEntry, env: Record<string, string>): string[] {
  const errors: string[] = [];
  for (const [key, schema] of Object.entries(entry.env ?? {})) {
    if (schema.required && !env[key]?.trim()) {
      errors.push(`${key} is required`);
    }
  }
  return errors;
}

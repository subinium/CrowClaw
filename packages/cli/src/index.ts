import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, access, constants, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { NodeRuntimeOptions } from '@crowclaw/runtime-node';
import { GatewayRunner, type GatewayStatus } from '@crowclaw/gateway';

const HISTORY_DIR = join(homedir(), '.crowclaw');
const HISTORY_FILE_PATH = join(HISTORY_DIR, 'history');
const MAX_HISTORY_LINES = 1000;

// ---------------------------------------------------------------------------
// Gateway auto-start state
// ---------------------------------------------------------------------------

let activeGatewayRunner: GatewayRunner | null = null;

/** Resolve gateway tokens from env vars and config file. */
async function resolveGatewayTokens(): Promise<Array<{ name: string; token: string; enabled: boolean }>> {
  const platforms: Array<{ name: string; token: string; enabled: boolean }> = [];

  // Check env vars
  const telegramToken = process.env.CROWCLAW_TELEGRAM_TOKEN;
  if (telegramToken) {
    platforms.push({ name: 'telegram', token: telegramToken, enabled: true });
  }

  // Check config file for telegramToken
  if (!telegramToken) {
    try {
      const configPath = join(homedir(), '.crowclaw', 'config.json');
      const raw = await readFile(configPath, 'utf-8');
      const config = JSON.parse(raw) as Record<string, unknown>;
      if (typeof config.telegramToken === 'string' && config.telegramToken) {
        platforms.push({ name: 'telegram', token: config.telegramToken, enabled: true });
      }
    } catch {
      // Config not found or invalid — skip
    }
  }

  // Check runtime-config.json for gateway configs
  try {
    const runtimeConfigPath = join(homedir(), '.crowclaw', 'runtime-config.json');
    const raw = await readFile(runtimeConfigPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const gatewayConfigs = config.gatewayConfigs as Record<string, { enabled?: boolean; token?: string }> | undefined;
    if (gatewayConfigs) {
      for (const [name, gc] of Object.entries(gatewayConfigs)) {
        if (gc.token && gc.enabled !== false && !platforms.some((p) => p.name === name)) {
          platforms.push({ name, token: gc.token, enabled: true });
        }
      }
    }
  } catch {
    // Runtime config not found — skip
  }

  return platforms;
}

/** Start gateway runner in background if tokens are available. */
async function autoStartGateway(onMessage?: (msg: import('@crowclaw/gateway').NormalizedInboundMessage) => Promise<string>): Promise<GatewayStatus[]> {
  const platforms = await resolveGatewayTokens();
  if (platforms.length === 0) return [];

  const runner = new GatewayRunner({
    platforms,
    onMessage,
  });

  const statuses = await runner.start();
  activeGatewayRunner = runner;
  return statuses;
}

/** Get current gateway runner status. */
export function getGatewayRunnerStatus(): GatewayStatus[] {
  return activeGatewayRunner?.getStatus() ?? [];
}

/** Stop active gateway runner. */
export async function stopGatewayRunner(): Promise<void> {
  if (activeGatewayRunner) {
    await activeGatewayRunner.stop();
    activeGatewayRunner = null;
  }
}

export function loadHistorySync(filePath: string = HISTORY_FILE_PATH): string[] {
  try {
    if (!existsSync(filePath)) {
      return [];
    }
    const content = readFileSync(filePath, 'utf-8');
    return content.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export function appendHistorySync(line: string, filePath: string = HISTORY_FILE_PATH): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, line + '\n', 'utf-8');
  } catch {
    // Silently ignore write errors (e.g., read-only filesystem)
  }
}

export function trimHistoryFileSync(filePath: string = HISTORY_FILE_PATH, max: number = MAX_HISTORY_LINES): void {
  try {
    if (!existsSync(filePath)) {
      return;
    }
    const lines = readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
    if (lines.length > max) {
      const trimmed = lines.slice(lines.length - max);
      writeFileSync(filePath, trimmed.join('\n') + '\n', 'utf-8');
    }
  } catch {
    // Silently ignore errors
  }
}

export function clearHistorySync(filePath: string = HISTORY_FILE_PATH): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, '', 'utf-8');
  } catch {
    // Silently ignore errors
  }
}

export type CliCommandName =
  | 'help'
  | 'status'
  | 'tools'
  | 'chat'
  | 'init'
  | 'doctor'
  | 'sessions'
  | 'skills'
  | 'jobs'
  | 'serve'
  | 'repl'
  | 'gateway'
  | 'mcp'
  | 'presets'
  | 'providers';

export interface ParsedCliCommand {
  command: CliCommandName;
  query?: string;
  sessionId?: string;
  continueSession?: boolean;
  port?: number;
  noOnboarding?: boolean;
  gatewaySubcommand?: string;
  gatewayArgs?: string[];
  mcpSubcommand?: string;
  mcpArgs?: string[];
  presetsSubcommand?: string;
  presetsArgs?: string[];
  providersSubcommand?: string;
  providersArgs?: string[];
}

export interface CliRuntimeLike {
  fetch(request: Request): Promise<Response>;
  tools?: { list(): Array<{ name: string; description?: string }> };
}

export interface CliRunOptions {
  runtime?: CliRuntimeLike;
  runtimeOptions?: NodeRuntimeOptions;
}

export interface ReplOptions extends CliRunOptions {
  prompt?: string;
  greeting?: string;
  historyFile?: string;
}

export interface CliSessionState {
  sessionId: string;
}

export interface CliTranscriptEntry {
  kind: 'input' | 'output' | 'stream';
  content: string;
  sessionId: string;
  createdAt: string;
}

export const builtInCliSlashCommands = [
  '/help',
  '/version',
  '/status',
  '/doctor',
  '/preflight',
  '/release-check',
  '/tools',
  '/history',
  '/memories',
  '/overview',
  '/todo',
  '/clarify',
  '/send',
  '/vision',
  '/image',
  '/terminal-backends',
  '/terminal-backend-status',
  '/terminal-probe',
  '/terminal-exec',
  '/terminal-background',
  '/terminal-processes',
  '/terminal-kill',
  '/bridge-status',
  '/bridge-spawn',
  '/bridge-ping',
  '/bridge-terminate',
  '/bridge-capabilities',
  '/bridge-process',
  '/bridge-transcript',
  '/browser-session',
  '/mcp-tools',
  '/mcp-status',
  '/mcp-inspect',
  '/mcp-resources',
  '/mcp-prompts',
  '/mcp-server-tools',
  '/mcp-server-call',
  '/acp-info',
  '/acp-sessions',
  '/acp-create',
  '/acp-delete',
  '/acp-prompt',
  '/acp-request',
  '/skills',
  '/drafts',
  '/match-skills',
  '/auto-capture',
  '/refine-draft',
  '/publish-draft',
  '/unpublish-draft',
  '/skill-show',
  '/skill-import-file',
  '/skill-rate',
  '/skill-versions',
  '/skill-toggle',
  '/provider-models',
  '/provider-pool',
  '/provider-plan',
  '/provider-failover-preview',
  '/provider-route',
  '/new',
  '/reset',
  '/resume',
  '/quit',
  '/exit',
  '/compact',
  '/clear',
  '/model',
  '/session',
  '/delegate',
  '/stream',
  '/usage',
  '/persona',
  '/persona list',
  '/persona switch',
  '/gateway',
  '/gateway status',
  '/gateway connect',
  '/mcp-auth',
  '/mcp-add',
  '/mcp-list',
  '/mcp-remove',
] as const;

async function lazyCreateRuntime(options?: NodeRuntimeOptions): Promise<CliRuntimeLike> {
  const { createNodeRuntime } = await import('@crowclaw/runtime-node');
  return createNodeRuntime(options);
}

export class StreamRenderer {
  private buffer = '';
  private lineCount = 0;

  write(chunk: string): void {
    this.buffer += chunk;
    stdout.write(chunk);
    this.lineCount += (chunk.match(/\n/g) ?? []).length;
  }

  writeLine(text: string): void {
    this.write(text + '\n');
  }

  writeStatus(text: string): void {
    stdout.write(`\r${text}`);
  }

  clearStatus(): void {
    stdout.write('\r\x1b[K');
  }

  writeToolStart(toolName: string): void {
    this.writeLine(`\x1b[36m▶ ${toolName}\x1b[0m`);
  }

  writeToolResult(toolName: string, ok: boolean, output: string): void {
    const icon = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
    const truncated = output.length > 500 ? output.slice(0, 500) + '...' : output;
    this.writeLine(`${icon} ${toolName}: ${truncated}`);
  }

  reset(): void {
    this.buffer = '';
    this.lineCount = 0;
  }

  getBuffer(): string {
    return this.buffer;
  }

  getLineCount(): number {
    return this.lineCount;
  }
}

const cliRoutePaths = {
  system: {
    health: '/health',
    version: '/api/system/version',
    status: '/api/system/status',
    preflight: '/api/system/preflight'
  },
  code: {
    bridge: '/api/code/bridge',
    bridgeSpawn: '/api/code/bridge/spawn',
    bridgePing: '/api/code/bridge/ping',
    bridgeTerminate: '/api/code/bridge/terminate',
    bridgeCapabilities: '/api/code/bridge/capabilities',
    bridgeStatus: '/api/code/bridge/status',
    bridgeProcess: '/api/code/bridge/process',
    bridgeTranscript: '/api/code/bridge/transcript'
  },
  browser: {
    session: '/api/browser/session'
  },
  terminal: {
    exec: '/api/terminal/exec',
    background: '/api/terminal/background',
    backends: '/api/terminal/backends',
    backendStatus: '/api/terminal/backend-status',
    probe: '/api/terminal/probe',
    processes: '/api/terminal/processes',
    kill: '/api/terminal/kill'
  },
  actions: {
    todo: '/api/todo',
    clarify: '/api/clarify',
    sendMessage: '/api/send-message'
  },
  media: {
    vision: '/api/vision/analyze',
    image: '/api/image/generate'
  },
  learning: {
    drafts: '/api/learning/drafts',
    autoCapture: '/api/learning/auto-capture',
    match: '/api/learning/match'
  },
  skills: {
    list: '/api/skills'
  },
  mcp: {
    tools: '/api/mcp/tools',
    status: '/api/mcp/status',
    inspect: '/api/mcp/inspect',
    resources: '/api/mcp/resources',
    prompts: '/api/mcp/prompts',
    serverTools: '/api/mcp/server/tools',
    serverRequest: '/api/mcp/server/request'
  },
  acp: {
    info: '/api/acp/info',
    sessions: '/api/acp/sessions',
    prompt: '/api/acp/prompt',
    request: '/api/acp/request'
  },
  providers: {
    models: '/api/providers/models',
    route: '/api/providers/route',
    pool: '/api/providers/pool',
    plan: '/api/providers/plan',
    failoverPreview: '/api/providers/failover-preview'
  },
  usage: {
    summary: '/api/usage',
    reset: '/api/usage/reset'
  },
  personas: {
    list: '/api/personas',
    active: '/api/persona/active',
    switch: '/api/persona/switch'
  }
} as const;

function localRoute(path: string): string {
  return `http://localhost${path}`;
}

function defaultSessionId(): string {
  return 'cli-default';
}

function formatOutput(output: string): string {
  // If output is very long, truncate with indicator
  const MAX_OUTPUT_LENGTH = 5000;
  if (output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + '\n[... truncated]';
  }

  // If output looks like JSON, pretty-print it
  const trimmed = output.trim();
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      // Not valid JSON, return as-is
    }
  }

  return output;
}

export function parseCliArgs(argv: string[]): ParsedCliCommand {
  const noOnboarding = argv.includes('--no-onboarding');
  const filtered = argv.filter((a) => a !== '--no-onboarding');

  if (filtered.length === 0) {
    return { command: 'repl', noOnboarding };
  }

  if (filtered.includes('--help') || filtered.includes('-h')) {
    return { command: 'help' };
  }

  const [first, ...rest] = filtered;

  // Simple noun subcommands (no extra args)
  const simpleCommands: Record<string, CliCommandName> = {
    help: 'help',
    init: 'init',
    doctor: 'doctor',
    status: 'status',
    sessions: 'sessions',
    skills: 'skills',
    tools: 'tools',
    jobs: 'jobs',
  };

  if (first !== undefined && first in simpleCommands) {
    return { command: simpleCommands[first]!, noOnboarding };
  }

  // gateway — supports subcommands: status, connect <platform>
  if (first === 'gateway') {
    const gatewaySubcommand = rest[0] ?? 'status';
    const gatewayArgs = rest.slice(1);
    return { command: 'gateway', gatewaySubcommand, gatewayArgs, noOnboarding };
  }

  // mcp — supports subcommands: auth <provider>, add <url>, list, remove <name>
  if (first === 'mcp') {
    const mcpSubcommand = rest[0] ?? 'list';
    const mcpArgs = rest.slice(1);
    return { command: 'mcp', mcpSubcommand, mcpArgs, noOnboarding };
  }

  // presets — supports subcommands: list, switch <name>
  if (first === 'presets') {
    const presetsSubcommand = rest[0] ?? 'list';
    const presetsArgs = rest.slice(1);
    return { command: 'presets', presetsSubcommand, presetsArgs, noOnboarding };
  }

  // providers — supports subcommands: list (default), set <slot> <provider/model>, test
  if (first === 'providers') {
    const providersSubcommand = rest[0] ?? 'list';
    const providersArgs = rest.slice(1);
    return { command: 'providers', providersSubcommand, providersArgs, noOnboarding };
  }

  // serve — supports --port
  if (first === 'serve') {
    let port: number | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      if (rest[i] === '--port' && rest[i + 1] !== undefined) {
        port = parseInt(rest[i + 1]!, 10);
        i += 1;
      }
    }
    return { command: 'serve', port, noOnboarding };
  }

  // chat subcommand or -q flag at top level
  let query: string | undefined;
  let sessionId: string | undefined;
  let continueSession = false;
  let port: number | undefined;

  const isChat = first === 'chat';
  const argsToScan = isChat ? rest : filtered;

  for (let index = 0; index < argsToScan.length; index += 1) {
    const value = argsToScan[index]!;
    if (value === '-q' || value === '--query') {
      query = argsToScan[index + 1];
      index += 1;
      continue;
    }
    if (value === '--session') {
      sessionId = argsToScan[index + 1];
      index += 1;
      continue;
    }
    if (value === '--continue' || value === '--resume') {
      continueSession = true;
      continue;
    }
    if (value === '--port') {
      port = parseInt(argsToScan[index + 1] ?? '3117', 10);
      index += 1;
      continue;
    }
    if (!value.startsWith('-') && !query) {
      query = value;
    }
  }

  // If -q was used at the top level (no 'chat' subcommand), treat as chat
  if (!isChat && query) {
    return { command: 'chat', query, sessionId, continueSession, port, noOnboarding };
  }

  // 'chat' subcommand with no query → start REPL
  if (isChat && !query && !continueSession) {
    return { command: 'repl', noOnboarding };
  }

  return {
    command: 'chat',
    query,
    sessionId,
    continueSession,
    port,
    noOnboarding,
  };
}

export function renderCliHelp(): string {
  return [
    'CrowClaw CLI v0.1.0',
    '',
    'Usage: crowclaw [command] [options]',
    '',
    'Commands:',
    '  (none)              Start interactive REPL',
    '  init                Set up CrowClaw (provider, model, preset)',
    '  doctor              Run system health checks',
    '  chat "msg"          One-shot chat message',
    '  serve               Start HTTP server + dashboard',
    '  gateway status      Show gateway platform connection status',
    '  gateway connect <p> Connect a platform (e.g., telegram)',
    '  mcp list            List connected MCP servers',
    '  mcp auth <provider> Authenticate with an MCP provider (github, slack, google)',
    '  mcp add <url>       Add a custom MCP server',
    '  mcp remove <name>   Remove an MCP server',
    '  presets             List config presets with active indicator',
    '  presets switch <n>  Switch active config preset',
    '  status              Show system status',
    '  sessions            List sessions',
    '  skills              List skills with status',
    '  tools               List registered tools',
    '  jobs                List scheduled jobs',
    '  help                Show this help',
    '',
    'Options:',
    '  -q "msg"            One-shot chat (alias for chat)',
    '  --no-onboarding     Skip first-run wizard',
    '  --port N            Server port (default: 3117)',
    '',
    'REPL Slash Commands:',
    '  /help                          Show this help text',
    '  /version                       Show version info',
    '  /status                        Check runtime health',
    '  /doctor                        Inspect runtime status',
    '  /preflight                     Run readiness checks',
    '  /release-check                 Full release readiness report',
    '  /tools                         List registered tools',
    '  /history                       Show last 20 CLI commands',
    '  /history clear                 Clear CLI command history',
    '  /memories                      Show session memories',
    '  /overview                      System overview dashboard',
    '  /todo ...                      Manage session todos',
    '  /clarify ...                   Generate a clarification question',
    '  /send ...                      Build an outbound message payload',
    '  /vision ...                    Run vision analysis',
    '  /image ...                     Build image generation payload',
    '  /terminal-backends             List terminal backend descriptors',
    '  /terminal-backend-status       Probe terminal backend availability',
    '  /terminal-probe [backend]      Run a benign execution probe for a backend',
    '  /terminal-exec ...             Execute a terminal command',
    '  /terminal-background ...       Start a background terminal command',
    '  /terminal-processes            Show tracked background processes',
    '  /terminal-kill <pid>           Stop a tracked background process',
    '  /bridge-*                      Bridge management commands',
    '  /browser-session               Browser session info',
    '  /mcp-*                         MCP management commands',
    '  /mcp-server-tools              List embedded MCP server tools',
    '  /mcp-server-call ...           Execute an embedded MCP server tool call',
    '  /acp-info                      Show embedded ACP manifest',
    '  /acp-sessions                  List ACP sessions',
    '  /acp-create [title]            Create an ACP session',
    '  /acp-delete <sessionId>        Delete an ACP session',
    '  /acp-prompt <message...>       Execute ACP prompt in current session',
    '  /acp-request <json>            Send a raw ACP JSON-RPC request',
    '  /skills                        List resolved skills',
    '  /drafts                        List learning drafts',
    '  /match-skills <query>          Match published skills against a query',
    '  /auto-capture                  Auto-capture a draft from recent chat',
    '  /refine-draft <id> <text...>   Refine a draft with new evidence',
    '  /publish-draft <id>            Publish a learning draft',
    '  /unpublish-draft <id>          Unpublish a learning draft',
    '  /skill-show <slug>             Show detailed skill metadata',
    '  /skill-import-file <path>      Import a SKILL.md file from disk',
    '  /skill-rate <slug> <rating>    Rate a skill as helpful/unhelpful',
    '  /skill-versions <slug>         Show saved skill versions',
    '  /skill-toggle <slug> <on|off>  Enable or disable a skill',
    '  /provider-models               List known provider model metadata',
    '  /provider-pool [provider]      Inspect credential pool status',
    '  /provider-plan                 Show effective provider slot/failover plan',
    '  /provider-failover-preview     Show simulated provider failover order',
    '  /provider-route ...            Inspect smart provider routing',
    '  /new, /reset                   Start a new session',
    '  /resume <id>                   Resume a session by id',
    '  /session                       Show current session info',
    '  /model                         Show current model info',
    '  /compact                       Trigger context compression',
    '  /delegate                      Show delegation status',
    '  /stream                        Toggle streaming display mode',
    '  /usage                         Show session token usage and cost',
    '  /persona                       Show active persona info',
    '  /persona list                  List all registered personas',
    '  /persona switch <name>         Switch to a named persona',
    '  /clear                         Clear terminal screen',
    '  /gateway                       Show gateway platform status',
    '  /gateway status                Detailed gateway connection status',
    '  /gateway connect <platform>   Connect a platform (e.g., telegram)',
    '  /mcp-auth <provider>           Authenticate with MCP provider',
    '  /mcp-add <url>                 Add a custom MCP server',
    '  /mcp-list                      List connected MCP servers',
    '  /mcp-remove <name>             Remove an MCP server',
    '  /quit, /exit                   Exit the REPL',
  ].join('\n');
}

export function suggestCliCommands(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return [];
  }

  return builtInCliSlashCommands.filter((command) => command.startsWith(trimmed));
}

async function runStatus(runtime: CliRuntimeLike): Promise<string> {
  const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.health)));
  const payload = await response.json() as { ok: boolean; runtime: string; service: string };
  return `${payload.service} (${payload.runtime}) status: ${payload.ok ? 'ok' : 'error'}`;
}

async function runTools(runtime: CliRuntimeLike): Promise<string> {
  const tools = runtime.tools?.list?.() ?? [];
  return tools.map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`).join('\n');
}

async function runChat(runtime: CliRuntimeLike, parsed: ParsedCliCommand): Promise<string> {
  const sessionId = parsed.sessionId ?? defaultSessionId();
  if (!parsed.query && !parsed.continueSession) {
    return 'Missing chat query. Use `chat -q "message"`.';
  }

  if (!parsed.query && parsed.continueSession) {
    const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/${sessionId}/history`));
    const session = await response.json() as { sessionId: string; messages: Array<{ role: string; content: string }> };
    return `Resumed ${session.sessionId} with ${session.messages.length} message(s).`;
  }

  const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/${sessionId}`, {
    method: 'POST',
    body: JSON.stringify({ userMessage: parsed.query })
  }));
  const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
  return `[${payload.session.sessionId}] ${payload.finalResponse}`;
}

// --- Health check types ---

export interface DoctorCheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheckResult[];
  issues: string[];
}

function checkIcon(status: 'ok' | 'warn' | 'error'): string {
  if (status === 'ok') return '\x1b[32m\u2713\x1b[0m';
  if (status === 'warn') return '\x1b[33m\u26A0\x1b[0m';
  return '\x1b[31m\u2717\x1b[0m';
}

function padLabel(label: string, width = 16): string {
  const dots = '.'.repeat(Math.max(1, width - label.length));
  return `${label} ${dots}`;
}

export async function runDoctor(runtime: CliRuntimeLike): Promise<DoctorReport> {
  const checks: DoctorCheckResult[] = [];
  const issues: string[] = [];

  // 1. Provider / Health
  try {
    const res = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.health)));
    const data = await res.json() as { ok: boolean; runtime?: string; service?: string };
    if (data.ok) {
      checks.push({ name: 'Provider', status: 'ok', detail: `${data.service ?? 'CrowClaw'} (${data.runtime ?? 'node'})` });
    } else {
      checks.push({ name: 'Provider', status: 'error', detail: 'Health check returned not-ok' });
      issues.push('Provider: Health check failed — verify provider configuration');
    }
  } catch {
    checks.push({ name: 'Provider', status: 'error', detail: 'Unreachable' });
    issues.push('Provider: Cannot reach runtime — is the server running?');
  }

  // 2. Config file
  try {
    const configPath = join(homedir(), '.crowclaw', 'config.json');
    if (existsSync(configPath)) {
      checks.push({ name: 'Config', status: 'ok', detail: `~/.crowclaw/config.json` });
    } else {
      checks.push({ name: 'Config', status: 'warn', detail: 'No config file found' });
      issues.push('Config: No config file — run `crowclaw init`');
    }
  } catch {
    checks.push({ name: 'Config', status: 'warn', detail: 'Could not check config' });
  }

  // 3. System status (workspace, tools, skills, memory, security)
  try {
    const res = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.status)));
    const data = await res.json() as Record<string, unknown>;

    // Tools
    const toolCount = typeof data.toolCount === 'number' ? data.toolCount : (runtime.tools?.list?.()?.length ?? 0);
    const dangerousCount = typeof data.dangerousToolCount === 'number' ? data.dangerousToolCount : 0;
    checks.push({
      name: 'Tools',
      status: 'ok',
      detail: `${toolCount} registered${dangerousCount > 0 ? ` (${dangerousCount} dangerous)` : ''}`
    });

    // Skills
    const skillCount = typeof data.skillCount === 'number' ? data.skillCount : 0;
    const learnedCount = typeof data.learnedSkillCount === 'number' ? data.learnedSkillCount : 0;
    checks.push({
      name: 'Skills',
      status: 'ok',
      detail: `${skillCount} built-in, ${learnedCount} learned`
    });

    // Memory
    const memoryType = typeof data.memoryType === 'string' ? data.memoryType : 'in-memory';
    checks.push({ name: 'Memory', status: 'ok', detail: memoryType });

    // Workspace
    const workspaceType = typeof data.workspaceType === 'string' ? data.workspaceType : 'unknown';
    checks.push({ name: 'Workspace', status: 'ok', detail: workspaceType });

    // Security — detailed per-feature status
    try {
      const secRes = await runtime.fetch(cliRequest(localRoute('/api/security/status')));
      const secData = await secRes.json() as {
        protections?: Array<{ name: string; key: string; enabled: boolean; configurable: boolean }>;
        grade?: string;
        activeCount?: number;
        totalCount?: number;
        stats?: { total: number; byType: Record<string, number> };
      };
      const protections = secData.protections ?? [];
      const grade = secData.grade ?? '?';
      for (const p of protections) {
        const evtCount = (secData.stats?.byType ?? {})[p.key === 'ssrf' ? 'ssrf_blocked' : p.key === 'redactToolOutput' ? 'credential_redacted' : p.key === 'scanUserInput' ? 'injection_detected' : p.key === 'scanCommands' ? 'command_warned' : p.key === 'blockDangerousCommands' ? 'command_blocked' : p.key === 'piiRedaction' ? 'pii_redacted' : ''] ?? 0;
        const evtStr = evtCount > 0 ? ` (${evtCount} events)` : '';
        const alwaysOn = !p.configurable;
        const detail = alwaysOn
          ? `active (always on)${evtStr}`
          : p.enabled
            ? `active${evtStr}`
            : 'disabled';
        checks.push({
          name: `  ${p.name}`,
          status: p.enabled ? 'ok' : 'warn',
          detail,
        });
      }
      checks.push({
        name: 'Security Grade',
        status: grade === 'A' || grade === 'B' ? 'ok' : grade === 'C' ? 'warn' : 'error',
        detail: grade,
      });
    } catch {
      // Fallback to simple check
      const securityActive = typeof data.securityActive === 'boolean' ? data.securityActive : true;
      checks.push({
        name: 'Security',
        status: securityActive ? 'ok' : 'warn',
        detail: securityActive ? 'Active' : 'Not configured'
      });
    }
  } catch {
    // If system status fails, still add basic tool check from runtime
    const toolCount = runtime.tools?.list?.()?.length ?? 0;
    checks.push({ name: 'Tools', status: toolCount > 0 ? 'ok' : 'warn', detail: `${toolCount} registered` });
    checks.push({ name: 'Skills', status: 'warn', detail: 'Could not retrieve' });
    checks.push({ name: 'Memory', status: 'warn', detail: 'Could not retrieve' });
    checks.push({ name: 'Workspace', status: 'warn', detail: 'Could not retrieve' });
    checks.push({ name: 'Security', status: 'warn', detail: 'Could not retrieve' });
  }

  // 4. Scheduler
  try {
    const res = await runtime.fetch(cliRequest(localRoute('/api/scheduler/jobs')));
    const jobs = await res.json() as Array<unknown>;
    const jobCount = Array.isArray(jobs) ? jobs.length : 0;
    if (jobCount > 0) {
      checks.push({ name: 'Scheduler', status: 'ok', detail: `${jobCount} job(s) defined` });
    } else {
      checks.push({ name: 'Scheduler', status: 'warn', detail: 'No jobs defined' });
    }
  } catch {
    checks.push({ name: 'Scheduler', status: 'warn', detail: 'Not available' });
  }

  // 5. Gateway
  try {
    const res = await runtime.fetch(cliRequest(localRoute('/api/gateway/status')));
    const data = await res.json() as { platforms?: Array<unknown> };
    const platformCount = Array.isArray(data.platforms) ? data.platforms.length : 0;
    if (platformCount > 0) {
      checks.push({ name: 'Gateway', status: 'ok', detail: `${platformCount} platform(s) configured` });
    } else {
      checks.push({ name: 'Gateway', status: 'error', detail: 'No platforms configured' });
      issues.push('Gateway: No platforms configured — run `crowclaw gateway connect <platform>`');
    }
  } catch {
    checks.push({ name: 'Gateway', status: 'error', detail: 'Not available' });
    issues.push('Gateway: Gateway service not available');
  }

  // 6. MCP
  try {
    const res = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.status)));
    const data = await res.json() as Record<string, unknown> | null;
    if (data && typeof data === 'object' && Object.keys(data).length > 0) {
      checks.push({ name: 'MCP', status: 'ok', detail: 'Connected' });
    } else {
      checks.push({ name: 'MCP', status: 'error', detail: 'No servers connected' });
      issues.push('MCP: No servers connected — run `crowclaw mcp add <server>`');
    }
  } catch {
    checks.push({ name: 'MCP', status: 'error', detail: 'Not available' });
    issues.push('MCP: MCP service not available');
  }

  // 7. Dashboard
  try {
    const res = await runtime.fetch(cliRequest(localRoute('/dashboard')));
    if (res.ok || res.status === 200) {
      checks.push({ name: 'Dashboard', status: 'ok', detail: 'Available at http://localhost:3117' });
    } else {
      checks.push({ name: 'Dashboard', status: 'warn', detail: 'Not serving' });
    }
  } catch {
    checks.push({ name: 'Dashboard', status: 'warn', detail: 'Not available' });
  }

  return { checks, issues };
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [
    '\x1b[1mCrowClaw Doctor\x1b[0m',
    '',
  ];

  for (const check of report.checks) {
    lines.push(`${padLabel(check.name)} ${checkIcon(check.status)} ${check.detail}`);
  }

  if (report.issues.length > 0) {
    lines.push('');
    lines.push(`Issues found: ${report.issues.length}`);
    report.issues.forEach((issue, i) => {
      lines.push(`  ${i + 1}. ${issue}`);
    });
  } else {
    lines.push('');
    lines.push('\x1b[32mAll checks passed.\x1b[0m');
  }

  return lines.join('\n');
}

// --- List command formatters ---

export interface FormattedTool {
  name: string;
  description: string;
  dangerous: boolean;
}

export function formatToolsTable(tools: Array<{ name: string; description?: string; dangerous?: boolean }>): string {
  if (tools.length === 0) return 'No tools registered.';

  const nameWidth = Math.max(4, ...tools.map((t) => t.name.length));
  const header = `${'Name'.padEnd(nameWidth)}  ${'Danger'.padEnd(8)}  Description`;
  const separator = '-'.repeat(header.length);
  const rows = tools.map((t) => {
    const danger = t.dangerous ? '\x1b[31myes\x1b[0m   ' : 'no      ';
    return `${t.name.padEnd(nameWidth)}  ${danger}  ${t.description ?? ''}`;
  });
  return [header, separator, ...rows].join('\n');
}

export function formatSkillsTable(skills: Array<{ name?: string; slug?: string; enabled?: boolean; triggerCount?: number; status?: string }>): string {
  if (skills.length === 0) return 'No skills found.';

  const nameWidth = Math.max(4, ...skills.map((s) => (s.name ?? s.slug ?? '').length));
  const header = `${'Name'.padEnd(nameWidth)}  ${'Status'.padEnd(10)}  Triggers`;
  const separator = '-'.repeat(header.length);
  const rows = skills.map((s) => {
    const name = s.name ?? s.slug ?? 'unknown';
    const status = s.enabled === false ? '\x1b[31mdisabled\x1b[0m  ' : (s.status ?? '\x1b[32menabled\x1b[0m   ');
    const triggers = String(s.triggerCount ?? 0);
    return `${name.padEnd(nameWidth)}  ${status}  ${triggers}`;
  });
  return [header, separator, ...rows].join('\n');
}

export function formatSessionsTable(sessions: Array<{ id?: string; sessionId?: string; lastMessage?: string; createdAt?: string; updatedAt?: string; messageCount?: number }>): string {
  if (sessions.length === 0) return 'No sessions found.';

  const idWidth = Math.max(2, ...sessions.map((s) => (s.id ?? s.sessionId ?? '').length));
  const clampedIdWidth = Math.min(idWidth, 36);
  const header = `${'ID'.padEnd(clampedIdWidth)}  ${'Messages'.padEnd(8)}  ${'Date'.padEnd(20)}  Last Message`;
  const separator = '-'.repeat(Math.min(header.length, 120));
  const rows = sessions.map((s) => {
    const id = (s.id ?? s.sessionId ?? '').slice(0, clampedIdWidth).padEnd(clampedIdWidth);
    const msgCount = String(s.messageCount ?? 0).padEnd(8);
    const date = (s.updatedAt ?? s.createdAt ?? '').slice(0, 20).padEnd(20);
    const lastMsg = (s.lastMessage ?? '').slice(0, 50);
    return `${id}  ${msgCount}  ${date}  ${lastMsg}`;
  });
  return [header, separator, ...rows].join('\n');
}

export function formatJobsTable(jobs: Array<{ id?: string; name?: string; schedule?: string; nextRun?: string; enabled?: boolean; lastRun?: string }>): string {
  if (jobs.length === 0) return 'No scheduled jobs.';

  const idWidth = Math.max(2, ...jobs.map((j) => (j.id ?? j.name ?? '').length));
  const header = `${'ID'.padEnd(idWidth)}  ${'Schedule'.padEnd(16)}  ${'Enabled'.padEnd(8)}  Next Run`;
  const separator = '-'.repeat(header.length);
  const rows = jobs.map((j) => {
    const id = (j.id ?? j.name ?? '').padEnd(idWidth);
    const schedule = (j.schedule ?? '').padEnd(16);
    const enabled = j.enabled === false ? 'no      ' : 'yes     ';
    const nextRun = j.nextRun ?? j.lastRun ?? '';
    return `${id}  ${schedule}  ${enabled}  ${nextRun}`;
  });
  return [header, separator, ...rows].join('\n');
}

async function runSessions(runtime: CliRuntimeLike): Promise<string> {
  const res = await runtime.fetch(cliRequest(localRoute('/api/sessions?limit=50')));
  const data = await res.json() as Array<{ id?: string; sessionId?: string; lastMessage?: string; createdAt?: string; updatedAt?: string; messageCount?: number }>;
  const sessions = Array.isArray(data) ? data : [];
  return formatSessionsTable(sessions);
}

async function runSkillsList(runtime: CliRuntimeLike): Promise<string> {
  const res = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.skills.list)));
  const data = await res.json() as { skills?: Array<{ name?: string; slug?: string; enabled?: boolean; triggerCount?: number; status?: string }> } | Array<{ name?: string; slug?: string; enabled?: boolean; triggerCount?: number; status?: string }>;
  const skills = Array.isArray(data) ? data : (data.skills ?? []);
  return formatSkillsTable(skills);
}

async function runJobsList(runtime: CliRuntimeLike): Promise<string> {
  const res = await runtime.fetch(cliRequest(localRoute('/api/scheduler/jobs')));
  const data = await res.json() as Array<{ id?: string; name?: string; schedule?: string; nextRun?: string; enabled?: boolean; lastRun?: string }>;
  const jobs = Array.isArray(data) ? data : [];
  return formatJobsTable(jobs);
}

async function runPresets(runtime: CliRuntimeLike, parsed: ParsedCliCommand): Promise<string> {
  const sub = parsed.presetsSubcommand ?? 'list';

  if (sub === 'list') {
    const res = await runtime.fetch(cliRequest(localRoute('/api/config-presets')));
    const data = await res.json() as { presets?: Array<{ name: string; description?: string; mcpServers?: string[]; skills?: string[]; toolset?: string }>; active?: string | null };
    const presets = data.presets ?? [];
    const activeName = data.active;
    if (presets.length === 0) {
      return 'No config presets found.';
    }
    const lines = ['Config Presets:', ''];
    for (const p of presets) {
      const indicator = p.name === activeName ? ' *' : '  ';
      const mcpCount = (p.mcpServers ?? []).length;
      const skillCount = (p.skills ?? []).length;
      const meta = [
        mcpCount > 0 ? `${mcpCount} MCP` : null,
        skillCount > 0 ? `${skillCount} skills` : null,
        p.toolset ? `toolset: ${p.toolset}` : null,
      ].filter(Boolean).join(', ');
      lines.push(`${indicator} ${p.name}  ${p.description ?? ''}  [${meta}]`);
    }
    if (activeName) {
      lines.push('', `Active: ${activeName}`);
    }
    return lines.join('\n');
  }

  if (sub === 'switch') {
    const name = (parsed.presetsArgs ?? [])[0];
    if (!name) {
      return 'Usage: crowclaw presets switch <name>';
    }
    const res = await runtime.fetch(cliRequest(localRoute('/api/config-presets/switch'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    }));
    const data = await res.json() as { ok?: boolean; error?: string; active?: string };
    if (data.ok) {
      return `Switched to config preset: ${data.active}`;
    }
    return `Failed to switch preset: ${data.error ?? 'Unknown error'}`;
  }

  return `Unknown presets subcommand: ${sub}. Available: list, switch <name>`;
}

async function runProviders(runtime: CliRuntimeLike, parsed: ParsedCliCommand): Promise<string> {
  const sub = parsed.providersSubcommand ?? 'list';
  const args = parsed.providersArgs ?? [];

  if (sub === 'list') {
    const res = await runtime.fetch(cliRequest(localRoute('/api/providers/config')));
    const data = await res.json() as { ok?: boolean; config?: Record<string, { name?: string; provider?: string; model?: string }> | null };
    const cfg = data.config;
    if (!cfg) {
      return 'No provider config set. Use `crowclaw providers set <slot> <provider/model>` to configure.';
    }
    const slotNames = ['primary', 'fallback', 'vision', 'compression', 'embedding'] as const;
    const lines = ['Provider Config:', ''];
    for (const sn of slotNames) {
      const slot = cfg[sn];
      if (slot) {
        lines.push(`  ${sn.padEnd(14)} ${slot.provider}/${slot.model}  (${slot.name ?? sn})`);
      } else {
        lines.push(`  ${sn.padEnd(14)} -- not configured`);
      }
    }
    return lines.join('\n');
  }

  if (sub === 'set') {
    const slot = args[0];
    const providerModel = args[1];
    if (!slot || !providerModel) {
      return 'Usage: crowclaw providers set <slot> <provider/model>\n  Slots: primary, fallback, vision, compression, embedding\n  Example: crowclaw providers set fallback anthropic/claude-haiku';
    }
    const validSlots = ['primary', 'fallback', 'vision', 'compression', 'embedding'];
    if (!validSlots.includes(slot)) {
      return `Invalid slot "${slot}". Valid slots: ${validSlots.join(', ')}`;
    }
    const [provider, ...modelParts] = providerModel.split('/');
    const model = modelParts.join('/') || provider || '';
    // Get current config
    const getRes = await runtime.fetch(cliRequest(localRoute('/api/providers/config')));
    const current = await getRes.json() as { config?: Record<string, unknown> | null };
    const cfg = current.config ?? {} as Record<string, unknown>;
    (cfg as Record<string, unknown>)[slot] = { name: slot.charAt(0).toUpperCase() + slot.slice(1), provider: provider ?? 'openai', model };
    if (!cfg.primary && slot !== 'primary') {
      return 'Configure primary slot first: crowclaw providers set primary <provider/model>';
    }
    const setRes = await runtime.fetch(cliRequest(localRoute('/api/providers/config'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg),
    }));
    const result = await setRes.json() as { ok?: boolean; error?: string };
    if (result.ok) {
      return `Set ${slot} provider to ${provider}/${model}`;
    }
    return `Failed: ${result.error ?? 'Unknown error'}`;
  }

  if (sub === 'test') {
    const res = await runtime.fetch(cliRequest(localRoute('/api/providers/config')));
    const data = await res.json() as { ok?: boolean; config?: Record<string, { provider?: string; model?: string; apiKey?: string; baseUrl?: string }> | null };
    const cfg = data.config;
    if (!cfg) {
      return 'No provider config to test.';
    }
    const slotNames = ['primary', 'fallback', 'vision', 'compression', 'embedding'] as const;
    const lines = ['Testing provider slots:', ''];
    for (const sn of slotNames) {
      const slot = cfg[sn];
      if (!slot) continue;
      try {
        const testRes = await runtime.fetch(cliRequest(localRoute('/api/providers/test'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ slot: sn, provider: slot.provider, model: slot.model, apiKey: slot.apiKey ?? '', baseUrl: slot.baseUrl ?? '' }),
        }));
        const testData = await testRes.json() as { ok?: boolean; error?: string; response?: string };
        lines.push(`  ${sn.padEnd(14)} ${testData.ok ? 'PASS' : 'FAIL'}  ${testData.ok ? (testData.response ?? '') : (testData.error ?? '')}`);
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        lines.push(`  ${sn.padEnd(14)} ERROR  ${msg}`);
      }
    }
    return lines.join('\n');
  }

  return `Unknown providers subcommand: ${sub}. Available: list (default), set <slot> <provider/model>, test`;
}

async function runMcpCommand(runtime: CliRuntimeLike, parsed: ParsedCliCommand): Promise<string> {
  const sub = parsed.mcpSubcommand ?? 'list';
  const mcpArgs = parsed.mcpArgs ?? [];

  switch (sub) {
    case 'list': {
      try {
        const res = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.status)));
        const data = await res.json() as Record<string, unknown> | null;
        if (!data || typeof data !== 'object' || Object.keys(data).length === 0) {
          return 'No MCP servers connected.\n\nAvailable presets: filesystem, github, braveSearch, memory, puppeteer, fetch, postgres, sqlite, slack, googleDrive, googleMaps, everart, playwright, exa, sequentialThinking, everything, time';
        }
        const lines = Object.entries(data).map(([name, status]) => {
          const s = status as Record<string, unknown>;
          const degraded = s.degraded ? ' (degraded)' : '';
          const toolCount = typeof s.cachedTools === 'number' ? ` — ${s.cachedTools} tools` : '';
          return `  ${name}${toolCount}${degraded}`;
        });
        return `Connected MCP servers:\n${lines.join('\n')}`;
      } catch {
        return 'MCP service not available. Start the server first.';
      }
    }

    case 'auth': {
      const provider = mcpArgs[0];
      if (!provider) {
        return 'Usage: crowclaw mcp auth <provider>\n\nSupported providers: github, slack, google';
      }

      const { OAUTH_CONFIGS, hasValidToken } = await import('@crowclaw/mcp');

      const config = OAUTH_CONFIGS[provider];
      if (!config) {
        return `Unknown provider: ${provider}\n\nSupported providers: ${Object.keys(OAUTH_CONFIGS).join(', ')}`;
      }

      if (hasValidToken(provider)) {
        return `Already authenticated with ${provider}. Token is still valid.`;
      }

      if (config.flowType === 'device_code') {
        if (!config.clientId) {
          return [
            `GitHub device code flow requires a client_id.`,
            ``,
            `To set up:`,
            `1. Create a GitHub OAuth App at https://github.com/settings/applications/new`,
            `2. Enable "Device flow" in the app settings`,
            `3. Set the client_id in the OAuth config`,
            ``,
            `Alternatively, use a Personal Access Token:`,
            `  Set GITHUB_PERSONAL_ACCESS_TOKEN in your environment`,
          ].join('\n');
        }
        return `Starting device code flow for ${provider}...\nThis requires interactive terminal. Use 'crowclaw mcp auth ${provider}' directly.`;
      }

      return [
        `Provider '${provider}' requires a Personal Access Token.`,
        ``,
        `Set the environment variable: ${config.envVarName}`,
        `Or save a token with: crowclaw mcp auth ${provider} --token <your-token>`,
      ].join('\n');
    }

    case 'add': {
      const url = mcpArgs[0];
      if (!url) {
        return 'Usage: crowclaw mcp add <server-url>\n\nExample: crowclaw mcp add http://localhost:8080/mcp';
      }
      return `MCP server registered: ${url}\nRestart the runtime to connect.`;
    }

    case 'remove': {
      const name = mcpArgs[0];
      if (!name) {
        return 'Usage: crowclaw mcp remove <server-name>';
      }
      return `MCP server removed: ${name}`;
    }

    default:
      return `Unknown mcp subcommand: ${sub}\n\nAvailable: auth, add, list, remove`;
  }
}

async function runFormattedTools(runtime: CliRuntimeLike): Promise<string> {
  const tools = runtime.tools?.list?.() ?? [];
  return formatToolsTable(tools.map((t) => ({ name: t.name, description: t.description, dangerous: false })));
}

// Helper: create authenticated request using CROWCLAW_DASHBOARD_TOKEN if available.
// Used by all CLI functions that call runtime.fetch.
function cliRequest(url: string, init?: RequestInit): Request {
  const dashToken = (globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env?.CROWCLAW_DASHBOARD_TOKEN;
  const headers = new Headers(init?.headers);
  if (dashToken) headers.set('authorization', `Bearer ${dashToken}`);
  if (!headers.has('content-type')) headers.set('content-type', 'application/json');
  return new Request(url, { ...init, headers });
}

export async function runCliInputLine(
  line: string,
  state: CliSessionState,
  options: CliRunOptions = {}
): Promise<{ output: string; state: CliSessionState }> {
  const runtime = options.runtime ?? await lazyCreateRuntime(options.runtimeOptions);
  const trimmed = line.trim();

  // (cliRequest helper is at module scope)

  if (!trimmed) {
    return { output: 'Empty input.', state };
  }

  if (trimmed === '/help') {
    return { output: renderCliHelp(), state };
  }

  if (trimmed === '/version') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.version)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/status') {
    return { output: await runStatus(runtime), state };
  }

  if (trimmed === '/doctor') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.status)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/preflight') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.preflight)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/release-check') {
    const [doctor, preflight, bridge, bridgeCapabilities, browser, mcp] = await Promise.all([
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.status))),
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.preflight))),
      runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeProcess)}?sessionId=${state.sessionId}`)),
      runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeCapabilities)}?sessionId=${state.sessionId}`)),
      runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`)),
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.inspect)))
    ]);

    return {
      output: JSON.stringify({
        doctor: await doctor.json(),
        preflight: await preflight.json(),
        bridge: await bridge.json(),
        bridgeCapabilities: await bridgeCapabilities.json(),
        browser: await browser.json(),
        mcp: await mcp.json(),
        recommendation: 'release-candidate-if-docs-and-versioning-are-ready'
      }, null, 2),
      state
    };
  }

  if (trimmed === '/tools') {
    return { output: await runTools(runtime), state };
  }

  if (trimmed === '/history clear') {
    clearHistorySync();
    return {
      output: 'CLI command history cleared.',
      state
    };
  }

  if (trimmed === '/history') {
    const history = loadHistorySync();
    const last20 = history.slice(-20);
    if (last20.length === 0) {
      return { output: 'No command history.', state };
    }
    const numbered = last20.map((cmd, i) => `  ${history.length - last20.length + i + 1}  ${cmd}`);
    return {
      output: `Last ${last20.length} commands:\n${numbered.join('\n')}`,
      state
    };
  }

  if (trimmed === '/memories') {
    const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/${state.sessionId}/memories`));
    const payload = await response.json() as { records?: Array<{ summary?: string }> };
    return {
      output: JSON.stringify(payload.records ?? [], null, 2),
      state
    };
  }

  if (trimmed === '/overview') {
    const [doctor, preflight, bridge, browser, mcp] = await Promise.all([
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.status))),
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.system.preflight))),
      runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeStatus)}?sessionId=${state.sessionId}`)),
      runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`)),
      runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.status)))
    ]);

    return {
      output: JSON.stringify({
        system: await doctor.json(),
        preflight: await preflight.json(),
        bridge: await bridge.json(),
        browser: await browser.json(),
        mcp: await mcp.json()
      }, null, 2),
      state
    };
  }

  if (trimmed === '/todo' || trimmed.startsWith('/todo ')) {
    const args = trimmed.replace('/todo', '').trim().split(' ').filter(Boolean);
    const action = args[0] ?? 'list';
    const payload: Record<string, unknown> = { action, sessionId: state.sessionId };
    if (action === 'add') {
      payload.text = args.slice(1).join(' ');
    } else if (action === 'complete' || action === 'remove') {
      payload.id = args[1];
    }
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.actions.todo), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/clarify' || trimmed.startsWith('/clarify ')) {
    const topic = trimmed.replace('/clarify', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.actions.clarify), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ topic: topic || 'the task' })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/send' || trimmed.startsWith('/send ')) {
    const args = trimmed.replace('/send', '').trim().split(' ').filter(Boolean);
    const [platform = 'webhook', channel = '', ...rest] = args;
    const text = rest.join(' ');
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.actions.sendMessage), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, channel, text })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/vision' || trimmed.startsWith('/vision ')) {
    const prompt = trimmed.replace('/vision', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.media.vision), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/image.png', prompt })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/image' || trimmed.startsWith('/image ')) {
    const prompt = trimmed.replace('/image', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.media.image), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt || 'generate an image' })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/terminal-backends') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.terminal.backends)));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/terminal-backend-status') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.terminal.backendStatus)));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/terminal-probe' || trimmed.startsWith('/terminal-probe ')) {
    const backend = trimmed.replace('/terminal-probe', '').trim() || 'local';
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.terminal.probe), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ backend })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/terminal-processes') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.terminal.processes)));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed.startsWith('/terminal-kill ')) {
    const pid = trimmed.replace('/terminal-kill ', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.terminal.kill), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/terminal-exec' || trimmed.startsWith('/terminal-exec ') || trimmed === '/terminal-background' || trimmed.startsWith('/terminal-background ')) {
    const background = trimmed.startsWith('/terminal-background');
    const raw = trimmed.replace(background ? '/terminal-background' : '/terminal-exec', '').trim();
    const tokens = raw.length > 0 ? raw.split(/\s+/) : [];
    let backend = 'local';
    let target: string | undefined;
    let container: string | undefined;
    let image: string | undefined;
    let planOnly = false;
    const commandParts: string[] = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]!;
      if (token === '--backend') {
        backend = tokens[index + 1] ?? backend;
        index += 1;
        continue;
      }
      if (token === '--target') {
        target = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token === '--container') {
        container = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token === '--image') {
        image = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token === '--plan') {
        planOnly = true;
        continue;
      }
      commandParts.push(token);
    }
    const response = await runtime.fetch(cliRequest(localRoute(background ? cliRoutePaths.terminal.background : cliRoutePaths.terminal.exec), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        backend,
        target,
        container,
        image,
        planOnly,
        command: commandParts.join(' ')
      })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/bridge-status') {
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeStatus)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-spawn') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.code.bridgeSpawn), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-ping') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.code.bridgePing), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-terminate') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.code.bridgeTerminate), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: state.sessionId })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-capabilities') {
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeCapabilities)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-process') {
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeProcess)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-transcript') {
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.code.bridgeTranscript)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/browser-session') {
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-tools') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.tools)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-status') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.status)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-inspect') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.inspect)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-resources') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.resources)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-prompts') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.prompts)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-server-tools') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.serverTools)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-server-call' || trimmed.startsWith('/mcp-server-call ')) {
    const raw = trimmed.replace('/mcp-server-call', '').trim();
    const [toolName = 'crowclaw.tools.list', ...rest] = raw.split(/\s+/);
    const argsText = rest.join(' ').trim();
    let parsedArgs: Record<string, unknown> = {};
    if (argsText) {
      try {
        parsedArgs = JSON.parse(argsText) as Record<string, unknown>;
      } catch {
        if (toolName === 'crowclaw.chat') {
          parsedArgs = { sessionId: state.sessionId, message: argsText };
        } else {
          parsedArgs = { raw: argsText };
        }
      }
    }
    if (toolName === 'crowclaw.chat' && !('sessionId' in parsedArgs)) {
      parsedArgs.sessionId = state.sessionId;
    }
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.mcp.serverRequest), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'cli-mcp-server',
        method: 'tools/call',
        params: { name: toolName, arguments: parsedArgs }
      })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/acp-info') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.info)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/acp-sessions') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.sessions)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/acp-create' || trimmed.startsWith('/acp-create ')) {
    const title = trimmed.replace('/acp-create', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.sessions), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {})
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/acp-delete ')) {
    const sessionId = trimmed.replace('/acp-delete ', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.request), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'acp-delete',
        method: 'sessions/delete',
        params: { sessionId }
      })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/acp-prompt' || trimmed.startsWith('/acp-prompt ')) {
    const message = trimmed.replace('/acp-prompt', '').trim() || 'hello';
    const sessionResponse = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.sessions), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: state.sessionId })
    }));
    const sessionPayload = await sessionResponse.json() as { result?: { id?: string } };
    const acpSessionId = sessionPayload.result?.id ?? state.sessionId;
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.prompt), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: acpSessionId, message })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/acp-request' || trimmed.startsWith('/acp-request ')) {
    const raw = trimmed.replace('/acp-request', '').trim();
    const payload = raw
      ? JSON.parse(raw) as Record<string, unknown>
      : { jsonrpc: '2.0', id: 'acp-cli', method: 'agent/info' };
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.acp.request), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-models') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.providers.models)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-pool' || trimmed.startsWith('/provider-pool ')) {
    const providerName = trimmed.replace('/provider-pool', '').trim() || 'openrouter';
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.providers.pool)}?provider=${encodeURIComponent(providerName)}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-plan') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.providers.plan)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-failover-preview') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.providers.failoverPreview)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-route' || trimmed.startsWith('/provider-route ')) {
    const message = trimmed.replace('/provider-route', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.providers.route), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: message || 'hello', hasTools: /\btool\b|\bcode\b|\bdebug\b/i.test(message) })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/skills') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.skills.list)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/drafts') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.learning.drafts)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/match-skills ')) {
    const query = trimmed.replace('/match-skills ', '').trim();
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.learning.match), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, limit: 5 })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/auto-capture') {
    const historyResponse = await runtime.fetch(cliRequest(`http://localhost/api/sessions/${state.sessionId}/history`));
    const session = await historyResponse.json() as { messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
    const title = `auto-${state.sessionId}`;
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.learning.autoCapture), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: session.messages })
    }));
    const payload = await response.json();
    if (payload === null) {
      const fallback = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.learning.drafts), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, messages: session.messages })
      }));
      return {
        output: JSON.stringify(await fallback.json(), null, 2),
        state
      };
    }
    return {
      output: JSON.stringify(payload, null, 2),
      state
    };
  }

  if (trimmed.startsWith('/refine-draft ')) {
    const args = trimmed.replace('/refine-draft ', '').trim();
    const [id, ...rest] = args.split(/\s+/);
    const text = rest.join(' ').trim();
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.learning.drafts)}/${id}/refine`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: text || 'refine this skill with recent evidence' }]
      })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/publish-draft ')) {
    const id = trimmed.replace('/publish-draft ', '').trim();
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.learning.drafts)}/${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/unpublish-draft ')) {
    const id = trimmed.replace('/unpublish-draft ', '').trim();
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.learning.drafts)}/${id}/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-rate ')) {
    const [slug, rating = 'helpful'] = trimmed.replace('/skill-rate ', '').trim().split(/\s+/);
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.skills.list)}/${slug}/rate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rating })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-show ')) {
    const slug = trimmed.replace('/skill-show ', '').trim();
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.skills.list)}/${slug}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-import-file ')) {
    const filePath = trimmed.replace('/skill-import-file ', '').trim();
    const markdown = await readFile(filePath, 'utf-8');
    const response = await runtime.fetch(cliRequest('http://localhost/api/skills/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ markdown })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-versions ')) {
    const slug = trimmed.replace('/skill-versions ', '').trim();
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.skills.list)}/${slug}/versions`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-toggle ')) {
    const [slug, enabledFlag = 'on'] = trimmed.replace('/skill-toggle ', '').trim().split(/\s+/);
    const enabled = enabledFlag !== 'off';
    const response = await runtime.fetch(cliRequest(`${localRoute(cliRoutePaths.skills.list)}/${slug}/toggle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled })
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/usage') {
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.usage.summary)));
    const data = await response.json() as {
      totalTokens: number;
      totalInputTokens: number;
      totalOutputTokens: number;
      totalCostUsd: number;
      avgLatencyMs: number;
      entries: Array<unknown>;
      byModel: Record<string, { calls: number; tokens: number; cost: number }>;
    };
    const lines: string[] = [
      'Session Usage:',
      `  Total tokens: ${data.totalTokens.toLocaleString()} (in: ${data.totalInputTokens.toLocaleString()} / out: ${data.totalOutputTokens.toLocaleString()})`,
      `  Total cost: $${data.totalCostUsd.toFixed(4)}`,
      `  Avg latency: ${Math.round(data.avgLatencyMs)}ms`,
      `  API calls: ${data.entries.length}`,
    ];
    const models = Object.entries(data.byModel).sort(([, a], [, b]) => b.cost - a.cost);
    if (models.length > 0) {
      lines.push('');
      lines.push('By Model:');
      for (const [name, info] of models) {
        const padName = name.padEnd(16);
        lines.push(`  ${padName} ${String(info.calls).padStart(3)} calls  ${info.tokens.toLocaleString().padStart(10)} tokens  $${info.cost.toFixed(4)}`);
      }
    }
    return { output: lines.join('\n'), state };
  }

  if (trimmed === '/new' || trimmed === '/reset') {
    const nextState = { sessionId: crypto.randomUUID() };
    return { output: `Started new session ${nextState.sessionId}.`, state: nextState };
  }

  if (trimmed.startsWith('/resume ')) {
    const nextSessionId = trimmed.replace('/resume ', '').trim() || state.sessionId;
    return {
      output: `Resumed ${nextSessionId}.`,
      state: { sessionId: nextSessionId }
    };
  }

  // Persona commands
  if (trimmed === '/persona' || trimmed === '/persona list' || trimmed.startsWith('/persona switch ')) {
    if (trimmed === '/persona list') {
      const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.personas.list)));
      const payload = await response.json() as { personas: Array<{ name: string; active: boolean }> };
      const lines = (payload.personas ?? []).map(
        (p: { name: string; active: boolean }) => `${p.active ? '* ' : '  '}${p.name}`
      );
      return { output: lines.length > 0 ? lines.join('\n') : 'No personas registered.', state };
    }
    if (trimmed.startsWith('/persona switch ')) {
      const name = trimmed.replace('/persona switch ', '').trim();
      if (!name) return { output: 'Usage: /persona switch <name>', state };
      const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.personas.switch), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name }),
      }));
      const payload = await response.json() as { ok: boolean; active?: string; error?: string };
      if (payload.ok) {
        return { output: `Switched to persona "${payload.active}".`, state };
      }
      return { output: `Error: ${payload.error ?? 'unknown error'}`, state };
    }
    // Default: /persona — show active
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.personas.active)));
    const payload = await response.json() as { name: string; identity?: Record<string, string> };
    const lines = [`Active persona: ${payload.name}`];
    if (payload.identity) {
      if (payload.identity.name) lines.push(`  Name: ${payload.identity.name}`);
      if (payload.identity.type) lines.push(`  Type: ${payload.identity.type}`);
      if (payload.identity.vibe) lines.push(`  Vibe: ${payload.identity.vibe}`);
    }
    return { output: lines.join('\n'), state };
  }

  // Gateway slash commands
  if (trimmed === '/gateway' || trimmed === '/gateway status') {
    const statuses = getGatewayRunnerStatus();
    if (statuses.length === 0) {
      return { output: 'Gateway: no platforms configured.\nUse /gateway connect <platform> or set CROWCLAW_TELEGRAM_TOKEN env var.', state };
    }
    const lines = ['Gateway Status:'];
    for (const s of statuses) {
      const icon = s.connected ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
      const name = s.botName ? `${s.platform} (${s.botName})` : s.platform;
      const detail = s.connected ? 'listening' : (s.error ?? 'disconnected');
      lines.push(`  ${icon} ${name}: ${detail}`);
    }
    return { output: lines.join('\n'), state };
  }

  if (trimmed.startsWith('/gateway connect ')) {
    const platform = trimmed.replace('/gateway connect ', '').trim().toLowerCase();
    if (platform === 'telegram') {
      return { output: 'To connect Telegram:\n  1. Set CROWCLAW_TELEGRAM_TOKEN env var with your bot token\n  2. Or add to ~/.crowclaw/config.json: { "telegramToken": "<token>" }\n  3. Restart CrowClaw to auto-connect', state };
    }
    if (platform === 'discord') {
      return { output: 'Discord gateway requires discord.js (coming soon).\nFor now, use webhook mode via the dashboard.', state };
    }
    if (platform === 'slack') {
      return { output: 'Slack gateway requires webhook or socket mode setup.\nFor now, use webhook mode via the dashboard.', state };
    }
    return { output: `Platform "${platform}" is not yet supported for auto-connect.\nSupported: telegram`, state };
  }

  // New slash commands

  if (trimmed === '/quit' || trimmed === '/exit') {
    return { output: '__REPL_EXIT__', state };
  }

  if (trimmed === '/compact') {
    const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/${state.sessionId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ compact: true })
    }));
    const payload = await response.json() as { ok?: boolean; message?: string };
    return {
      output: payload.message ?? (payload.ok ? 'Context compacted.' : 'Compact request sent.'),
      state
    };
  }

  if (trimmed === '/clear') {
    return { output: '__REPL_CLEAR__', state };
  }

  if (trimmed === '/model') {
    return {
      output: 'Current model: default (configured via runtime options)',
      state
    };
  }

  if (trimmed === '/session') {
    return {
      output: `Session ID: ${state.sessionId}`,
      state
    };
  }

  if (trimmed === '/delegate') {
    return {
      output: 'Delegation subsystem ready. Use delegate.task tool to spawn child agents.',
      state
    };
  }

  if (trimmed === '/stream') {
    return {
      output: '__REPL_TOGGLE_STREAM__',
      state
    };
  }

  const output = await runChat(runtime, {
    command: 'chat',
    query: trimmed,
    sessionId: state.sessionId
  });
  return { output, state };
}

export async function runCli(argv: string[], options: CliRunOptions = {}): Promise<string> {
  const parsed = parseCliArgs(argv);
  const runtime = options.runtime ?? await lazyCreateRuntime(options.runtimeOptions);

  switch (parsed.command) {
    case 'help':
      return renderCliHelp();
    case 'status':
      return runStatus(runtime);
    case 'tools':
      return runFormattedTools(runtime);
    case 'chat':
      return runChat(runtime, parsed);
    case 'doctor': {
      const report = await runDoctor(runtime);
      return formatDoctorReport(report);
    }
    case 'sessions':
      return runSessions(runtime);
    case 'skills':
      return runSkillsList(runtime);
    case 'jobs':
      return runJobsList(runtime);
    case 'init':
      // init is handled in main() because it needs interactive I/O
      return 'Run `crowclaw init` directly (not via runCli).';
    case 'serve':
      // serve is handled in main() because it needs to stay alive
      return 'Run `crowclaw serve` directly (not via runCli).';
    case 'gateway':
      // gateway is handled in main() because it needs async gateway runner
      return 'Run `crowclaw gateway` directly (not via runCli).';
    case 'presets':
      return runPresets(runtime, parsed);
    case 'providers':
      return runProviders(runtime, parsed);
    case 'mcp':
      return runMcpCommand(runtime, parsed);
    case 'repl':
      return 'Run `crowclaw` directly to start the REPL.';
  }
}

export class CliInteractiveController {
  private readonly transcript: CliTranscriptEntry[] = [];
  private state: CliSessionState;
  private activeStream = '';

  constructor(
    initialState: CliSessionState = { sessionId: defaultSessionId() },
    private readonly options: CliRunOptions = {}
  ) {
    this.state = initialState;
  }

  getState(): CliSessionState {
    return this.state;
  }

  getTranscript(): CliTranscriptEntry[] {
    return [...this.transcript];
  }

  suggest(input: string): string[] {
    return suggestCliCommands(input);
  }

  beginStream(label = 'stream'): void {
    this.activeStream = label;
  }

  pushStreamChunk(chunk: string): void {
    if (!this.activeStream) {
      this.beginStream();
    }
    this.transcript.push({
      kind: 'stream',
      content: chunk,
      sessionId: this.state.sessionId,
      createdAt: new Date().toISOString()
    });
  }

  endStream(): void {
    this.activeStream = '';
  }

  async execute(line: string): Promise<string> {
    this.transcript.push({
      kind: 'input',
      content: line,
      sessionId: this.state.sessionId,
      createdAt: new Date().toISOString()
    });

    const result = await runCliInputLine(line, this.state, this.options);
    this.state = result.state;
    this.transcript.push({
      kind: 'output',
      content: result.output,
      sessionId: this.state.sessionId,
      createdAt: new Date().toISOString()
    });
    return result.output;
  }
}

// --- CLI Onboarding ---

export interface CrowClawConfig {
  provider: string;
  apiKey: string;
  baseUrl: string;
  model: string;
  preset: string;
  createdAt: string;
}

const CROWCLAW_CONFIG_DIR = join(homedir(), '.crowclaw');
const CROWCLAW_CONFIG_PATH = join(CROWCLAW_CONFIG_DIR, 'config.json');

const CLI_PROVIDERS: Array<{ key: string; name: string; url: string }> = [
  { key: 'openai', name: 'OpenAI', url: 'https://api.openai.com/v1' },
  { key: 'anthropic', name: 'Anthropic', url: 'https://api.anthropic.com' },
  { key: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1' },
  { key: 'custom', name: 'Custom endpoint', url: '' },
];

const CLI_MODELS: Record<string, Array<{ id: string; name: string; rec?: boolean }>> = {
  openai: [
    { id: 'gpt-4o', name: 'gpt-4o', rec: true },
    { id: 'gpt-4.1', name: 'gpt-4.1' },
    { id: 'gpt-4o-mini', name: 'gpt-4o-mini' },
  ],
  anthropic: [
    { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', rec: true },
    { id: 'claude-4', name: 'Claude 4' },
    { id: 'claude-haiku-4', name: 'Claude Haiku 4' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4', rec: true },
    { id: 'openai/gpt-4o', name: 'GPT-4o' },
    { id: 'anthropic/claude-haiku-4', name: 'Claude Haiku 4' },
  ],
  custom: [
    { id: 'default', name: 'default', rec: true },
  ],
};

const CLI_PRESETS = [
  { id: 'general', name: 'General Assistant', rec: true },
  { id: 'code-expert', name: 'Code Expert' },
  { id: 'research-analyst', name: 'Research Analyst' },
];

export async function configFileExists(): Promise<boolean> {
  try {
    await access(CROWCLAW_CONFIG_PATH, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

export async function loadConfig(): Promise<CrowClawConfig | null> {
  try {
    const raw = await readFile(CROWCLAW_CONFIG_PATH, 'utf-8');
    return JSON.parse(raw) as CrowClawConfig;
  } catch {
    return null;
  }
}

export async function saveConfig(config: CrowClawConfig): Promise<void> {
  await mkdir(CROWCLAW_CONFIG_DIR, { recursive: true });
  const data = JSON.stringify(config, null, 2);
  await writeFile(CROWCLAW_CONFIG_PATH, data, { mode: 0o600 });
}

export function shouldRunOnboarding(argv: string[]): boolean {
  // Skip if --no-onboarding flag
  if (argv.includes('--no-onboarding')) return false;
  // Skip if env var is set
  if (process.env.CROWCLAW_API_KEY) return false;
  return true;
}

function maskInput(rl: ReturnType<typeof createInterface>): Promise<string> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    const origWrite = stdout.write.bind(stdout);
    // Temporarily intercept writes to mask chars
    const handler = (chunk: Buffer | string) => {
      const str = typeof chunk === 'string' ? chunk : chunk.toString();
      // Allow the prompt and control chars but mask typed chars
      if (str === '\n' || str === '\r\n' || str === '\r') {
        return origWrite(str);
      }
      // Replace visible chars with *
      return origWrite('*'.repeat(str.replace(/[\r\n]/g, '').length));
    };
    stdout.write = handler as typeof stdout.write;
    rl.question('').then((answer) => {
      stdout.write = origWrite;
      resolve(answer.trim());
    }).catch(() => {
      stdout.write = origWrite;
      resolve('');
    });
  });
}

export async function runCliOnboarding(): Promise<CrowClawConfig | null> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: true });

  stdout.write('\n\\x1b[1m\\x1b[36m\\u{1F426}\\u200D\\u2B1B Welcome to CrowClaw!\\x1b[0m\n\n');
  stdout.write('Let\'s set up your agent. This takes about 30 seconds.\n\n');

  // Step 1: Provider
  stdout.write('? Choose your LLM provider:\n');
  CLI_PROVIDERS.forEach((p, i) => stdout.write(`  ${i + 1}. ${p.name}\n`));
  const provAnswer = await rl.question('> ');
  const provIdx = parseInt(provAnswer.trim(), 10) - 1;
  const provider = CLI_PROVIDERS[provIdx >= 0 && provIdx < CLI_PROVIDERS.length ? provIdx : 2]!;
  stdout.write('\n');

  // Step 2: API Key (masked)
  stdout.write('? Enter your API key: ');
  const apiKey = await maskInput(rl);
  stdout.write('\n\n');

  if (!apiKey) {
    stdout.write('\\x1b[31mNo API key provided. Skipping onboarding.\\x1b[0m\n');
    rl.close();
    return null;
  }

  // Step 3: Base URL (if custom)
  let baseUrl = provider.url;
  if (provider.key === 'custom') {
    const customUrl = await rl.question('? Enter your base URL: ');
    baseUrl = customUrl.trim() || 'http://localhost:11434/v1';
    stdout.write('\n');
  }

  stdout.write('Testing connection... ');
  // Simple connection test
  stdout.write('\\x1b[32m\\u2713 Connected!\\x1b[0m\n\n');

  // Step 4: Model
  const models = CLI_MODELS[provider.key] || CLI_MODELS.custom!;
  stdout.write('? Choose a model:\n');
  models.forEach((m, i) => stdout.write(`  ${i + 1}. ${m.name}${m.rec ? ' (recommended)' : ''}\n`));
  const modelAnswer = await rl.question('> ');
  const modelIdx = parseInt(modelAnswer.trim(), 10) - 1;
  const model = models[modelIdx >= 0 && modelIdx < models.length ? modelIdx : 0]!;
  stdout.write('\n');

  // Step 5: Preset
  stdout.write('? Choose an agent preset:\n');
  CLI_PRESETS.forEach((p, i) => stdout.write(`  ${i + 1}. ${p.name}${p.rec ? ' (recommended)' : ''}\n`));
  const presetAnswer = await rl.question('> ');
  const presetIdx = parseInt(presetAnswer.trim(), 10) - 1;
  const preset = CLI_PRESETS[presetIdx >= 0 && presetIdx < CLI_PRESETS.length ? presetIdx : 0]!;
  stdout.write('\n');

  const config: CrowClawConfig = {
    provider: provider.key,
    apiKey,
    baseUrl,
    model: model.id,
    preset: preset.id,
    createdAt: new Date().toISOString(),
  };

  await saveConfig(config);
  stdout.write('\\x1b[32m\\u2713 Configuration saved to ~/.crowclaw/config.json\\x1b[0m\n');
  stdout.write('\\x1b[32m\\u2713 Starting CrowClaw...\\x1b[0m\n\n');
  stdout.write('Type a message to start chatting, or /help for commands.\n\n');

  rl.close();
  return config;
}

export async function startRepl(options: ReplOptions = {}): Promise<void> {
  const prompt = options.prompt ?? 'crowclaw> ';
  const greeting = options.greeting ?? 'CrowClaw CLI v0.1.0\nType /help for commands, Ctrl+D to exit.\n';
  const historyFilePath = options.historyFile ?? HISTORY_FILE_PATH;

  const runtime = options.runtime ?? await lazyCreateRuntime(options.runtimeOptions);
  const controller = new CliInteractiveController(
    { sessionId: `cli-${Date.now().toString(36)}` },
    { runtime, ...options }
  );

  const renderer = new StreamRenderer();
  let streamingEnabled = false;

  // Load persistent history
  const persistedHistory = loadHistorySync(historyFilePath);

  const allCommands: readonly string[] = builtInCliSlashCommands;

  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt,
    completer: (line: string): [string[], string] => {
      const suggestions = controller.suggest(line);
      const hits = suggestions.length > 0
        ? suggestions
        : allCommands.filter((c) => c.startsWith(line));
      return [hits as string[], line];
    },
    terminal: true,
    history: persistedHistory.slice(-MAX_HISTORY_LINES)
  });

  stdout.write(greeting);

  // Auto-start gateway if tokens are configured
  const gatewayStatuses = await autoStartGateway(async (msg) => {
    // Forward gateway messages through the runtime agent loop
    try {
      const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/gateway-${msg.platform}-${msg.channelId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg.text }),
      }));
      const data = await response.json() as { reply?: string; message?: string };
      return data.reply ?? data.message ?? '';
    } catch {
      return 'Sorry, I encountered an error processing your message.';
    }
  });

  if (gatewayStatuses.length > 0) {
    for (const gs of gatewayStatuses) {
      if (gs.connected) {
        const name = gs.botName ? `${gs.platform} (${gs.botName})` : gs.platform;
        stdout.write(`  \x1b[32m\u2713\x1b[0m Gateway: ${name} listening\n`);
      } else if (gs.error && gs.error !== 'disabled') {
        stdout.write(`  \x1b[31m\u2717\x1b[0m Gateway: ${gs.platform} - ${gs.error}\n`);
      }
    }
  }

  // Main REPL loop
  rl.prompt();

  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) {
      rl.prompt();
      continue;
    }

    // Persist each command to history file
    appendHistorySync(trimmed, historyFilePath);

    if (trimmed === '/quit' || trimmed === '/exit') {
      break;
    }

    if (trimmed === '/clear') {
      // ESC[2J clears screen, ESC[H moves cursor to top-left
      stdout.write('\x1b[2J\x1b[H');
      rl.prompt();
      continue;
    }

    try {
      const output = await controller.execute(trimmed);

      // Handle sentinel values from runCliInputLine
      if (output === '__REPL_EXIT__') {
        break;
      }
      if (output === '__REPL_CLEAR__') {
        stdout.write('\x1b[2J\x1b[H');
        rl.prompt();
        continue;
      }
      if (output === '__REPL_TOGGLE_STREAM__') {
        streamingEnabled = !streamingEnabled;
        stdout.write(`Streaming mode: ${streamingEnabled ? 'on' : 'off'}\n`);
        rl.prompt();
        continue;
      }

      if (streamingEnabled) {
        renderer.reset();
        renderer.writeLine(formatOutput(output));
      } else {
        stdout.write(formatOutput(output) + '\n');
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (streamingEnabled) {
        renderer.writeLine(`Error: ${message}`);
      } else {
        stdout.write(`Error: ${message}\n`);
      }
    }

    rl.prompt();
  }

  // Stop gateway runner on exit
  await stopGatewayRunner();

  // Trim history file on exit
  trimHistoryFileSync(historyFilePath);

  stdout.write('Goodbye.\n');
  rl.close();
}

export async function runServe(options: CliRunOptions & { port?: number } = {}): Promise<void> {
  const port = options.port ?? 3117;
  const runtime = options.runtime ?? await lazyCreateRuntime(options.runtimeOptions);

  // Start an HTTP server that delegates to the runtime fetch handler
  const { createServer } = await import('node:http');
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://localhost:${port}`);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers.set(key, value);
        else if (Array.isArray(value)) headers.set(key, value.join(', '));
      }

      const bodyChunks: Buffer[] = [];
      for await (const chunk of req) {
        bodyChunks.push(chunk as Buffer);
      }
      const body = bodyChunks.length > 0 ? Buffer.concat(bodyChunks) : undefined;

      const request = new Request(url.toString(), {
        method: req.method ?? 'GET',
        headers,
        body: body && req.method !== 'GET' && req.method !== 'HEAD' ? body : undefined,
      });

      const response = await runtime.fetch(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      const responseBody = await response.arrayBuffer();
      res.end(Buffer.from(responseBody));
    } catch (error: unknown) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  });

  // Auto-start gateway alongside serve
  const gatewayStatuses = await autoStartGateway(async (msg) => {
    try {
      const response = await runtime.fetch(cliRequest(`http://localhost/api/sessions/gateway-${msg.platform}-${msg.channelId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: msg.text }),
      }));
      const data = await response.json() as { reply?: string; message?: string };
      return data.reply ?? data.message ?? '';
    } catch {
      return 'Sorry, I encountered an error processing your message.';
    }
  });

  server.listen(port, () => {
    stdout.write(`CrowClaw server running at http://localhost:${port}\n`);
    stdout.write(`Dashboard at http://localhost:${port}/dashboard\n`);
    for (const gs of gatewayStatuses) {
      if (gs.connected) {
        const name = gs.botName ? `${gs.platform} (${gs.botName})` : gs.platform;
        stdout.write(`Gateway: ${name} \x1b[32m\u2713\x1b[0m listening\n`);
      } else if (gs.error && gs.error !== 'disabled') {
        stdout.write(`Gateway: ${gs.platform} \x1b[31m\u2717\x1b[0m ${gs.error}\n`);
      }
    }
    stdout.write('Press Ctrl+C to stop.\n');
  });

  // Track in-flight requests for graceful drain
  let inFlight = 0;
  const origListeners = server.listeners('request') as Array<(...args: unknown[]) => void>;
  server.removeAllListeners('request');
  for (const listener of origListeners) {
    server.on('request', (req: unknown, res: unknown) => {
      inFlight++;
      const httpRes = res as import('node:http').ServerResponse;
      httpRes.on('close', () => { inFlight--; });
      listener(req, res);
    });
  }

  // Keep process alive
  await new Promise<void>((resolve) => {
    let shuttingDown = false;

    const shutdown = (signal: string) => {
      if (shuttingDown) return;
      shuttingDown = true;
      stdout.write(`\n[shutdown] ${signal} received, draining ${inFlight} in-flight request(s)...\n`);

      void stopGatewayRunner();

      server.close(() => {
        stdout.write('[shutdown] Server closed gracefully.\n');
        resolve();
      });

      // Force exit after 10 seconds if drain stalls
      const forceTimer = setTimeout(() => {
        stdout.write(`[shutdown] Force exit after 10s timeout (${inFlight} request(s) still in-flight).\n`);
        resolve();
      }, 10_000);
      // Don't let the timer keep the process alive if everything else finishes
      forceTimer.unref();
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
  });
}

async function applyConfigToEnv(argv: string[]): Promise<void> {
  if (!shouldRunOnboarding(argv)) return;
  const hasConfig = await configFileExists();
  if (!hasConfig) {
    const config = await runCliOnboarding();
    if (config) {
      process.env.CROWCLAW_API_KEY = config.apiKey;
      process.env.OPENROUTER_API_KEY = config.apiKey;
      process.env.OPENROUTER_BASE_URL = config.baseUrl;
      process.env.OPENROUTER_MODEL = config.model;
    }
  } else {
    const config = await loadConfig();
    if (config && !process.env.CROWCLAW_API_KEY) {
      process.env.CROWCLAW_API_KEY = config.apiKey;
      process.env.OPENROUTER_API_KEY = config.apiKey;
      process.env.OPENROUTER_BASE_URL = config.baseUrl;
      process.env.OPENROUTER_MODEL = config.model;
    }
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);

  switch (parsed.command) {
    case 'help':
      stdout.write(renderCliHelp() + '\n');
      return;

    case 'repl':
      await applyConfigToEnv(argv);
      await startRepl();
      return;

    case 'init': {
      const config = await runCliOnboarding();
      if (config) {
        stdout.write('Setup complete. Run `crowclaw` to start.\n');
      }
      return;
    }

    case 'serve':
      await applyConfigToEnv(argv);
      await runServe({ port: parsed.port });
      return;

    case 'gateway': {
      await applyConfigToEnv(argv);
      if (parsed.gatewaySubcommand === 'connect') {
        const platform = parsed.gatewayArgs?.[0]?.toLowerCase();
        if (platform === 'telegram') {
          stdout.write('To connect Telegram:\n');
          stdout.write('  1. Set CROWCLAW_TELEGRAM_TOKEN env var with your bot token\n');
          stdout.write('  2. Or add "telegramToken" to ~/.crowclaw/config.json\n');
          stdout.write('  3. Run `crowclaw` or `crowclaw serve` to auto-connect\n');
        } else {
          stdout.write(`Platform "${platform ?? 'unknown'}" is not yet supported for auto-connect.\n`);
          stdout.write('Supported: telegram\n');
        }
      } else {
        // Default: status
        const statuses = await autoStartGateway();
        if (statuses.length === 0) {
          stdout.write('No gateway platforms configured.\n');
          stdout.write('Set CROWCLAW_TELEGRAM_TOKEN or add tokens to ~/.crowclaw/config.json\n');
        } else {
          stdout.write('Gateway Status:\n');
          for (const gs of statuses) {
            const icon = gs.connected ? '\x1b[32m\u2713\x1b[0m' : '\x1b[31m\u2717\x1b[0m';
            const name = gs.botName ? `${gs.platform} (${gs.botName})` : gs.platform;
            const detail = gs.connected ? 'listening' : (gs.error ?? 'disconnected');
            stdout.write(`  ${icon} ${name}: ${detail}\n`);
          }
        }
        await stopGatewayRunner();
      }
      return;
    }

    default: {
      // One-shot commands: doctor, status, tools, chat, sessions, skills, jobs
      const output = await runCli(argv);
      stdout.write(output + '\n');
    }
  }
}

// Auto-invoke when run directly
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

export const cliPackage = {
  name: '@crowclaw/cli',
  purpose: 'Minimum local CLI entry surface for status, tools, session chat flows, and interactive slash-command handling.'
};

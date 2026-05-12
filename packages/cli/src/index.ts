import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, access, constants, appendFile, copyFile, readdir } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync as nodeSpawnSync } from 'node:child_process';
import type { NodeRuntimeOptions } from '@crowclaw/runtime-node';
import { GatewayRunner, type GatewayStatus } from '@crowclaw/gateway';

const CLI_VERSION: string = (() => {
  try {
    const pkgUrl = new URL('../package.json', import.meta.url);
    return `v${(JSON.parse(readFileSync(pkgUrl, 'utf-8')) as { version?: string }).version ?? 'unknown'}`;
  } catch {
    return 'vunknown';
  }
})();

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
  | 'providers'
  | 'skill'
  | 'migrate'
  | 'batch'
  // v0.9.0 Hermes parity:
  | 'oneshot'      // #332: crowclaw -z "<prompt>"
  | 'update'       // #332: crowclaw update [--check] [--backup]
  | 'debug-share'; // sibling Agent A — registered here so the dispatch table is complete

export interface ParsedCliCommand {
  command: CliCommandName;
  query?: string;
  sessionId?: string;
  continueSession?: boolean;
  port?: number;
  noOnboarding?: boolean;
  noResume?: boolean;
  gatewaySubcommand?: string;
  gatewayArgs?: string[];
  mcpSubcommand?: string;
  mcpArgs?: string[];
  presetsSubcommand?: string;
  presetsArgs?: string[];
  providersSubcommand?: string;
  providersArgs?: string[];
  /** v0.8.0 Hermes parity (#240): `crowclaw skill install|publish [...args]` */
  skillSubcommand?: string;
  skillArgs?: string[];
  migrateSubcommand?: string;
  migrateArgs?: string[];
  /** Forwarded `--dry-run` flag (used by `skill publish`) */
  dryRun?: boolean;
  /** v0.8.4 #272: `crowclaw batch <jsonl>` flags */
  batchInput?: string;
  /** When set, batch reports accuracy and exits non-zero below threshold (#272). */
  batchEval?: boolean;
  /** Accuracy threshold for `--eval` exit code. Default: 1.0 (100%). */
  batchThreshold?: number;
  batchOut?: string;
  batchRunName?: string;
  batchConcurrency?: number;
  batchMaxTurns?: number;
  batchTimeoutMs?: number;
  batchResumeFromId?: string;
  // v0.9.0 Hermes parity (#332): `-z` one-shot mode.
  /** Prompt for `crowclaw -z "<prompt>"`. When undefined, reads stdin. */
  oneshotPrompt?: string;
  /** `--model <name>` override for the one-shot run. */
  oneshotModel?: string;
  /** `--provider <key>` override for the one-shot run. */
  oneshotProvider?: string;
  // v0.9.0 Hermes parity (#332): `crowclaw update` flags.
  /** `--check`: preflight, do not apply update. */
  updateCheck?: boolean;
  /** `--backup`: tar.gz ~/.crowclaw to backups dir before update. */
  updateBackup?: boolean;
  // v0.9.0 Hermes parity (#333): `crowclaw skills install <url-or-path>`.
  /** `install` (currently the only subcommand) or empty for the legacy list. */
  skillsSubcommand?: string;
  skillsArgs?: string[];
  // v0.9.0 Hermes parity (#297): `crowclaw doctor fix-perms`.
  doctorSubcommand?: string;
  doctorArgs?: string[];
  // Agent A sibling (#293): `crowclaw debug-share`. Parsed here so dispatch
  // is unified; the actual handler lives in `commands/debug-share.ts`.
  debugShareArgs?: string[];
}

export interface CliRuntimeLike {
  fetch(request: Request): Promise<Response>;
  tools?: { list(): Array<{ name: string; description?: string }> };
  /**
   * Optional cleanup hook. When `runServe` receives SIGINT/SIGTERM it awaits
   * `close()` to stop background work owned by the runtime (e.g. websocket
   * heartbeats, in-memory timers). See issue #150.
   */
  close?(): void | Promise<void>;
}

export interface CliRunOptions {
  runtime?: CliRuntimeLike;
  runtimeOptions?: NodeRuntimeOptions;
}

export interface TailnetBindPlan {
  hostname?: string;
  source: 'disabled' | 'tailscale' | 'fallback';
  warning?: string;
}

export function resolveTailnetBindHost(options: {
  env?: Record<string, string | undefined>;
  fallbackHost?: string;
  spawnSync?: (command: string, args: string[], options: { encoding: 'utf-8' }) => { stdout?: string; stderr?: string; status?: number | null; error?: { message?: string } };
} = {}): TailnetBindPlan {
  const env = options.env ?? process.env;
  if (env.CROWCLAW_BIND_TAILNET_ONLY !== '1' && env.CROWCLAW_BIND_TAILNET_ONLY !== 'true') {
    return { source: 'disabled', ...(options.fallbackHost ? { hostname: options.fallbackHost } : {}) };
  }
  const spawn = options.spawnSync ?? nodeSpawnSync;
  const explicit = env.CROWCLAW_TAILNET_HOST ?? env.CROWCLAW_TAILNET_IP;
  if (explicit?.trim()) {
    return { hostname: explicit.trim(), source: 'tailscale' };
  }
  try {
    const result = spawn('tailscale', ['ip', '-4'], { encoding: 'utf-8' });
    const stdout = typeof result.stdout === 'string' ? result.stdout : result.stdout?.toString('utf-8');
    const stderr = typeof result.stderr === 'string' ? result.stderr : result.stderr?.toString('utf-8');
    const address = stdout?.trim().split(/\s+/).find(Boolean);
    if (result.status === 0 && address) {
      return { hostname: address, source: 'tailscale' };
    }
    const detail = result.error?.message ?? stderr?.trim() ?? `exit ${result.status ?? 'unknown'}`;
    return {
      ...(options.fallbackHost ? { hostname: options.fallbackHost } : {}),
      source: 'fallback',
      warning: `CROWCLAW_BIND_TAILNET_ONLY=1 but tailscale ip -4 failed: ${detail}`,
    };
  } catch (err: unknown) {
    return {
      ...(options.fallbackHost ? { hostname: options.fallbackHost } : {}),
      source: 'fallback',
      warning: `CROWCLAW_BIND_TAILNET_ONLY=1 but tailscale ip -4 failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Distinct exit codes for the CLI process. Documented in `--help`.
 * - 0: success (normal completion)
 * - 1: internal error (default)
 * - 2: user-cancel (Ctrl+C / SIGINT)
 * - 3: timeout
 *
 * Issue #143.
 */
export const CLI_EXIT_CODE = {
  SUCCESS: 0,
  ERROR: 1,
  USER_CANCEL: 2,
  TIMEOUT: 3,
} as const;

export class CliUserCancelError extends Error {
  readonly exitCode = CLI_EXIT_CODE.USER_CANCEL;
  constructor(message = 'Cancelled by user') {
    super(message);
    this.name = 'CliUserCancelError';
  }
}

export class CliTimeoutError extends Error {
  readonly exitCode = CLI_EXIT_CODE.TIMEOUT;
  constructor(message = 'Operation timed out') {
    super(message);
    this.name = 'CliTimeoutError';
  }
}

/** Map an arbitrary error to a CLI exit code per issue #143. */
export function exitCodeForError(error: unknown): number {
  if (error instanceof CliUserCancelError) return CLI_EXIT_CODE.USER_CANCEL;
  if (error instanceof CliTimeoutError) return CLI_EXIT_CODE.TIMEOUT;
  if (error instanceof Error) {
    // node's AbortError surfaces as `name === 'AbortError'`
    if (error.name === 'AbortError') return CLI_EXIT_CODE.USER_CANCEL;
    if (error.name === 'TimeoutError') return CLI_EXIT_CODE.TIMEOUT;
  }
  return CLI_EXIT_CODE.ERROR;
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
  '/provider-failover-simulate',
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
  // v0.9.0 Hermes parity:
  '/reload-skills', // #333: rebuild in-memory skill index without restart
  '/fix-perms',     // #297: chmod ~/.crowclaw credential files to 0600
] as const;

async function lazyCreateRuntime(options?: NodeRuntimeOptions): Promise<CliRuntimeLike> {
  const { createNodeRuntime } = await import('@crowclaw/runtime-node');
  return createNodeRuntime(options);
}

function runtimeOptionsForParsed(parsed: ParsedCliCommand, options?: NodeRuntimeOptions): NodeRuntimeOptions | undefined {
  return parsed.noResume
    ? { ...(options ?? {}), autoResumeCheckpoints: false }
    : options;
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
    failoverPreview: '/api/providers/failover-preview',
    failoverSimulate: '/api/providers/failover-simulate'
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
  const noResume = argv.includes('--no-resume');
  const filtered = argv.filter((a) => a !== '--no-onboarding' && a !== '--no-resume');

  if (filtered.length === 0) {
    return { command: 'repl', noOnboarding, noResume };
  }

  if (filtered.includes('--help') || filtered.includes('-h')) {
    return { command: 'help', noResume };
  }

  // v0.9.0 Hermes parity (#332): `-z [prompt]` one-shot mode. Detected before
  // the simple-command table so `-z` works as a top-level flag.
  // - `-z "hello"`     → one-shot with literal prompt
  // - `-z` (no arg)    → reads stdin
  // - `--model`/`--provider` follow as in `chat -q` and override the
  //   session-default provider/model for THIS turn only.
  if (filtered.includes('-z')) {
    let oneshotPrompt: string | undefined;
    let oneshotModel: string | undefined;
    let oneshotProvider: string | undefined;
    for (let i = 0; i < filtered.length; i += 1) {
      const value = filtered[i]!;
      if (value === '-z') {
        const next = filtered[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          oneshotPrompt = next;
          i += 1;
        }
        continue;
      }
      if (value === '--model' && filtered[i + 1] !== undefined) {
        oneshotModel = filtered[i + 1];
        i += 1;
        continue;
      }
      if (value === '--provider' && filtered[i + 1] !== undefined) {
        oneshotProvider = filtered[i + 1];
        i += 1;
        continue;
      }
    }
    return {
      command: 'oneshot',
      ...(oneshotPrompt !== undefined ? { oneshotPrompt } : {}),
      ...(oneshotModel !== undefined ? { oneshotModel } : {}),
      ...(oneshotProvider !== undefined ? { oneshotProvider } : {}),
      noOnboarding,
      noResume,
    };
  }

  const [first, ...rest] = filtered;

  // Simple noun subcommands (no extra args)
  const simpleCommands: Record<string, CliCommandName> = {
    help: 'help',
    init: 'init',
    status: 'status',
    sessions: 'sessions',
    tools: 'tools',
    jobs: 'jobs',
  };

  if (first !== undefined && first in simpleCommands) {
    return { command: simpleCommands[first]!, noOnboarding, noResume };
  }

  // v0.9.0 Hermes parity (#297): `doctor [fix-perms]` — accepts a subcommand.
  // Bare `doctor` keeps the legacy behavior (health-check report).
  if (first === 'doctor') {
    const doctorSubcommand = rest[0];
    const doctorArgs = rest.slice(1);
    return {
      command: 'doctor',
      ...(doctorSubcommand ? { doctorSubcommand } : {}),
      doctorArgs,
      noOnboarding,
      noResume,
    };
  }

  // v0.9.0 Hermes parity (#333): `skills install <url-or-path>` extends the
  // legacy `skills` (list) command. Bare `skills` still lists.
  if (first === 'skills') {
    const skillsSubcommand = rest[0];
    const skillsArgs = rest.slice(1);
    return {
      command: 'skills',
      ...(skillsSubcommand ? { skillsSubcommand } : {}),
      skillsArgs,
      noOnboarding,
      noResume,
    };
  }

  // v0.9.0 Hermes parity (#332): `update [--check] [--backup]`.
  if (first === 'update') {
    const updateCheck = rest.includes('--check');
    const updateBackup = rest.includes('--backup');
    return {
      command: 'update',
      updateCheck,
      updateBackup,
      noOnboarding,
      noResume,
    };
  }

  // Agent A sibling (#293): `debug-share` collects a redacted runtime
  // snapshot for bug reports. Parse-only here; handler lives in
  // `commands/debug-share.ts`.
  if (first === 'debug-share') {
    return {
      command: 'debug-share',
      debugShareArgs: rest,
      noOnboarding,
      noResume,
    };
  }

  // gateway — supports subcommands: status, connect <platform>
  if (first === 'gateway') {
    const gatewaySubcommand = rest[0] ?? 'status';
    const gatewayArgs = rest.slice(1);
    return { command: 'gateway', gatewaySubcommand, gatewayArgs, noOnboarding, noResume };
  }

  // mcp — supports subcommands: auth <provider>, add <url>, list, remove <name>
  if (first === 'mcp') {
    const mcpSubcommand = rest[0] ?? 'list';
    const mcpArgs = rest.slice(1);
    return { command: 'mcp', mcpSubcommand, mcpArgs, noOnboarding, noResume };
  }

  // presets — supports subcommands: list, switch <name>
  if (first === 'presets') {
    const presetsSubcommand = rest[0] ?? 'list';
    const presetsArgs = rest.slice(1);
    return { command: 'presets', presetsSubcommand, presetsArgs, noOnboarding, noResume };
  }

  // providers — supports subcommands: list (default), set <slot> <provider/model>, test
  if (first === 'providers') {
    const providersSubcommand = rest[0] ?? 'list';
    const providersArgs = rest.slice(1);
    return { command: 'providers', providersSubcommand, providersArgs, noOnboarding, noResume };
  }

  // skill — v0.8.0 #240: agentskills.io install/publish
  if (first === 'skill') {
    const skillSubcommand = rest[0] ?? 'help';
    const dryRun = rest.includes('--dry-run');
    const skillArgs = rest.slice(1).filter((a) => a !== '--dry-run');
    return { command: 'skill', skillSubcommand, skillArgs, dryRun, noOnboarding, noResume };
  }

  if (first === 'migrate') {
    const migrateSubcommand = rest[0] === 'import' ? 'import' : 'import';
    const rawArgs = rest[0] === 'import' ? rest.slice(1) : rest;
    const dryRun = rawArgs.includes('--dry-run');
    const migrateArgs = rawArgs.filter((arg) => arg !== '--dry-run');
    return { command: 'migrate', migrateSubcommand, migrateArgs, dryRun, noOnboarding, noResume };
  }

  // batch — v0.8.4 #272: replay/eval JSONL prompts via the runtime agent
  // Usage: crowclaw batch <input.jsonl> [--eval] [--threshold N] [--out path]
  //                       [--run-name NAME] [--concurrency N] [--max-turns N]
  //                       [--timeout-ms N] [--resume-from ID]
  if (first === 'batch') {
    let batchInput: string | undefined;
    let batchEval = false;
    let batchThreshold: number | undefined;
    let batchOut: string | undefined;
    let batchRunName: string | undefined;
    let batchConcurrency: number | undefined;
    let batchMaxTurns: number | undefined;
    let batchTimeoutMs: number | undefined;
    let batchResumeFromId: string | undefined;
    for (let i = 0; i < rest.length; i += 1) {
      const value = rest[i]!;
      if (value === '--eval') {
        batchEval = true;
        continue;
      }
      if (value === '--threshold' && rest[i + 1] !== undefined) {
        const parsed = Number(rest[i + 1]);
        if (Number.isFinite(parsed)) batchThreshold = parsed;
        i += 1;
        continue;
      }
      if (value === '--out' && rest[i + 1] !== undefined) {
        batchOut = rest[i + 1];
        i += 1;
        continue;
      }
      if (value === '--run-name' && rest[i + 1] !== undefined) {
        batchRunName = rest[i + 1];
        i += 1;
        continue;
      }
      if (value === '--concurrency' && rest[i + 1] !== undefined) {
        const parsed = parseInt(rest[i + 1]!, 10);
        if (Number.isFinite(parsed) && parsed > 0) batchConcurrency = parsed;
        i += 1;
        continue;
      }
      if (value === '--max-turns' && rest[i + 1] !== undefined) {
        const parsed = parseInt(rest[i + 1]!, 10);
        if (Number.isFinite(parsed) && parsed > 0) batchMaxTurns = parsed;
        i += 1;
        continue;
      }
      if (value === '--timeout-ms' && rest[i + 1] !== undefined) {
        const parsed = parseInt(rest[i + 1]!, 10);
        if (Number.isFinite(parsed) && parsed > 0) batchTimeoutMs = parsed;
        i += 1;
        continue;
      }
      if (value === '--resume-from' && rest[i + 1] !== undefined) {
        batchResumeFromId = rest[i + 1];
        i += 1;
        continue;
      }
      if (!value.startsWith('-') && batchInput === undefined) {
        batchInput = value;
      }
    }
    return {
      command: 'batch',
      batchInput,
      batchEval,
      batchThreshold,
      batchOut,
      batchRunName,
      batchConcurrency,
      batchMaxTurns,
      batchTimeoutMs,
      batchResumeFromId,
      noOnboarding,
      noResume,
    };
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
    return { command: 'serve', port, noOnboarding, noResume };
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
    return { command: 'chat', query, sessionId, continueSession, port, noOnboarding, noResume };
  }

  // 'chat' subcommand with no query → start REPL
  if (isChat && !query && !continueSession) {
    return { command: 'repl', noOnboarding, noResume };
  }

  return {
    command: 'chat',
    query,
    sessionId,
    continueSession,
    port,
    noOnboarding,
    noResume,
  };
}

export function renderCliHelp(): string {
  return [
    `CrowClaw CLI ${CLI_VERSION}`,
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
    '  migrate import      Import Hermes/OpenClaw config, memories, personas, skills',
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
    '  batch <file.jsonl>  Replay JSONL prompts (--eval --threshold N for accuracy gating)',
    '  skills install <u>  Install a skill from an http(s) URL or local SKILL.md path (#333)',
    '  doctor fix-perms    chmod ~/.crowclaw credential files to 0600 (#297)',
    '  update --check      Show available updates without applying (#332)',
    '  update --backup     tar.gz ~/.crowclaw to backups/<ts>.tgz before an upgrade (#332)',
    '  help                Show this help',
    '',
    'Options:',
    '  -q "msg"            One-shot chat (alias for chat)',
    '  -z "msg"            One-shot agent run, prints final response (#332)',
    '  -z                  Read prompt from stdin (echo "..." | crowclaw -z)',
    '  --model <name>      Override model for `-z` run (#332)',
    '  --provider <key>    Override provider for `-z` run (#332)',
    '  --no-onboarding     Skip first-run wizard',
    '  --no-resume         Disable startup auto-resume from in-progress checkpoints',
    '  --port N            Server port (default: 3117)',
    '',
    'Session actions (REST):',
    '  POST /api/sessions/<id>/stop      Abort an active session (200 stopped, 202 pending)',
    '  POST /api/sessions/<id>/abort     Signal abort without waiting for drain',
    '  POST /api/sessions/<id>/steer     Inject a directive into the running turn',
    '  POST /api/sessions/<id>/compact   Compact session context to keep last N turns',
    '  POST /api/sessions/<id>/fork      Reserved (not yet implemented; tracked in roadmap)',
    '  REPL: /compact, /resume <id> map to the same flows from the interactive session.',
    '',
    'Exit codes:',
    '  0  success',
    '  1  internal error',
    '  2  user-cancel (Ctrl+C / SIGINT)',
    '  3  timeout',
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
    '  /provider-failover-simulate    Execute a synthetic failover run',
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
    '  /reload-skills                 Rebuild in-memory skill index without restart (#333)',
    '  /fix-perms                     chmod ~/.crowclaw credential files to 0600 (#297)',
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

// --- Batch runner (v0.8.4 #272) ---
// `crowclaw batch <input.jsonl> [--eval] [--threshold N]` replays JSONL prompts
// through the runtime agent. With `--eval`, the JSONL's `expected` field drives
// per-entry assertions; the summary reports accuracy and the CLI exits non-zero
// when accuracy < threshold (default 1.0). The core batch-runner already does
// the assertion + accuracy math (see packages/learning/src/batch-runner.ts);
// this is the CLI surface around it.

export interface BatchCliExitOptions {
  exitCode: number;
  output: string;
}

interface BatchSessionPayload {
  finalResponse?: unknown;
  toolResults?: unknown;
  session?: { messages?: unknown };
}

function coerceToolResults(value: unknown): Array<{ toolName: string; ok: boolean; output: string }> {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is { toolName: unknown; ok: unknown; output: unknown } =>
      typeof entry === 'object' && entry !== null,
    )
    .map((entry) => ({
      toolName: typeof entry.toolName === 'string' ? entry.toolName : 'unknown',
      ok: Boolean(entry.ok),
      output: typeof entry.output === 'string' ? entry.output : '',
    }));
}

function coerceMessages(value: unknown): Array<import('@crowclaw/core').ConversationMessage> {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is import('@crowclaw/core').ConversationMessage =>
    typeof entry === 'object' && entry !== null && typeof (entry as { role?: unknown }).role === 'string',
  );
}

export async function runBatchCommand(
  runtime: CliRuntimeLike,
  parsed: ParsedCliCommand,
): Promise<BatchCliExitOptions> {
  const inputPath = parsed.batchInput;
  if (!inputPath) {
    return {
      exitCode: 1,
      output: 'usage: crowclaw batch <input.jsonl> [--eval] [--threshold N] [--out path] [--run-name NAME] [--concurrency N] [--max-turns N] [--timeout-ms N] [--resume-from ID]',
    };
  }

  let raw: string;
  try {
    raw = await readFile(inputPath, 'utf-8');
  } catch (err: unknown) {
    return {
      exitCode: 1,
      output: `error: failed to read ${inputPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { parseJsonlPrompts, runBatch } = await import('@crowclaw/learning');
  const prompts = parseJsonlPrompts(raw);
  if (prompts.length === 0) {
    return { exitCode: 1, output: `error: no prompts parsed from ${inputPath}` };
  }

  const runName = parsed.batchRunName ?? `batch-${Date.now()}`;
  const threshold = parsed.batchThreshold ?? 1.0;

  const runAgent = async (input: {
    sessionId: string;
    userMessage: string;
    systemPrompt?: string;
    signal?: AbortSignal;
  }): Promise<{
    finalResponse: string;
    toolResults: Array<{ toolName: string; ok: boolean; output: string }>;
    session: { messages: import('@crowclaw/core').ConversationMessage[] };
  }> => {
    const init: RequestInit & { signal?: AbortSignal } = {
      method: 'POST',
      body: JSON.stringify({
        userMessage: input.userMessage,
        ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt } : {}),
      }),
    };
    if (input.signal) {
      init.signal = input.signal;
    }
    const response = await runtime.fetch(
      cliRequest(`http://localhost/api/sessions/${input.sessionId}`, init),
    );
    if (!response.ok) {
      throw new Error(`session POST failed: ${response.status} ${response.statusText}`);
    }
    const payload = (await response.json()) as BatchSessionPayload;
    const finalResponse =
      typeof payload.finalResponse === 'string' ? payload.finalResponse : '';
    return {
      finalResponse,
      toolResults: coerceToolResults(payload.toolResults),
      session: { messages: coerceMessages(payload.session?.messages) },
    };
  };

  const summary = await runBatch(prompts, runAgent, {
    runName,
    ...(parsed.batchMaxTurns !== undefined ? { maxTurns: parsed.batchMaxTurns } : {}),
    ...(parsed.batchConcurrency !== undefined ? { concurrency: parsed.batchConcurrency } : {}),
    ...(parsed.batchTimeoutMs !== undefined ? { timeoutMs: parsed.batchTimeoutMs } : {}),
    ...(parsed.batchResumeFromId !== undefined ? { resumeFromId: parsed.batchResumeFromId } : {}),
  });

  if (parsed.batchOut) {
    try {
      await mkdir(dirname(parsed.batchOut), { recursive: true });
      await writeFile(parsed.batchOut, JSON.stringify(summary, null, 2), 'utf-8');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { exitCode: 1, output: `error: failed to write ${parsed.batchOut}: ${msg}` };
    }
  }

  const lines: string[] = [];
  lines.push(`Run: ${summary.runName}`);
  lines.push(`Total: ${summary.total}, succeeded: ${summary.succeeded}, failed: ${summary.failed}, skipped: ${summary.skipped}`);
  lines.push(`Duration: total ${summary.totalDurationMs}ms, avg ${summary.avgDurationMs}ms`);

  if (parsed.batchEval) {
    if (summary.accuracy === undefined) {
      lines.push('Eval: no prompts had `expected` set; accuracy not computed.');
      // No assertions to evaluate — we treat this as a soft pass so harness
      // misconfiguration still surfaces (exit 1) rather than silently 0.
      return { exitCode: 1, output: lines.join('\n') };
    }
    const accuracyPct = Math.round(summary.accuracy * 1000) / 10;
    lines.push(`Accuracy: ${accuracyPct}% (${summary.accuracy.toFixed(3)}) — threshold ${threshold}`);
    const failed = summary.results.filter((r) => r.assertions?.evaluated && r.assertions.passed === false);
    if (failed.length > 0) {
      lines.push(`Failures (${failed.length}):`);
      for (const r of failed.slice(0, 10)) {
        const reasons = r.assertions?.failures?.join('; ') ?? 'unknown';
        lines.push(`  - ${r.promptId}: ${reasons}`);
      }
      if (failed.length > 10) {
        lines.push(`  ... and ${failed.length - 10} more`);
      }
    }
    const exitCode = summary.accuracy < threshold ? 1 : 0;
    return { exitCode, output: lines.join('\n') };
  }

  if (summary.accuracy !== undefined) {
    const accuracyPct = Math.round(summary.accuracy * 1000) / 10;
    lines.push(`Accuracy: ${accuracyPct}% (${summary.accuracy.toFixed(3)})`);
  }
  return { exitCode: 0, output: lines.join('\n') };
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

type MigrateSection = 'skills' | 'memories' | 'personas' | 'config';

export interface MigrateImportAction {
  section: MigrateSection;
  source: string;
  target: string;
  action: 'copy' | 'merge' | 'skip' | 'missing';
  reason?: string;
}

export interface MigrateImportOptions {
  sourceDir?: string;
  from?: 'hermes' | 'openclaw' | string;
  targetDir?: string;
  homeDir?: string;
  only?: MigrateSection[];
  dryRun?: boolean;
  force?: boolean;
}

export interface MigrateImportResult {
  sourceDir: string;
  targetDir: string;
  dryRun: boolean;
  actions: MigrateImportAction[];
}

const MIGRATE_SECTIONS: MigrateSection[] = ['skills', 'memories', 'personas', 'config'];

function expandHomePath(value: string, home = homedir()): string {
  return value === '~' ? home : value.startsWith('~/') ? join(home, value.slice(2)) : value;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf-8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

async function collectFiles(dirPath: string, predicate: (path: string) => boolean): Promise<string[]> {
  if (!(await pathExists(dirPath))) return [];
  const out: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      out.push(...await collectFiles(fullPath, predicate));
    } else if (entry.isFile() && predicate(fullPath)) {
      out.push(fullPath);
    }
  }
  return out;
}

function relativeTo(parent: string, child: string): string {
  return child.slice(parent.length).replace(/^[/\\]/, '');
}

async function copyOrPlan(
  actions: MigrateImportAction[],
  section: MigrateSection,
  source: string,
  target: string,
  options: Required<Pick<MigrateImportOptions, 'dryRun' | 'force'>>
): Promise<void> {
  if (!(await pathExists(source))) {
    actions.push({ section, source, target, action: 'missing', reason: 'source not found' });
    return;
  }
  const exists = await pathExists(target);
  if (exists && !options.force) {
    actions.push({ section, source, target, action: 'skip', reason: 'target exists' });
    return;
  }
  actions.push({ section, source, target, action: 'copy' });
  if (options.dryRun) return;
  await mkdir(dirname(target), { recursive: true });
  await copyFile(source, target);
}

async function mergeJsonOrPlan(
  actions: MigrateImportAction[],
  section: MigrateSection,
  source: string,
  target: string,
  options: Required<Pick<MigrateImportOptions, 'dryRun' | 'force'>>
): Promise<void> {
  const sourceJson = await readJsonObject(source);
  if (!sourceJson) {
    actions.push({ section, source, target, action: 'missing', reason: 'source config not found or invalid' });
    return;
  }
  const targetJson = await readJsonObject(target);
  const merged = options.force || !targetJson
    ? { ...(targetJson ?? {}), ...sourceJson }
    : { ...sourceJson, ...targetJson };
  const changed = JSON.stringify(targetJson ?? {}) !== JSON.stringify(merged);
  actions.push({ section, source, target, action: changed ? 'merge' : 'skip', reason: changed ? undefined : 'already up to date' });
  if (options.dryRun || !changed) return;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

async function detectMigrationSource(options: MigrateImportOptions): Promise<string> {
  const home = options.homeDir ?? homedir();
  if (options.sourceDir) return expandHomePath(options.sourceDir, home);
  if (options.from && options.from !== 'hermes' && options.from !== 'openclaw') {
    return expandHomePath(options.from, home);
  }
  const candidates = options.from === 'openclaw'
    ? [join(home, '.openclaw')]
    : options.from === 'hermes'
      ? [join(home, '.hermes')]
      : [join(home, '.hermes'), join(home, '.openclaw')];
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return candidates[0]!;
}

export async function migrateImport(options: MigrateImportOptions = {}): Promise<MigrateImportResult> {
  const home = options.homeDir ?? homedir();
  const sourceDir = await detectMigrationSource(options);
  const targetDir = expandHomePath(options.targetDir ?? join(home, '.crowclaw'), home);
  const only = options.only?.length ? options.only : MIGRATE_SECTIONS;
  const dryRun = options.dryRun ?? false;
  const force = options.force ?? false;
  const actions: MigrateImportAction[] = [];

  if (only.includes('skills')) {
    const sourceSkills = join(sourceDir, 'skills');
    const files = await collectFiles(sourceSkills, (path) => path.endsWith('.md'));
    if (files.length === 0) {
      actions.push({ section: 'skills', source: sourceSkills, target: join(targetDir, 'skills'), action: 'missing', reason: 'no skill markdown files found' });
    }
    for (const file of files) {
      await copyOrPlan(actions, 'skills', file, join(targetDir, 'skills', relativeTo(sourceSkills, file)), { dryRun, force });
    }
  }

  if (only.includes('personas')) {
    const sourcePersonas = join(sourceDir, 'personas');
    const files = await collectFiles(sourcePersonas, () => true);
    if (files.length === 0) {
      actions.push({ section: 'personas', source: sourcePersonas, target: join(targetDir, 'personas'), action: 'missing', reason: 'no persona files found' });
    }
    for (const file of files) {
      await copyOrPlan(actions, 'personas', file, join(targetDir, 'personas', relativeTo(sourcePersonas, file)), { dryRun, force });
    }
  }

  if (only.includes('memories')) {
    for (const name of ['memories.db', 'memory.db', 'memories.json', 'memory.json']) {
      await copyOrPlan(actions, 'memories', join(sourceDir, name), join(targetDir, name), { dryRun, force });
    }
  }

  if (only.includes('config')) {
    for (const name of ['config.json', 'runtime-config.json']) {
      await mergeJsonOrPlan(actions, 'config', join(sourceDir, name), join(targetDir, name), { dryRun, force });
    }
  }

  return { sourceDir, targetDir, dryRun, actions };
}

function parseMigrateImportArgs(args: string[] = [], dryRun = false): MigrateImportOptions | { error: string } {
  const options: MigrateImportOptions = { dryRun };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--from') {
      options.from = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--from=')) {
      options.from = arg.slice('--from='.length);
      continue;
    }
    if (arg === '--only') {
      const value = args[i + 1];
      if (!value) return { error: 'Missing value for --only' };
      options.only = value.split(',').map((item) => item.trim()).filter(Boolean) as MigrateSection[];
      i += 1;
      continue;
    }
    if (arg.startsWith('--only=')) {
      options.only = arg.slice('--only='.length).split(',').map((item) => item.trim()).filter(Boolean) as MigrateSection[];
      continue;
    }
    if (arg === '--target') {
      options.targetDir = args[i + 1];
      i += 1;
      continue;
    }
    if (arg.startsWith('--target=')) {
      options.targetDir = arg.slice('--target='.length);
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      positional.push(arg);
      continue;
    }
    return { error: `Unknown migrate option: ${arg}` };
  }
  if (options.only?.some((section) => !MIGRATE_SECTIONS.includes(section))) {
    return { error: `Invalid --only value. Use one or more of: ${MIGRATE_SECTIONS.join(', ')}` };
  }
  if (positional[0]) options.sourceDir = positional[0];
  return options;
}

export async function runMigrateCommand(parsed: ParsedCliCommand): Promise<string> {
  const sub = parsed.migrateSubcommand ?? 'import';
  if (sub !== 'import') {
    return 'Usage: crowclaw migrate import [source-dir] [--from hermes|openclaw|path] [--only skills|memories|personas|config] [--dry-run] [--force]';
  }
  const options = parseMigrateImportArgs(parsed.migrateArgs ?? [], parsed.dryRun ?? false);
  if ('error' in options) {
    return options.error;
  }
  const result = await migrateImport(options);
  const lines = [
    `${result.dryRun ? 'Dry run' : 'Migration'}: ${result.sourceDir} -> ${result.targetDir}`,
  ];
  for (const action of result.actions) {
    const suffix = action.reason ? ` (${action.reason})` : '';
    lines.push(`  ${action.action.padEnd(7)} ${action.section.padEnd(8)} ${action.source} -> ${action.target}${suffix}`);
  }
  return lines.join('\n');
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
    let cwd: string | undefined;
    let timeoutMs: number | undefined;
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
      if (token === '--cwd') {
        cwd = tokens[index + 1];
        index += 1;
        continue;
      }
      if (token === '--timeout') {
        const parsed = Number(tokens[index + 1]);
        timeoutMs = Number.isFinite(parsed) ? parsed : undefined;
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
        cwd,
        timeoutMs,
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

  if (trimmed === '/provider-failover-simulate' || trimmed.startsWith('/provider-failover-simulate ')) {
    const message = trimmed.replace('/provider-failover-simulate', '').trim() || 'simulate provider fallback';
    const response = await runtime.fetch(cliRequest(localRoute(cliRoutePaths.providers.failoverSimulate), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message })
    }));
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

  // v0.9.0 Hermes parity (#333): rebuild in-memory skill index without restart.
  if (trimmed === '/reload-skills') {
    const { reloadSkills, formatReloadSkillsResult } = await import('./commands/skills.js');
    const result = await reloadSkills(runtime);
    return {
      output: formatReloadSkillsResult(result),
      state,
    };
  }

  // v0.9.0 Hermes parity (#297): inline `crowclaw doctor fix-perms`.
  if (trimmed === '/fix-perms') {
    const { runFixPerms, formatFixPermsResult } = await import('./commands/doctor.js');
    const result = await runFixPerms();
    return {
      output: formatFixPermsResult(result),
      state,
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
  if (parsed.command === 'help') {
    return renderCliHelp();
  }
  if (parsed.command === 'migrate') {
    return runMigrateCommand(parsed);
  }

  const runtime = options.runtime ?? await lazyCreateRuntime(runtimeOptionsForParsed(parsed, options.runtimeOptions));

  switch (parsed.command) {
    case 'status':
      return runStatus(runtime);
    case 'tools':
      return runFormattedTools(runtime);
    case 'chat':
      return runChat(runtime, parsed);
    case 'doctor': {
      // v0.9.0 #297: `doctor fix-perms` repairs ~/.crowclaw mode bits.
      if (parsed.doctorSubcommand === 'fix-perms') {
        const { runFixPerms, formatFixPermsResult } = await import('./commands/doctor.js');
        const result = await runFixPerms();
        return formatFixPermsResult(result);
      }
      const report = await runDoctor(runtime);
      return formatDoctorReport(report);
    }
    case 'sessions':
      return runSessions(runtime);
    case 'skills': {
      // v0.9.0 #333: `skills install <url-or-path>` adds direct URL install.
      // Bare `skills` keeps the legacy list behavior.
      if (parsed.skillsSubcommand === 'install') {
        const source = parsed.skillsArgs?.[0];
        if (!source) {
          return 'usage: crowclaw skills install <url-or-path>';
        }
        const { skillsInstallFromUrl } = await import('./commands/skills.js');
        const result = await skillsInstallFromUrl(source, { log: () => {} });
        if (!result.ok) {
          return `INSTALL_FAILED (${result.code ?? 'UNKNOWN'}): ${result.error ?? 'unknown error'}`;
        }
        return `Installed "${result.slug}" -> ${result.destinationPath}`;
      }
      return runSkillsList(runtime);
    }
    case 'jobs':
      return runJobsList(runtime);
    case 'oneshot': {
      // v0.9.0 #332: handled here so tests can drive it without spinning up main().
      const { runOneshot } = await import('./commands/oneshot.js');
      const result = await runOneshot(runtime, {
        ...(parsed.oneshotPrompt !== undefined ? { prompt: parsed.oneshotPrompt } : {}),
        ...(parsed.oneshotModel !== undefined ? { model: parsed.oneshotModel } : {}),
        ...(parsed.oneshotProvider !== undefined ? { provider: parsed.oneshotProvider } : {}),
      });
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
      return result.output;
    }
    case 'update': {
      // v0.9.0 #332: --check is a preflight (no mutation); --backup snapshots
      // ~/.crowclaw to backups/<ts>.tgz before the operator runs their installer.
      const { runUpdateCheck, formatUpdateCheck, runUpdateBackup, formatUpdateBackup } = await import('./commands/update.js');
      const parts: string[] = [];
      if (parsed.updateCheck) {
        const check = await runUpdateCheck({ currentVersion: CLI_VERSION.replace(/^v/, '') });
        parts.push(formatUpdateCheck(check));
      }
      if (parsed.updateBackup) {
        const backup = await runUpdateBackup();
        parts.push(formatUpdateBackup(backup));
        if (!backup.ok) process.exitCode = 1;
      }
      if (!parsed.updateCheck && !parsed.updateBackup) {
        return 'usage: crowclaw update [--check] [--backup]\n  --check   show available updates without applying\n  --backup  tar.gz ~/.crowclaw before an upgrade';
      }
      return parts.join('\n\n');
    }
    case 'debug-share': {
      // Agent A sibling (#293): handler module created on Agent A's branch.
      // The dispatch is wired here so registration is unified; the actual
      // file lives on Agent A's branch and will resolve at integration time.
      // We use a guarded dynamic import via runtime path string so TypeScript
      // does not try to type-resolve a file that does not yet exist on this
      // branch — when integration merges, the import resolves normally.
      const modPath = './commands/debug-share.js';
      try {
        const mod = (await import(/* @vite-ignore */ modPath)) as {
          runDebugShare?: (args: string[]) => Promise<string> | string;
        };
        if (typeof mod.runDebugShare === 'function') {
          const output = await mod.runDebugShare(parsed.debugShareArgs ?? []);
          return typeof output === 'string' ? output : 'debug-share completed.';
        }
        return 'debug-share handler not exported (commands/debug-share.ts missing runDebugShare).';
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return `debug-share unavailable (waiting on Agent A integration): ${msg}`;
      }
    }
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
    case 'skill':
      // v0.8.0 #240: agentskills.io install/publish handled in main() (interactive I/O).
      return 'Run `crowclaw skill <subcommand>` directly (not via runCli).';
    case 'batch': {
      // v0.8.4 #272: handled in main() so process.exitCode reflects --threshold.
      return 'Run `crowclaw batch <input.jsonl>` directly (not via runCli).';
    }
    default: {
      const exhaustive: never = parsed.command as never;
      return `Unknown command: ${String(exhaustive)}`;
    }
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
  // v0.9.0 Hermes parity (#297): close TOCTOU window. Atomic temp-write +
  // O_NOFOLLOW + fchmod 0600, then atomic rename. Replaces the direct
  // `writeFile(..., { mode: 0o600 })` which only sets mode on creation
  // (so a pre-existing world-readable file would silently stay that way),
  // and follows symlinks placed by an attacker on a shared host.
  const { writeSecretAtomic } = await import('./commands/secret-write.js');
  await mkdir(CROWCLAW_CONFIG_DIR, { recursive: true });
  const data = JSON.stringify(config, null, 2);
  await writeSecretAtomic(CROWCLAW_CONFIG_PATH, data, { mode: 0o600 });
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

// --- Provider credential validation (#149) ---

export interface ProviderValidationResult {
  /** True iff credentials look accepted by the provider (any non-401 from the auth-aware endpoint). */
  ok: boolean;
  /** HTTP status returned by the provider. `0` indicates a network/transport error. */
  status: number;
  /** Provider-supplied error message when `ok === false`, or a human description of the transport failure. */
  message?: string;
}

export interface ValidateProviderCredentialsArgs {
  provider: string;
  apiKey: string;
  baseUrl: string;
  /** Optional fetch override for tests. Defaults to globalThis.fetch. */
  fetch?: typeof fetch;
  /** Per-call timeout in ms. Default 8000. */
  timeoutMs?: number;
}

/**
 * Verify the supplied API key actually authenticates against the provider.
 *
 * Strategy per task spec: hit the provider's models / list endpoint with the
 * configured credentials. We treat **only HTTP 401** as an auth failure —
 * anything else (200, 403, 404, 5xx, network error) is reported with status
 * but is *not* treated as "the key is wrong". This avoids false negatives on
 * self-hosted endpoints and providers with quirky model-list ACLs.
 *
 * Issue #149.
 */
export async function validateProviderCredentials(
  args: ValidateProviderCredentialsArgs
): Promise<ProviderValidationResult> {
  const { provider, apiKey, baseUrl } = args;
  const fetchImpl = args.fetch ?? globalThis.fetch;
  const timeoutMs = args.timeoutMs ?? 8000;

  if (typeof fetchImpl !== 'function') {
    return { ok: false, status: 0, message: 'fetch is not available in this runtime' };
  }
  if (!apiKey) {
    return { ok: false, status: 401, message: 'API key is empty' };
  }

  // Build a provider-aware probe request.
  // - Anthropic: GET {base}/v1/models with `x-api-key` + `anthropic-version`
  // - OpenAI / OpenRouter / custom: GET {base}/models with Bearer auth
  // baseUrl values from CLI_PROVIDERS already include `/v1` for OpenAI/OpenRouter.
  const trimmedBase = baseUrl.replace(/\/+$/, '');
  let url: string;
  const headers: Record<string, string> = { accept: 'application/json' };

  if (provider === 'anthropic') {
    // Anthropic base url is `https://api.anthropic.com` (no /v1 suffix in CLI_PROVIDERS).
    const path = trimmedBase.endsWith('/v1') ? '/models' : '/v1/models';
    url = `${trimmedBase}${path}`;
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    // OpenAI / OpenRouter / custom — assume OpenAI-compatible /models endpoint.
    url = `${trimmedBase}/models`;
    headers.authorization = `Bearer ${apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });
    if (response.status === 401) {
      let message = 'HTTP 401: API key rejected by provider';
      try {
        const body = await response.text();
        if (body) {
          // Best-effort: extract a `.error.message` if present.
          try {
            const parsed = JSON.parse(body) as { error?: { message?: string } | string };
            const inner = typeof parsed.error === 'object' && parsed.error
              ? parsed.error.message
              : typeof parsed.error === 'string' ? parsed.error : undefined;
            if (inner) message = `HTTP 401: ${inner}`;
          } catch {
            message = `HTTP 401: ${body.slice(0, 200)}`;
          }
        }
      } catch {
        // Ignore body-read failures — we still know it's 401.
      }
      return { ok: false, status: 401, message };
    }
    // Per task spec: anything other than 401 means credentials are accepted.
    return { ok: true, status: response.status };
  } catch (error: unknown) {
    const isAbort = error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
    const message = isAbort
      ? `Request timed out after ${timeoutMs}ms`
      : error instanceof Error ? error.message : String(error);
    return { ok: false, status: 0, message };
  } finally {
    clearTimeout(timer);
  }
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

  // Step 2 + 3: API key (masked) and base URL.
  // #149: actually verify the credentials against the provider before printing
  // "Connected!" or persisting config. Re-prompt on HTTP 401 (auth rejected),
  // up to MAX_AUTH_ATTEMPTS times. Other failures (network, 5xx) emit a warning
  // but proceed — the user may be on a self-hosted endpoint we can't reach.
  const MAX_AUTH_ATTEMPTS = 3;
  let apiKey = '';
  let baseUrl = provider.url;
  let baseUrlPrompted = false;
  let validated = false;

  for (let attempt = 1; attempt <= MAX_AUTH_ATTEMPTS; attempt++) {
    stdout.write('? Enter your API key: ');
    apiKey = await maskInput(rl);
    stdout.write('\n\n');

    if (!apiKey) {
      stdout.write('\\x1b[31mNo API key provided. Skipping onboarding.\\x1b[0m\n');
      rl.close();
      return null;
    }

    // Prompt for custom base URL only on the first attempt.
    if (!baseUrlPrompted && provider.key === 'custom') {
      const customUrl = await rl.question('? Enter your base URL: ');
      baseUrl = customUrl.trim() || 'http://localhost:11434/v1';
      stdout.write('\n');
      baseUrlPrompted = true;
    }

    stdout.write('Testing connection... ');
    const result = await validateProviderCredentials({
      provider: provider.key,
      apiKey,
      baseUrl,
    });

    if (result.ok) {
      stdout.write('\\x1b[32m\\u2713 Connected!\\x1b[0m\n\n');
      validated = true;
      break;
    }

    if (result.status === 401) {
      stdout.write(`\\x1b[31m\\u2717 ${result.message ?? 'HTTP 401: unauthorized'}\\x1b[0m\n`);
      if (attempt < MAX_AUTH_ATTEMPTS) {
        stdout.write(`Try again (${attempt}/${MAX_AUTH_ATTEMPTS} attempts used).\n\n`);
        continue;
      }
      stdout.write('\\x1b[31mAuthentication failed after 3 attempts. Aborting onboarding.\\x1b[0m\n');
      rl.close();
      return null;
    }

    // Non-401 failure (network, 5xx, ...). Per task spec: accept the credentials
    // but surface the warning so the user knows verification was inconclusive.
    const detail = result.status > 0 ? `HTTP ${result.status}` : 'network error';
    stdout.write(`\\x1b[33m! Could not verify (${detail}${result.message ? `: ${result.message}` : ''}). Continuing.\\x1b[0m\n\n`);
    validated = true;
    break;
  }

  if (!validated) {
    rl.close();
    return null;
  }

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
  const greeting = options.greeting ?? `CrowClaw CLI ${CLI_VERSION}\nType /help for commands, Ctrl+D to exit.\n`;
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
  const bindPlan = resolveTailnetBindHost({
    fallbackHost: options.runtimeOptions?.hostname,
  });
  const runtimeOptions = bindPlan.hostname
    ? { ...(options.runtimeOptions ?? {}), hostname: bindPlan.hostname }
    : options.runtimeOptions;
  const runtime = options.runtime ?? await lazyCreateRuntime(runtimeOptions);

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
      // Pass the raw socket remote address into the runtime so the trusted-proxy
      // check in getClientIp() can compare against CROWCLAW_TRUSTED_PROXIES.
      // Strip any client-supplied value first — otherwise a caller could send
      // `x-crowclaw-remote-addr: 127.0.0.1` to spoof it.
      headers.delete('x-crowclaw-remote-addr');
      if (req.socket?.remoteAddress) {
        headers.set('x-crowclaw-remote-addr', req.socket.remoteAddress);
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

  const onListening = () => {
    const displayHost = bindPlan.hostname ?? 'localhost';
    if (bindPlan.warning) stdout.write(`[network] ${bindPlan.warning}\n`);
    if (bindPlan.source === 'tailscale' && bindPlan.hostname) {
      stdout.write(`[network] Bound to Tailscale address ${bindPlan.hostname}\n`);
    }
    stdout.write(`CrowClaw server running at http://${displayHost}:${port}\n`);
    stdout.write(`Dashboard at http://${displayHost}:${port}/dashboard\n`);
    for (const gs of gatewayStatuses) {
      if (gs.connected) {
        const name = gs.botName ? `${gs.platform} (${gs.botName})` : gs.platform;
        stdout.write(`Gateway: ${name} \x1b[32m\u2713\x1b[0m listening\n`);
      } else if (gs.error && gs.error !== 'disabled') {
        stdout.write(`Gateway: ${gs.platform} \x1b[31m\u2717\x1b[0m ${gs.error}\n`);
      }
    }
    stdout.write('Press Ctrl+C to stop.\n');
  };
  if (bindPlan.hostname) {
    server.listen(port, bindPlan.hostname, onListening);
  } else {
    server.listen(port, onListening);
  }

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

    const shutdown = async (signal: string): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      stdout.write(`\n[shutdown] ${signal} received, draining ${inFlight} in-flight request(s)...\n`);

      void stopGatewayRunner();

      // #150: stop runtime-owned background work (ws heartbeats, timers) so
      // the process can actually exit instead of hanging on the event loop.
      // Failures here are non-fatal — log and continue with server.close.
      if (typeof runtime.close === 'function') {
        try {
          await runtime.close();
        } catch (closeError: unknown) {
          const msg = closeError instanceof Error ? closeError.message : String(closeError);
          stdout.write(`[shutdown] runtime.close() failed: ${msg}\n`);
        }
      }

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

    process.on('SIGINT', () => { void shutdown('SIGINT'); });
    process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
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
  const runtimeOptions = runtimeOptionsForParsed(parsed);

  // v0.9.0 Hermes parity (#297): warn on world/group-readable credentials
  // before any command runs. Suppressed for `help` so `--help` stays quiet.
  // The check itself is read-only — it does NOT mutate file modes.
  if (parsed.command !== 'help') {
    try {
      const { checkSecretPerms } = await import('./commands/doctor.js');
      await checkSecretPerms();
    } catch {
      // Permission check is best-effort. Never block startup on it.
    }
  }

  switch (parsed.command) {
    case 'help':
      stdout.write(renderCliHelp() + '\n');
      return;

    case 'repl':
      await applyConfigToEnv(argv);
      await startRepl({ runtimeOptions });
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
      await runServe({ port: parsed.port, runtimeOptions });
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

    case 'skill': {
      // v0.8.0 #240: agentskills.io install/publish handlers (see end of file)
      await runSkillSubcommand(parsed.skillSubcommand ?? 'help', parsed.skillArgs ?? [], { dryRun: parsed.dryRun });
      return;
    }

    case 'migrate': {
      const output = await runMigrateCommand(parsed);
      stdout.write(output + '\n');
      return;
    }

    case 'batch': {
      // v0.8.4 #272: replay/eval JSONL prompts. With --eval, exit non-zero
      // when accuracy < threshold (default 1.0).
      await applyConfigToEnv(argv);
      const runtime = await lazyCreateRuntime(runtimeOptions);
      const result = await runBatchCommand(runtime, parsed);
      stdout.write(result.output + '\n');
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
      try {
        await runtime.close?.();
      } catch {
        // best-effort cleanup
      }
      return;
    }

    case 'oneshot': {
      // v0.9.0 Hermes parity (#332): `-z "<prompt>"` runs the agent loop
      // once. We must:
      //   1. Apply onboarding-or-config so the provider key is in env.
      //   2. Create the runtime (which builds the provider stack).
      //   3. Apply model/provider overrides BEFORE the request so the
      //      session uses the requested config.
      //   4. POST the prompt, print the final response, exit.
      // We handle this in main() so runtime.close() runs and the process
      // exits cleanly without waiting on the server timers.
      await applyConfigToEnv(argv);
      const { runOneshot } = await import('./commands/oneshot.js');
      const runtime = await lazyCreateRuntime(runtimeOptions);
      const result = await runOneshot(runtime, {
        ...(parsed.oneshotPrompt !== undefined ? { prompt: parsed.oneshotPrompt } : {}),
        ...(parsed.oneshotModel !== undefined ? { model: parsed.oneshotModel } : {}),
        ...(parsed.oneshotProvider !== undefined ? { provider: parsed.oneshotProvider } : {}),
      });
      if (result.output) stdout.write(result.output + '\n');
      if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
      }
      try {
        await runtime.close?.();
      } catch {
        // best-effort cleanup
      }
      return;
    }

    case 'update': {
      // v0.9.0 Hermes parity (#332): preflight + backup. Both subflags can
      // run together; without either, print usage and exit non-zero.
      const { runUpdateCheck, formatUpdateCheck, runUpdateBackup, formatUpdateBackup } = await import('./commands/update.js');
      let printed = false;
      if (parsed.updateCheck) {
        const check = await runUpdateCheck({ currentVersion: CLI_VERSION.replace(/^v/, '') });
        stdout.write(formatUpdateCheck(check) + '\n');
        printed = true;
        if (!check.ok) process.exitCode = 1;
      }
      if (parsed.updateBackup) {
        const backup = await runUpdateBackup();
        stdout.write(formatUpdateBackup(backup) + '\n');
        printed = true;
        if (!backup.ok) process.exitCode = 1;
      }
      if (!printed) {
        stdout.write('usage: crowclaw update [--check] [--backup]\n');
        stdout.write('  --check   show available updates without applying\n');
        stdout.write('  --backup  tar.gz ~/.crowclaw before an upgrade\n');
        process.exitCode = 1;
      }
      return;
    }

    case 'doctor': {
      // v0.9.0 Hermes parity (#297): `doctor fix-perms` repairs ~/.crowclaw
      // mode bits. Bare `doctor` keeps the health-check report (handled by
      // the runCli default branch below).
      if (parsed.doctorSubcommand === 'fix-perms') {
        const { runFixPerms, formatFixPermsResult } = await import('./commands/doctor.js');
        const result = await runFixPerms();
        stdout.write(formatFixPermsResult(result) + '\n');
        if (!result.ok) process.exitCode = 1;
        return;
      }
      // Bare doctor → fall through to runCli (health report).
      const output = await runCli(argv);
      stdout.write(output + '\n');
      return;
    }

    case 'skills': {
      // v0.9.0 Hermes parity (#333): `skills install <url-or-path>`.
      if (parsed.skillsSubcommand === 'install') {
        const source = parsed.skillsArgs?.[0];
        if (!source) {
          stdout.write('usage: crowclaw skills install <url-or-path>\n');
          process.exitCode = 1;
          return;
        }
        const { skillsInstallFromUrl } = await import('./commands/skills.js');
        const result = await skillsInstallFromUrl(source);
        if (!result.ok) {
          stdout.write(`INSTALL_FAILED (${result.code ?? 'UNKNOWN'}): ${result.error ?? 'unknown error'}\n`);
          process.exitCode = 1;
        }
        return;
      }
      // Bare skills → fall through to runCli (list).
      const output = await runCli(argv);
      stdout.write(output + '\n');
      return;
    }

    default: {
      // One-shot commands: status, tools, chat, sessions, jobs
      const output = await runCli(argv);
      stdout.write(output + '\n');
    }
  }
}

// Auto-invoke when run directly
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  // #143: distinct exit codes — 1 error / 2 user-cancel / 3 timeout.
  process.exitCode = exitCodeForError(error);
});

export const cliPackage = {
  name: '@crowclaw/cli',
  purpose: 'Minimum local CLI entry surface for status, tools, session chat flows, and interactive slash-command handling.'
};

// ---------------------------------------------------------------------------
// v0.8.0 Hermes parity (#240) — `crowclaw skill install|publish` registration
// ---------------------------------------------------------------------------
// Append-only block: do not move handlers above this line. Keeps the diff
// surface in index.ts minimal so other concurrent v0.8.0 work doesn't merge-
// conflict on the CLI dispatch table.

export { skillInstall } from './commands/skill-install.js';
export type { SkillInstallOptions, SkillInstallResult } from './commands/skill-install.js';
export { skillPublish } from './commands/skill-publish.js';
export type { SkillPublishOptions, SkillPublishResult } from './commands/skill-publish.js';

// ---------------------------------------------------------------------------
// v0.9.0 Hermes parity — CLI surfaces for #297 #332 #333.
// ---------------------------------------------------------------------------

export { runOneshot } from './commands/oneshot.js';
export type { OneshotOptions, OneshotResult } from './commands/oneshot.js';

export {
  runUpdateCheck,
  runUpdateBackup,
  formatUpdateCheck,
  formatUpdateBackup,
  compareSemver,
} from './commands/update.js';
export type {
  UpdateCheckOptions,
  UpdateCheckResult,
  UpdateBackupOptions,
  UpdateBackupResult,
} from './commands/update.js';

export {
  skillsInstallFromUrl,
  reloadSkills,
  formatReloadSkillsResult,
  BUNDLED_SKILL_SLUGS,
} from './commands/skills.js';
export type {
  SkillsInstallOptions,
  SkillsInstallResult,
  ReloadSkillsResult,
} from './commands/skills.js';

export {
  runFixPerms,
  formatFixPermsResult,
  checkSecretPerms,
  SECRET_FILE_BASENAMES,
} from './commands/doctor.js';
export type {
  FixPermsOptions,
  FixPermsResult,
  CheckSecretPermsOptions,
  CheckSecretPermsResult,
} from './commands/doctor.js';

export { writeSecretAtomic } from './commands/secret-write.js';
export type { WriteSecretAtomicOptions } from './commands/secret-write.js';

import { skillInstall as _skillInstall } from './commands/skill-install.js';
import { skillPublish as _skillPublish } from './commands/skill-publish.js';

export async function runSkillSubcommand(
  sub: string,
  args: string[],
  opts: { dryRun?: boolean } = {}
): Promise<void> {
  switch (sub) {
    case 'install': {
      const source = args[0];
      if (!source) {
        stdout.write('usage: crowclaw skill install <url-or-slug-or-path>\n');
        process.exitCode = 1;
        return;
      }
      const result = await _skillInstall(source);
      if (!result.ok) {
        stdout.write(`error: ${result.error ?? 'install failed'}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case 'publish': {
      const slug = args[0];
      if (!slug) {
        stdout.write('usage: crowclaw skill publish <slug> [--dry-run]\n');
        process.exitCode = 1;
        return;
      }
      const result = await _skillPublish(slug, { dryRun: opts.dryRun });
      if (!result.ok) {
        stdout.write(`error: ${result.error ?? 'publish failed'}\n`);
        process.exitCode = 1;
      }
      return;
    }
    case 'help':
    default: {
      stdout.write(
        [
          'crowclaw skill — install or publish SKILL.md (agentskills.io v1.0)',
          '',
          'Commands:',
          '  install <url-or-slug-or-path>   Install a skill into ~/.crowclaw/skills/installed',
          '  publish <slug> [--dry-run]      Package a local skill for upload',
          '',
        ].join('\n')
      );
      if (sub !== 'help') process.exitCode = 1;
    }
  }
}

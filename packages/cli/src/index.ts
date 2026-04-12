import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { readFile, writeFile, mkdir, access, constants, appendFile } from 'node:fs/promises';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import type { NodeRuntimeOptions } from '@crowclaw/runtime-node';

const HISTORY_DIR = join(homedir(), '.crowclaw');
const HISTORY_FILE_PATH = join(HISTORY_DIR, 'history');
const MAX_HISTORY_LINES = 1000;

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

export type CliCommandName = 'help' | 'status' | 'tools' | 'chat';

export interface ParsedCliCommand {
  command: CliCommandName;
  query?: string;
  sessionId?: string;
  continueSession?: boolean;
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
  '/skills',
  '/drafts',
  '/match-skills',
  '/auto-capture',
  '/publish-draft',
  '/unpublish-draft',
  '/skill-toggle',
  '/provider-models',
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
    prompts: '/api/mcp/prompts'
  },
  providers: {
    models: '/api/providers/models',
    route: '/api/providers/route'
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
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help' };
  }

  const [first, ...rest] = argv;
  if (first === 'status') {
    return { command: 'status' };
  }

  if (first === 'tools') {
    return { command: 'tools' };
  }

  const command: CliCommandName = first === 'chat' ? 'chat' : 'chat';
  let query: string | undefined;
  let sessionId: string | undefined;
  let continueSession = false;

  for (let index = first === 'chat' ? 0 : -1; index < rest.length; index += 1) {
    const value = rest[index]!;
    if (value === '-q' || value === '--query') {
      query = rest[index + 1];
      index += 1;
      continue;
    }
    if (value === '--session') {
      sessionId = rest[index + 1];
      index += 1;
      continue;
    }
    if (value === '--continue' || value === '--resume') {
      continueSession = true;
      continue;
    }
    if (!value.startsWith('-') && !query) {
      query = value;
    }
  }

  return {
    command,
    query,
    sessionId,
    continueSession
  };
}

export function renderCliHelp(): string {
  return [
    'CrowClaw CLI v0.1.0',
    '',
    'Usage:',
    '  crowclaw                        Start interactive REPL',
    '  crowclaw chat -q "message"      Send one chat message',
    '  crowclaw chat --session demo --continue  Resume a session',
    '  crowclaw status                 Check runtime health',
    '  crowclaw tools                  List registered tools',
    '',
    'Commands:',
    '  version                        Show CrowClaw runtime version metadata',
    '  status                         Check runtime health',
    '  doctor                         Inspect runtime/deployment status',
    '  preflight                      Run deployment/readiness checks',
    '  release-check                  Summarize release-candidate readiness',
    '  tools                          List registered tools',
    '  chat -q "message"              Send one chat message',
    '  chat --session demo --continue Resume a session by id',
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
    '  /bridge-*                      Bridge management commands',
    '  /browser-session               Browser session info',
    '  /mcp-*                         MCP management commands',
    '  /skills                        List resolved skills',
    '  /drafts                        List learning drafts',
    '  /match-skills <query>          Match published skills against a query',
    '  /auto-capture                  Auto-capture a draft from recent chat',
    '  /publish-draft <id>            Publish a learning draft',
    '  /unpublish-draft <id>          Unpublish a learning draft',
    '  /skill-toggle <slug> <on|off>  Enable or disable a skill',
    '  /provider-models               List known provider model metadata',
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
  const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.system.health)));
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
    const response = await runtime.fetch(new Request(`http://localhost/api/sessions/${sessionId}/history`));
    const session = await response.json() as { sessionId: string; messages: Array<{ role: string; content: string }> };
    return `Resumed ${session.sessionId} with ${session.messages.length} message(s).`;
  }

  const response = await runtime.fetch(new Request(`http://localhost/api/sessions/${sessionId}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userMessage: parsed.query })
  }));
  const payload = await response.json() as { finalResponse: string; session: { sessionId: string } };
  return `[${payload.session.sessionId}] ${payload.finalResponse}`;
}

export async function runCliInputLine(
  line: string,
  state: CliSessionState,
  options: CliRunOptions = {}
): Promise<{ output: string; state: CliSessionState }> {
  const runtime = options.runtime ?? await lazyCreateRuntime(options.runtimeOptions);
  const trimmed = line.trim();

  if (!trimmed) {
    return { output: 'Empty input.', state };
  }

  if (trimmed === '/help') {
    return { output: renderCliHelp(), state };
  }

  if (trimmed === '/version') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.system.version)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/status') {
    return { output: await runStatus(runtime), state };
  }

  if (trimmed === '/doctor') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.system.status)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/preflight') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.system.preflight)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/release-check') {
    const [doctor, preflight, bridge, bridgeCapabilities, browser, mcp] = await Promise.all([
      runtime.fetch(new Request(localRoute(cliRoutePaths.system.status))),
      runtime.fetch(new Request(localRoute(cliRoutePaths.system.preflight))),
      runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeProcess)}?sessionId=${state.sessionId}`)),
      runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeCapabilities)}?sessionId=${state.sessionId}`)),
      runtime.fetch(new Request(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`)),
      runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.inspect)))
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
    const response = await runtime.fetch(new Request(`http://localhost/api/sessions/${state.sessionId}/memories`));
    const payload = await response.json() as { records?: Array<{ summary?: string }> };
    return {
      output: JSON.stringify(payload.records ?? [], null, 2),
      state
    };
  }

  if (trimmed === '/overview') {
    const [doctor, preflight, bridge, browser, mcp] = await Promise.all([
      runtime.fetch(new Request(localRoute(cliRoutePaths.system.status))),
      runtime.fetch(new Request(localRoute(cliRoutePaths.system.preflight))),
      runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeStatus)}?sessionId=${state.sessionId}`)),
      runtime.fetch(new Request(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`)),
      runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.status)))
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.actions.todo), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/clarify' || trimmed.startsWith('/clarify ')) {
    const topic = trimmed.replace('/clarify', '').trim();
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.actions.clarify), {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.actions.sendMessage), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform, channel, text })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/vision' || trimmed.startsWith('/vision ')) {
    const prompt = trimmed.replace('/vision', '').trim();
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.media.vision), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/image.png', prompt })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/image' || trimmed.startsWith('/image ')) {
    const prompt = trimmed.replace('/image', '').trim();
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.media.image), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: prompt || 'generate an image' })
    }));
    return { output: JSON.stringify(await response.json(), null, 2), state };
  }

  if (trimmed === '/bridge-status') {
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeStatus)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-spawn') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.code.bridgeSpawn), {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.code.bridgePing), {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.code.bridgeTerminate), {
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
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeCapabilities)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-process') {
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeProcess)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/bridge-transcript') {
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.code.bridgeTranscript)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/browser-session') {
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.browser.session)}?sessionId=${state.sessionId}`));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-tools') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.tools)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-status') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.status)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-inspect') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.inspect)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-resources') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.resources)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/mcp-prompts') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.mcp.prompts)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-models') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.providers.models)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/provider-route' || trimmed.startsWith('/provider-route ')) {
    const message = trimmed.replace('/provider-route', '').trim();
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.providers.route), {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.skills.list)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed === '/drafts') {
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.learning.drafts)));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/match-skills ')) {
    const query = trimmed.replace('/match-skills ', '').trim();
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.learning.match), {
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
    const historyResponse = await runtime.fetch(new Request(`http://localhost/api/sessions/${state.sessionId}/history`));
    const session = await historyResponse.json() as { messages: Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; content: string; createdAt?: string }> };
    const title = `auto-${state.sessionId}`;
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.learning.autoCapture), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, messages: session.messages })
    }));
    const payload = await response.json();
    if (payload === null) {
      const fallback = await runtime.fetch(new Request(localRoute(cliRoutePaths.learning.drafts), {
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

  if (trimmed.startsWith('/publish-draft ')) {
    const id = trimmed.replace('/publish-draft ', '').trim();
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.learning.drafts)}/${id}`, {
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
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.learning.drafts)}/${id}/unpublish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    }));
    return {
      output: JSON.stringify(await response.json(), null, 2),
      state
    };
  }

  if (trimmed.startsWith('/skill-toggle ')) {
    const [slug, enabledFlag = 'on'] = trimmed.replace('/skill-toggle ', '').trim().split(/\s+/);
    const enabled = enabledFlag !== 'off';
    const response = await runtime.fetch(new Request(`${localRoute(cliRoutePaths.skills.list)}/${slug}/toggle`, {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.usage.summary)));
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
      const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.personas.list)));
      const payload = await response.json() as { personas: Array<{ name: string; active: boolean }> };
      const lines = (payload.personas ?? []).map(
        (p: { name: string; active: boolean }) => `${p.active ? '* ' : '  '}${p.name}`
      );
      return { output: lines.length > 0 ? lines.join('\n') : 'No personas registered.', state };
    }
    if (trimmed.startsWith('/persona switch ')) {
      const name = trimmed.replace('/persona switch ', '').trim();
      if (!name) return { output: 'Usage: /persona switch <name>', state };
      const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.personas.switch), {
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
    const response = await runtime.fetch(new Request(localRoute(cliRoutePaths.personas.active)));
    const payload = await response.json() as { name: string; identity?: Record<string, string> };
    const lines = [`Active persona: ${payload.name}`];
    if (payload.identity) {
      if (payload.identity.name) lines.push(`  Name: ${payload.identity.name}`);
      if (payload.identity.type) lines.push(`  Type: ${payload.identity.type}`);
      if (payload.identity.vibe) lines.push(`  Vibe: ${payload.identity.vibe}`);
    }
    return { output: lines.join('\n'), state };
  }

  // New slash commands

  if (trimmed === '/quit' || trimmed === '/exit') {
    return { output: '__REPL_EXIT__', state };
  }

  if (trimmed === '/compact') {
    const response = await runtime.fetch(new Request(`http://localhost/api/sessions/${state.sessionId}`, {
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
      return runTools(runtime);
    case 'chat':
      return runChat(runtime, parsed);
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

  // Trim history file on exit
  trimHistoryFileSync(historyFilePath);

  stdout.write('Goodbye.\n');
  rl.close();
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseCliArgs(argv);

  if (parsed.command === 'help') {
    stdout.write(renderCliHelp() + '\n');
    return;
  }

  // If no specific command or 'chat' without query, start REPL
  if (parsed.command === 'chat' && !parsed.query) {
    // First-run onboarding detection
    if (shouldRunOnboarding(argv)) {
      const hasConfig = await configFileExists();
      if (!hasConfig) {
        const config = await runCliOnboarding();
        if (config) {
          // Apply config to env for the current session
          process.env.CROWCLAW_API_KEY = config.apiKey;
          process.env.OPENROUTER_API_KEY = config.apiKey;
          process.env.OPENROUTER_BASE_URL = config.baseUrl;
          process.env.OPENROUTER_MODEL = config.model;
        }
      } else {
        // Load existing config
        const config = await loadConfig();
        if (config && !process.env.CROWCLAW_API_KEY) {
          process.env.CROWCLAW_API_KEY = config.apiKey;
          process.env.OPENROUTER_API_KEY = config.apiKey;
          process.env.OPENROUTER_BASE_URL = config.baseUrl;
          process.env.OPENROUTER_MODEL = config.model;
        }
      }
    }
    await startRepl();
    return;
  }

  // Otherwise run one-shot
  const output = await runCli(argv);
  stdout.write(output + '\n');
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

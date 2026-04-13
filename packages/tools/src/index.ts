import type { ToolCatalog, ToolDefinition, ToolExecutionContext, ToolExecutionResult, ToolExecutor, ToolManifest } from '@crowclaw/core';
import { validateFetchUrl } from '@crowclaw/core';

export { createDelegateTool, type DelegateToolOptions, type DelegateTaskResult, type DelegationResult } from './delegate.js';
export { createVisionAnalyzeTool, type VisionAnalysisOptions } from './vision.js';
import { createVisionAnalyzeTool as createVisionAnalyzeToolImpl } from './vision.js';
export { createImageGenerateTool, type ImageGenerationOptions } from './image-gen.js';
import { createImageGenerateTool as createImageGenerateToolImpl } from './image-gen.js';
export { createTtsTool, createTranscriptionTool, type TtsToolOptions, type TranscriptionToolOptions } from './voice.js';
export { executePipeline, createPipelineTool, BUILT_IN_PIPELINES, type PipelineDefinition, type PipelineStep, type PipelineResult } from './pipeline.js';
import {
  buildDiscordSendPayload,
  buildSlackSendPayload,
  buildSlackSendUrl,
  buildTelegramSendPayload,
  buildTelegramSendUrl
} from '@crowclaw/gateway';
import type { McpClient } from '@crowclaw/mcp';
import type { SchedulerStore } from '@crowclaw/scheduler';
import { createScheduledAgentJob } from '@crowclaw/scheduler';
import type { MemoryRecord, MemoryStore, SessionSearchStore } from '@crowclaw/storage';
import type { WorkspaceStore } from '@crowclaw/workspace';

type BackgroundProcessRecord = {
  pid: number;
  command: string;
  backend: 'local' | 'docker' | 'ssh';
  resolvedCommand: string;
  startedAt: string;
  status: 'running' | 'exited' | 'killed';
  exitCode?: number | null;
  handle: {
    kill(signal?: string): boolean;
    on?(event: string, cb: (code: number | null) => void): void;
  };
};

const backgroundProcesses = new Map<number, BackgroundProcessRecord>();

type TerminalBackendKind = 'local' | 'docker' | 'ssh' | 'modal' | 'daytona';

type TerminalBackendDescriptor = {
  backend: TerminalBackendKind;
  status: 'available' | 'planned';
  execution: 'native' | 'wrapped' | 'descriptor';
  description: string;
  requires?: string[];
};

type TerminalBackendStatus = TerminalBackendDescriptor & {
  installed: boolean;
  command?: string;
  details: string;
};

const TERMINAL_BACKENDS: TerminalBackendDescriptor[] = [
  {
    backend: 'local',
    status: 'available',
    execution: 'native',
    description: 'Executes commands directly on the local host process.'
  },
  {
    backend: 'docker',
    status: 'available',
    execution: 'wrapped',
    description: 'Wraps commands through docker exec/run for container-oriented execution.',
    requires: ['container or image']
  },
  {
    backend: 'ssh',
    status: 'available',
    execution: 'wrapped',
    description: 'Wraps commands through ssh for remote shell execution.',
    requires: ['target']
  },
  {
    backend: 'modal',
    status: 'planned',
    execution: 'descriptor',
    description: 'Reserved execution descriptor for future Modal backend integration.',
    requires: ['app or function reference']
  },
  {
    backend: 'daytona',
    status: 'planned',
    execution: 'descriptor',
    description: 'Reserved execution descriptor for future Daytona workspace execution.',
    requires: ['workspace or project reference']
  }
];

function normalizeTerminalBackend(input: unknown): TerminalBackendKind {
  return input === 'docker' || input === 'ssh' || input === 'modal' || input === 'daytona'
    ? input
    : 'local';
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function resolveTerminalCommandPlan(input: Record<string, unknown>): {
  ok: boolean;
  backend: TerminalBackendKind;
  command: string;
  resolvedCommand?: string;
  output?: string;
  metadata?: Record<string, unknown>;
} {
  const backend = normalizeTerminalBackend(input.backend);
  const command = typeof input.command === 'string' ? input.command : typeof input.raw === 'string' ? input.raw : '';
  if (!command) {
    return { ok: false, backend, command, output: 'Missing command.' };
  }

  if (backend === 'local') {
    return {
      ok: true,
      backend,
      command,
      resolvedCommand: command,
      metadata: { backend, mode: 'native' }
    };
  }

  if (backend === 'docker') {
    const container = typeof input.container === 'string' ? input.container.trim() : '';
    const image = typeof input.image === 'string' ? input.image.trim() : '';
    if (!container && !image) {
      return { ok: false, backend, command, output: 'Docker backend requires container or image.' };
    }
    const resolvedCommand = container
      ? `docker exec ${container} /bin/sh -lc ${quoteShell(command)}`
      : `docker run --rm ${image} /bin/sh -lc ${quoteShell(command)}`;
    return {
      ok: true,
      backend,
      command,
      resolvedCommand,
      metadata: { backend, container: container || undefined, image: image || undefined, mode: 'wrapped' }
    };
  }

  if (backend === 'ssh') {
    const target = typeof input.target === 'string' ? input.target.trim() : '';
    if (!target) {
      return { ok: false, backend, command, output: 'SSH backend requires target.' };
    }
    const resolvedCommand = `ssh ${target} /bin/sh -lc ${quoteShell(command)}`;
    return {
      ok: true,
      backend,
      command,
      resolvedCommand,
      metadata: { backend, target, mode: 'wrapped' }
    };
  }

  const descriptor = TERMINAL_BACKENDS.find((entry) => entry.backend === backend);
  return {
    ok: false,
    backend,
    command,
    output: `${backend} backend is planned but not yet executable.`,
    metadata: {
      backend,
      mode: 'descriptor',
      requires: descriptor?.requires ?? []
    }
  };
}

async function loadChildProcessModule(): Promise<{
  exec(command: string, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
  execFile(file: string, args: string[], options: { cwd?: string; maxBuffer?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
  spawn(command: string, args: string[], options: { stdio: 'ignore'; detached: boolean }): {
    pid?: number;
    kill(signal?: string): boolean;
    on?(event: string, cb: (code: number | null) => void): void;
    unref?(): void;
  };
}> {
  return import('node:child_process') as Promise<{
    exec(command: string, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
    execFile(file: string, args: string[], options: { cwd?: string; maxBuffer?: number }, callback: (error: Error | null, stdout: string, stderr: string) => void): unknown;
    spawn(command: string, args: string[], options: { stdio: 'ignore'; detached: boolean }): {
      pid?: number;
      kill(signal?: string): boolean;
      on?(event: string, cb: (code: number | null) => void): void;
      unref?(): void;
    };
  }>;
}

async function runGitCommand(args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  const cp = await loadChildProcessModule();
  return new Promise((resolve) => {
    cp.execFile('git', args, { cwd, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout ?? '',
        stderr: stderr ?? ''
      });
    });
  });
}

async function isCommandInstalled(command: string): Promise<boolean> {
  const cp = await loadChildProcessModule();
  return await new Promise<boolean>((resolve) => {
    cp.exec(`command -v ${command}`, (error) => {
      resolve(!error);
    });
  });
}

async function probeTerminalBackends(): Promise<TerminalBackendStatus[]> {
  const results: TerminalBackendStatus[] = [];
  for (const descriptor of TERMINAL_BACKENDS) {
    if (descriptor.backend === 'local') {
      results.push({
        ...descriptor,
        installed: true,
        details: 'Local process execution is always available inside the Node runtime.'
      });
      continue;
    }
    if (descriptor.backend === 'docker') {
      const installed = await isCommandInstalled('docker');
      results.push({
        ...descriptor,
        installed,
        command: 'docker',
        details: installed ? 'docker CLI detected for wrapped container execution.' : 'docker CLI not detected on PATH.'
      });
      continue;
    }
    if (descriptor.backend === 'ssh') {
      const installed = await isCommandInstalled('ssh');
      results.push({
        ...descriptor,
        installed,
        command: 'ssh',
        details: installed ? 'ssh client detected for remote execution wrapping.' : 'ssh client not detected on PATH.'
      });
      continue;
    }
    results.push({
      ...descriptor,
      installed: false,
      details: `${descriptor.backend} backend remains a planned descriptor surface.`
    });
  }
  return results;
}

function normalizeScope(input: Record<string, unknown>): 'session' | 'user' | 'workspace' | undefined {
  return input.scope === 'session' || input.scope === 'user' || input.scope === 'workspace'
    ? input.scope
    : undefined;
}

function defaultScopeKey(scope: 'session' | 'user' | 'workspace' | undefined, context: ToolExecutionContext): string | undefined {
  if (scope === 'session') {
    return context.sessionId;
  }
  if (scope === 'workspace') {
    return context.workspaceId;
  }
  return undefined;
}

export class ToolRegistry implements ToolCatalog, ToolExecutor {
  private readonly tools = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition): this {
    this.tools.set(definition.manifest.name, definition);
    return this;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  list(): ToolManifest[] {
    return [...this.tools.values()].map((tool) => tool.manifest);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  async execute(name: string, input: Record<string, unknown>, context: ToolExecutionContext): Promise<ToolExecutionResult> {
    const tool = this.get(name);
    if (!tool) {
      return {
        toolName: name,
        runtime: 'worker',
        ok: false,
        output: `Unknown tool: ${name}`,
        metadata: { knownTools: [...this.tools.keys()] }
      };
    }

    return tool.execute(input, context);
  }
}

export function createEchoTool(): ToolDefinition {
  return {
    manifest: {
      name: 'echo',
      description: 'Echoes the input payload back to the caller.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'The message to echo back' } }, required: ['message'] }
    },
    async execute(input) {
      return {
        toolName: 'echo',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(input)
      };
    }
  };
}

export function createTimeTool(): ToolDefinition {
  return {
    manifest: {
      name: 'time',
      description: 'Returns the current ISO timestamp.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      return {
        toolName: 'time',
        runtime: 'worker',
        ok: true,
        output: new Date().toISOString()
      };
    }
  };
}

export function createWebFetchTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.fetch',
      description: 'Fetches text content from a URL over HTTP.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to fetch' } }, required: ['url'] }
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'web.fetch',
          runtime: 'worker',
          ok: false,
          output: 'Missing url.'
        };
      }

      const urlCheck = validateFetchUrl(url);
      if (!urlCheck.safe) {
        return { toolName: 'web.fetch', runtime: 'worker', ok: false, output: `URL blocked: ${urlCheck.reason}` };
      }

      const response = await fetch(url, { signal: context.signal });
      const text = await response.text();
      return {
        toolName: 'web.fetch',
        runtime: 'worker',
        ok: response.ok,
        output: text,
        metadata: { status: response.status, url }
      };
    }
  };
}

export function createTerminalExecTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.exec',
      description: 'Executes a shell command through the selected terminal backend and returns stdout/stderr.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to execute' },
          raw: { type: 'string', description: 'Alias for command' },
          backend: { type: 'string', description: 'Terminal backend to use (local, docker, ssh, modal, daytona)' },
          container: { type: 'string', description: 'Docker container name (for docker backend)' },
          image: { type: 'string', description: 'Docker image name (for docker backend)' },
          target: { type: 'string', description: 'SSH target host (for ssh backend)' },
          planOnly: { type: 'boolean', description: 'If true, return the resolved command plan without executing' }
        },
        required: ['command']
      }
    },
    async execute(input) {
      const plan = resolveTerminalCommandPlan(input);
      if (!plan.ok || !plan.resolvedCommand) {
        return {
          toolName: 'terminal.exec',
          runtime: 'worker',
          ok: false,
          output: plan.output ?? 'Unable to resolve terminal command.',
          metadata: plan.metadata
        };
      }
      if (input.planOnly === true) {
        return {
          toolName: 'terminal.exec',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
            backend: plan.backend,
            command: plan.command,
            resolvedCommand: plan.resolvedCommand,
            mode: 'plan'
          }, null, 2),
          metadata: {
            ...plan.metadata,
            resolvedCommand: plan.resolvedCommand,
            planOnly: true
          }
        };
      }
      const resolvedCommand = plan.resolvedCommand;
      const childProcess = await loadChildProcessModule();
      return await new Promise<ToolExecutionResult>((resolve) => {
        childProcess.exec(resolvedCommand, (error, stdout, stderr) => {
          resolve({
            toolName: 'terminal.exec',
            runtime: 'worker',
            ok: !error,
            output: [stdout, stderr].filter(Boolean).join('').trim() || (error ? String(error.message) : ''),
            metadata: {
              backend: plan.backend,
              command: plan.command,
              resolvedCommand,
              exitCode: error ? 1 : 0,
              stdout,
              stderr
            }
          });
        });
      });
    }
  };
}

export function createTerminalBackgroundTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.background',
      description: 'Starts a shell command in the background.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command to run in the background' },
          raw: { type: 'string', description: 'Alias for command' },
          backend: { type: 'string', description: 'Terminal backend to use (local, docker, ssh, modal, daytona)' },
          container: { type: 'string', description: 'Docker container name (for docker backend)' },
          image: { type: 'string', description: 'Docker image name (for docker backend)' },
          target: { type: 'string', description: 'SSH target host (for ssh backend)' },
          planOnly: { type: 'boolean', description: 'If true, return the resolved command plan without executing' }
        },
        required: ['command']
      }
    },
    async execute(input) {
      const plan = resolveTerminalCommandPlan(input);
      if (!plan.ok || !plan.resolvedCommand) {
        return {
          toolName: 'terminal.background',
          runtime: 'worker',
          ok: false,
          output: plan.output ?? 'Unable to resolve terminal command.',
          metadata: plan.metadata
        };
      }
      if (input.planOnly === true) {
        return {
          toolName: 'terminal.background',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
            backend: plan.backend,
            command: plan.command,
            resolvedCommand: plan.resolvedCommand,
            mode: 'plan'
          }, null, 2),
          metadata: {
            ...plan.metadata,
            resolvedCommand: plan.resolvedCommand,
            planOnly: true
          }
        };
      }
      const resolvedCommand = plan.resolvedCommand;
      const childProcess = await loadChildProcessModule();
      const child = childProcess.spawn('/bin/sh', ['-lc', resolvedCommand], {
        stdio: 'ignore',
        detached: true
      });
      child.unref?.();
      const pid = child.pid ?? Math.floor(Math.random() * 100000);
      const record: BackgroundProcessRecord = {
        pid,
        command: plan.command,
        backend: plan.backend === 'local' || plan.backend === 'docker' || plan.backend === 'ssh' ? plan.backend : 'local',
        resolvedCommand,
        startedAt: new Date().toISOString(),
        status: 'running',
        handle: child
      };
      child.on?.('exit', (code) => {
        record.status = record.status === 'killed' ? 'killed' : 'exited';
        record.exitCode = code;
      });
      backgroundProcesses.set(pid, record);
      return {
        toolName: 'terminal.background',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify({ pid, command: plan.command, backend: plan.backend }, null, 2),
        metadata: { pid, command: plan.command, backend: plan.backend, resolvedCommand }
      };
    }
  };
}

export function createTerminalBackendsTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.backends',
      description: 'Lists available terminal backend descriptors and execution expectations.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      return {
        toolName: 'terminal.backends',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(TERMINAL_BACKENDS, null, 2),
        metadata: {
          count: TERMINAL_BACKENDS.length,
          available: TERMINAL_BACKENDS.filter((entry) => entry.status === 'available').map((entry) => entry.backend),
          planned: TERMINAL_BACKENDS.filter((entry) => entry.status === 'planned').map((entry) => entry.backend)
        }
      };
    }
  };
}

export function createTerminalBackendStatusTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.backendStatus',
      description: 'Reports backend availability/probe status for local, docker, ssh, and planned backends.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const statuses = await probeTerminalBackends();
      return {
        toolName: 'terminal.backendStatus',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(statuses, null, 2),
        metadata: {
          count: statuses.length,
          installed: statuses.filter((status) => status.installed).map((status) => status.backend),
          unavailable: statuses.filter((status) => !status.installed).map((status) => status.backend)
        }
      };
    }
  };
}

export function createTerminalProbeTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.probe',
      description: 'Runs a benign probe for a terminal backend to confirm basic execution availability.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium'
    },
    async execute(input) {
      const backend = normalizeTerminalBackend(input.backend);
      const cp = await loadChildProcessModule();
      const probeCommand = backend === 'local'
        ? 'printf "local-ok"'
        : backend === 'docker'
          ? 'docker --version'
          : backend === 'ssh'
            ? 'ssh -V'
            : '';
      if (!probeCommand) {
        return {
          toolName: 'terminal.probe',
          runtime: 'worker',
          ok: false,
          output: `${backend} backend is planned but has no executable probe yet.`,
          metadata: { backend, planned: true }
        };
      }
      return await new Promise<ToolExecutionResult>((resolve) => {
        cp.exec(probeCommand, (error, stdout, stderr) => {
          resolve({
            toolName: 'terminal.probe',
            runtime: 'worker',
            ok: !error,
            output: [stdout, stderr].filter(Boolean).join('').trim() || (error ? String(error.message) : ''),
            metadata: {
              backend,
              probeCommand,
              exitCode: error ? 1 : 0
            }
          });
        });
      });
    }
  };
}

export function createTerminalProcessesTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.processes',
      description: 'Lists tracked background shell processes.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const processes = [...backgroundProcesses.values()].map((record) => ({
        pid: record.pid,
        command: record.command,
        backend: record.backend,
        resolvedCommand: record.resolvedCommand,
        status: record.status,
        startedAt: record.startedAt,
        exitCode: record.exitCode
      }));
      return {
        toolName: 'terminal.processes',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(processes, null, 2),
        metadata: { count: processes.length }
      };
    }
  };
}

export function createTerminalKillTool(): ToolDefinition {
  return {
    manifest: {
      name: 'terminal.kill',
      description: 'Stops a tracked background shell process.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          pid: { type: 'number', description: 'Process ID of the background process to kill' }
        },
        required: ['pid']
      }
    },
    async execute(input) {
      const pid = typeof input.pid === 'number' ? input.pid : Number(input.pid);
      if (!pid || Number.isNaN(pid)) {
        return { toolName: 'terminal.kill', runtime: 'worker', ok: false, output: 'Missing pid.' };
      }
      const record = backgroundProcesses.get(pid);
      if (!record) {
        return { toolName: 'terminal.kill', runtime: 'worker', ok: false, output: `Unknown pid: ${pid}` };
      }
      record.handle.kill('SIGTERM');
      record.status = 'killed';
      return {
        toolName: 'terminal.kill',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify({ pid, status: 'killed' }, null, 2),
        metadata: { pid }
      };
    }
  };
}

function extractTag(html: string, pattern: RegExp): string | null {
  const match = html.match(pattern);
  return match?.[1]?.trim() ?? null;
}

function extractReadableText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<\/(p|div|section|article|h[1-6]|li|br)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function resolveHref(baseUrl: string, href: string): string | null {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }

  try {
    const resolved = new URL(trimmed, baseUrl);
    if (!['http:', 'https:'].includes(resolved.protocol)) {
      return null;
    }
    resolved.hash = '';
    return resolved.href;
  } catch {
    return null;
  }
}

export function createWebExtractMetadataTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.extractMetadata',
      description: 'Fetches a web page and extracts title/description metadata.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to extract metadata from' } }, required: ['url'] }
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'web.extractMetadata',
          runtime: 'worker',
          ok: false,
          output: 'Missing url.'
        };
      }

      const urlCheck = validateFetchUrl(url);
      if (!urlCheck.safe) {
        return { toolName: 'web.extractMetadata', runtime: 'worker', ok: false, output: `URL blocked: ${urlCheck.reason}` };
      }

      const response = await fetch(url, { signal: context.signal });
      const html = await response.text();
      const title = extractTag(html, /<title[^>]*>([^<]+)<\/title>/i)
        ?? extractTag(html, /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["'][^>]*>/i);
      const description = extractTag(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:description["'][^>]*>/i);
      const canonicalHref = extractTag(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["'][^>]*>/i);
      const imageHref = extractTag(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+name=["']twitter:image:src["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        ?? extractTag(html, /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image:src["'][^>]*>/i);
      const canonicalUrl = canonicalHref ? (resolveHref(url, canonicalHref) ?? canonicalHref) : null;
      const image = imageHref ? (resolveHref(url, imageHref) ?? imageHref) : null;

      return {
        toolName: 'web.extractMetadata',
        runtime: 'worker',
        ok: response.ok,
        output: JSON.stringify({ title, description, canonicalUrl, image }, null, 2),
        metadata: { status: response.status, url, title, description, canonicalUrl, image }
      };
    }
  };
}

export function createWebExtractLinksTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.extractLinks',
      description: 'Fetches a web page and extracts anchor hrefs.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to extract links from' } }, required: ['url'] }
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'web.extractLinks',
          runtime: 'worker',
          ok: false,
          output: 'Missing url.'
        };
      }

      const urlCheck = validateFetchUrl(url);
      if (!urlCheck.safe) {
        return { toolName: 'web.extractLinks', runtime: 'worker', ok: false, output: `URL blocked: ${urlCheck.reason}` };
      }

      const response = await fetch(url, { signal: context.signal });
      const html = await response.text();
      const hrefs = [...new Set(
        [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)]
          .map((match) => resolveHref(url, match[1]))
          .filter((href): href is string => Boolean(href))
      )];
      return {
        toolName: 'web.extractLinks',
        runtime: 'worker',
        ok: response.ok,
        output: JSON.stringify(hrefs, null, 2),
        metadata: { status: response.status, url, count: hrefs.length }
      };
    }
  };
}

export function createWebExtractTextTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.extractText',
      description: 'Fetches a web page and extracts readable text content.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The URL to extract text from' } }, required: ['url'] }
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      if (!url) {
        return {
          toolName: 'web.extractText',
          runtime: 'worker',
          ok: false,
          output: 'Missing url.'
        };
      }

      const urlCheck = validateFetchUrl(url);
      if (!urlCheck.safe) {
        return { toolName: 'web.extractText', runtime: 'worker', ok: false, output: `URL blocked: ${urlCheck.reason}` };
      }

      const response = await fetch(url, { signal: context.signal });
      const html = await response.text();
      const text = extractReadableText(html);
      return {
        toolName: 'web.extractText',
        runtime: 'worker',
        ok: response.ok,
        output: text,
        metadata: { status: response.status, url, length: text.length }
      };
    }
  };
}

export function createWebSearchTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.search',
      description: 'Searches the web using DuckDuckGo and returns result candidates with titles, URLs, and snippets.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'The search query' }, limit: { type: 'number', description: 'Max results to return (default: 5)' } }, required: ['query'] }
    },
    async execute(input, context) {
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? input.limit : 5;
      const providerBaseUrl = typeof input.providerBaseUrl === 'string'
        ? input.providerBaseUrl
        : 'https://duckduckgo.com/html/';
      if (!query) {
        return {
          toolName: 'web.search',
          runtime: 'worker',
          ok: false,
          output: 'Missing query.'
        };
      }

      const searchUrl = new URL(providerBaseUrl);
      searchUrl.searchParams.set('q', query);
      const searchUrlCheck = validateFetchUrl(searchUrl.toString());
      if (!searchUrlCheck.safe) {
        return { toolName: 'web.search', runtime: 'worker', ok: false, output: `URL blocked: ${searchUrlCheck.reason}` };
      }

      const response = await fetch(searchUrl, {
        signal: context.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CrowClaw/0.1; +https://github.com/subinium/CrowClaw)' },
      });
      if (!response.ok) {
        return { toolName: 'web.search', runtime: 'worker', ok: false, output: `Search request failed: HTTP ${response.status}` };
      }
      const html = await response.text();

      // Pass 1: Parse DuckDuckGo structured results (class="result" containers with snippets)
      const ddgResults: Array<{ title: string; url: string; snippet: string }> = [];
      const resultBlockRegex = /<div[^>]*class="[^"]*\bresult\b[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
      for (const block of html.matchAll(resultBlockRegex)) {
        const content = block[1];
        const linkMatch = content.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
        const snippetMatch = content.match(/<(?:a|td|span)[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|span)>/i);
        if (linkMatch) {
          const href = resolveHref(searchUrl.toString(), linkMatch[1]) ?? linkMatch[1];
          const title = linkMatch[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          const snippet = snippetMatch
            ? snippetMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
            : title;
          if (href && title) ddgResults.push({ title, url: href, snippet });
        }
      }

      // Pass 2: Fallback to generic <a> parsing if DDG structure not found
      const results = ddgResults.length > 0
        ? ddgResults.slice(0, limit)
        : [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)]
            .map((match) => {
              const href = resolveHref(searchUrl.toString(), match[1]) ?? match[1];
              const title = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
              return href && title ? { title, url: href, snippet: title } : null;
            })
            .filter((value): value is { title: string; url: string; snippet: string } => Boolean(value))
            .slice(0, limit);

      return {
        toolName: 'web.search',
        runtime: 'worker',
        ok: response.ok,
        output: JSON.stringify(results, null, 2),
        metadata: { status: response.status, query, count: results.length, providerBaseUrl }
      };
    }
  };
}

export function createWebCrawlTool(): ToolDefinition {
  return {
    manifest: {
      name: 'web.crawl',
      description: 'Crawls a page and linked pages with same-origin filtering.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { url: { type: 'string', description: 'The seed URL to start crawling from' }, maxPages: { type: 'number', description: 'Max pages to crawl (default: 5)' } }, required: ['url'] }
    },
    async execute(input, context) {
      const url = typeof input.url === 'string' ? input.url : '';
      const maxPages = typeof input.maxPages === 'number' ? input.maxPages : 3;
      const sameOriginOnly = input.sameOriginOnly !== false;
      if (!url) {
        return {
          toolName: 'web.crawl',
          runtime: 'worker',
          ok: false,
          output: 'Missing url.'
        };
      }

      const seedUrlCheck = validateFetchUrl(url);
      if (!seedUrlCheck.safe) {
        return { toolName: 'web.crawl', runtime: 'worker', ok: false, output: `URL blocked: ${seedUrlCheck.reason}` };
      }

      const origin = new URL(url).origin;
      const queue = [url];
      const visited = new Set<string>();
      const pages: Array<{ url: string; excerpt: string; links: string[] }> = [];

      while (queue.length > 0 && pages.length < maxPages) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        const crawlUrlCheck = validateFetchUrl(current);
        if (!crawlUrlCheck.safe) continue;

        const response = await fetch(current, { signal: context.signal });
        const html = await response.text();
        const text = extractReadableText(html);
        const links = [...new Set(
          [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>/gi)]
            .map((match) => resolveHref(current, match[1]))
            .filter((href): href is string => Boolean(href))
            .filter((href) => !sameOriginOnly || new URL(href).origin === origin)
        )];
        pages.push({
          url: current,
          excerpt: text.slice(0, 280),
          links
        });
        for (const link of links) {
          if (!visited.has(link) && queue.length + pages.length < maxPages * 3) {
            queue.push(link);
          }
        }
      }

      return {
        toolName: 'web.crawl',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(pages, null, 2),
        metadata: { count: pages.length, maxPages, sameOriginOnly }
      };
    }
  };
}

export function createTextPatchTool(): ToolDefinition {
  return {
    manifest: {
      name: 'text.patch',
      description: 'Applies deterministic text replacements to an input string.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input text to apply replacements to' },
          replacements: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }, description: 'Array of {from, to} replacement pairs' }
        },
        required: ['text', 'replacements']
      }
    },
    async execute(input) {
      const text = typeof input.text === 'string' ? input.text : '';
      const replacements = Array.isArray(input.replacements)
        ? input.replacements as Array<{ from?: string; to?: string }>
        : [];

      let output = text;
      for (const replacement of replacements) {
        if (typeof replacement?.from !== 'string' || typeof replacement?.to !== 'string') {
          continue;
        }
        output = output.split(replacement.from).join(replacement.to);
      }

      return {
        toolName: 'text.patch',
        runtime: 'worker',
        ok: true,
        output,
        metadata: { replacements: replacements.length }
      };
    }
  };
}

export function createLinePatchTool(): ToolDefinition {
  return {
    manifest: {
      name: 'text.patchLines',
      description: 'Applies line-oriented replacements to text by line number.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The input text to patch' },
          patches: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' }, value: { type: 'string' } }, required: ['line', 'value'] }, description: 'Array of {line, value} patches to apply' }
        },
        required: ['text', 'patches']
      }
    },
    async execute(input) {
      const text = typeof input.text === 'string' ? input.text : '';
      const patches = Array.isArray(input.patches)
        ? input.patches as Array<{ line?: number; value?: string }>
        : [];
      const lines = text.split('\n');

      for (const patch of patches) {
        if (typeof patch?.line !== 'number' || typeof patch?.value !== 'string') {
          continue;
        }
        const index = patch.line - 1;
        if (index >= 0 && index < lines.length) {
          lines[index] = patch.value;
        }
      }

      return {
        toolName: 'text.patchLines',
        runtime: 'worker',
        ok: true,
        output: lines.join('\n'),
        metadata: { patches: patches.length }
      };
    }
  };
}

export function createWorkspaceReadTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.read',
      description: 'Reads a file from the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to read' } }, required: ['path'] }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const file = await workspace.read(path);
      return {
        toolName: 'workspace.read',
        runtime: 'worker',
        ok: Boolean(file),
        output: file?.content ?? 'Workspace file not found.',
        metadata: file ? { path: file.path, updatedAt: file.updatedAt } : { path }
      };
    }
  };
}

export function createWorkspaceListTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.list',
      description: 'Lists files from the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { prefix: { type: 'string', description: 'Optional path prefix to filter files' } }, required: [] }
    },
    async execute(input) {
      const prefix = typeof input.prefix === 'string' ? input.prefix : '';
      const files = await workspace.list(prefix);
      return {
        toolName: 'workspace.list',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(files, null, 2),
        metadata: { count: files.length, prefix }
      };
    }
  };
}

export function createWorkspaceSearchFilesTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.searchFiles',
      description: 'Searches workspace file paths and contents using substring or regex matching.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string' },
          prefix: { type: 'string', description: 'Optional path prefix to filter files' },
          limit: { type: 'number', description: 'Max results to return (default: 20)' },
          mode: { type: 'string', enum: ['substring', 'regex'], description: 'Search mode (default: substring)' }
        },
        required: ['query']
      }
    },
    async execute(input) {
      const query = typeof input.query === 'string' ? input.query : '';
      const prefix = typeof input.prefix === 'string' ? input.prefix : '';
      const limit = typeof input.limit === 'number' ? input.limit : 20;
      const mode = input.mode === 'regex' ? 'regex' : 'substring';
      if (!query) {
        return {
          toolName: 'workspace.searchFiles',
          runtime: 'worker',
          ok: false,
          output: 'Missing query.',
          metadata: { query, prefix, mode }
        };
      }

      const files = await workspace.list(prefix);
      const matcher = mode === 'regex'
        ? (() => {
            try {
              return new RegExp(query, 'i');
            } catch {
              return null;
            }
          })()
        : null;
      if (mode === 'regex' && !matcher) {
        return {
          toolName: 'workspace.searchFiles',
          runtime: 'worker',
          ok: false,
          output: `Invalid regex query: ${query}`,
          metadata: { query, prefix, mode }
        };
      }

      const lowered = query.toLowerCase();
      const results = files
        .map((file) => {
          const pathMatch = mode === 'regex'
            ? matcher!.test(file.path)
            : file.path.toLowerCase().includes(lowered);
          const contentMatch = mode === 'regex'
            ? matcher!.test(file.content)
            : file.content.toLowerCase().includes(lowered);
          if (!pathMatch && !contentMatch) {
            return null;
          }
          const snippetSource = contentMatch ? file.content : file.path;
          const index = mode === 'regex'
            ? Math.max(snippetSource.search(matcher!), 0)
            : Math.max(snippetSource.toLowerCase().indexOf(lowered), 0);
          const snippet = snippetSource.slice(Math.max(index - 20, 0), Math.min(index + 120, snippetSource.length)).replace(/\n/g, '\\n');
          return {
            path: file.path,
            match: pathMatch ? 'path' : 'content',
            snippet,
            updatedAt: file.updatedAt
          };
        })
        .filter((value): value is { path: string; match: 'path' | 'content'; snippet: string; updatedAt: string } => Boolean(value))
        .slice(0, limit);

      return {
        toolName: 'workspace.searchFiles',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(results, null, 2),
        metadata: { count: results.length, query, prefix, mode, limit }
      };
    }
  };
}

export function createWorkspaceWriteTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.write',
      description: 'Writes a file into the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to write' }, content: { type: 'string', description: 'File content to write' } }, required: ['path', 'content'] }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const content = typeof input.content === 'string' ? input.content : '';
      const file = await workspace.write(path, content);
      return {
        toolName: 'workspace.write',
        runtime: 'worker',
        ok: true,
        output: file.content,
        metadata: { path: file.path, updatedAt: file.updatedAt }
      };
    }
  };
}

export function createWorkspaceExistsTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.exists',
      description: 'Checks whether a file exists in the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to check' } }, required: ['path'] }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const exists = await workspace.exists(path);
      return {
        toolName: 'workspace.exists',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify({ path, exists }),
        metadata: { path, exists }
      };
    }
  };
}

export function createWorkspacePatchTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.patchLines',
      description: 'Applies line-based patches to a workspace file.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to patch' },
          patches: { type: 'array', items: { type: 'object', properties: { line: { type: 'number' }, value: { type: 'string' } }, required: ['line', 'value'] }, description: 'Array of {line, value} patches to apply' }
        },
        required: ['path', 'patches']
      }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const patches = Array.isArray(input.patches)
        ? input.patches.filter((patch): patch is { line: number; value: string } => typeof patch?.line === 'number' && typeof patch?.value === 'string')
        : [];
      const file = await workspace.patchLines(path, patches);
      return {
        toolName: 'workspace.patchLines',
        runtime: 'worker',
        ok: true,
        output: file.content,
        metadata: { path: file.path, updatedAt: file.updatedAt, patches: patches.length }
      };
    }
  };
}

export function createWorkspacePatchTextTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.patchText',
      description: 'Applies deterministic text replacements to a workspace file.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'File path to patch' },
          replacements: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] }, description: 'Array of {from, to} replacement pairs' }
        },
        required: ['path', 'replacements']
      }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const replacements = Array.isArray(input.replacements)
        ? input.replacements.filter((replacement): replacement is { from: string; to: string } => typeof replacement?.from === 'string' && typeof replacement?.to === 'string')
        : [];
      const file = await workspace.patchText(path, replacements);
      return {
        toolName: 'workspace.patchText',
        runtime: 'worker',
        ok: true,
        output: file.content,
        metadata: { path: file.path, updatedAt: file.updatedAt, replacements: replacements.length }
      };
    }
  };
}

export function createWorkspaceDeleteTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.delete',
      description: 'Deletes a file from the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'File path to delete' } }, required: ['path'] }
    },
    async execute(input) {
      const path = typeof input.path === 'string' ? input.path : '';
      const removed = await workspace.remove(path);
      return {
        toolName: 'workspace.delete',
        runtime: 'worker',
        ok: removed,
        output: removed ? `Deleted ${path}` : `Workspace file not found: ${path}`,
        metadata: { path, removed }
      };
    }
  };
}

export function createWorkspaceRenameTool(workspace: WorkspaceStore): ToolDefinition {
  return {
    manifest: {
      name: 'workspace.rename',
      description: 'Renames or moves a file inside the runtime-neutral workspace store.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: true,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: { type: 'object', properties: { fromPath: { type: 'string', description: 'Current file path' }, toPath: { type: 'string', description: 'New file path' } }, required: ['fromPath', 'toPath'] }
    },
    async execute(input) {
      const fromPath = typeof input.fromPath === 'string' ? input.fromPath : '';
      const toPath = typeof input.toPath === 'string' ? input.toPath : '';
      const file = await workspace.rename(fromPath, toPath);
      return {
        toolName: 'workspace.rename',
        runtime: 'worker',
        ok: Boolean(file),
        output: file ? file.content : `Workspace file not found: ${fromPath}`,
        metadata: file ? { fromPath, toPath, updatedAt: file.updatedAt } : { fromPath, toPath }
      };
    }
  };
}

export function createToolListTool(registry: ToolRegistry): ToolDefinition {
  return {
    manifest: {
      name: 'tool.list',
      description: 'Lists the currently registered tools and runtimes.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      return {
        toolName: 'tool.list',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(registry.list(), null, 2),
        metadata: { count: registry.list().length }
      };
    }
  };
}

export function createTodoTool(): ToolDefinition {
  const todos = new Map<string, Array<{ id: string; text: string; done: boolean; createdAt: string; updatedAt: string }>>();
  return {
    manifest: {
      name: 'todo.manage',
      description: 'Creates, updates, lists, and removes session-scoped todo items.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['add', 'complete', 'remove', 'list'], description: 'The action to perform' }, text: { type: 'string', description: 'Todo text (for add)' }, id: { type: 'string', description: 'Todo ID (for complete/remove)' } }, required: ['action'] }
    },
    async execute(input, context) {
      const action = typeof input.action === 'string' ? input.action : 'list';
      const list = todos.get(context.sessionId) ?? [];
      if (action === 'add') {
        const text = typeof input.text === 'string' ? input.text.trim() : '';
        if (!text) {
          return { toolName: 'todo.manage', runtime: 'worker', ok: false, output: 'Missing todo text.' };
        }
        const item = { id: crypto.randomUUID(), text, done: false, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        list.push(item);
        todos.set(context.sessionId, list);
        return { toolName: 'todo.manage', runtime: 'worker', ok: true, output: JSON.stringify(item, null, 2), metadata: { action, count: list.length } };
      }
      if (action === 'complete' || action === 'remove') {
        const id = typeof input.id === 'string' ? input.id : '';
        const index = list.findIndex((item) => item.id === id);
        if (index < 0) {
          return { toolName: 'todo.manage', runtime: 'worker', ok: false, output: `Todo not found: ${id}` };
        }
        if (action === 'remove') {
          const [removed] = list.splice(index, 1);
          todos.set(context.sessionId, list);
          return { toolName: 'todo.manage', runtime: 'worker', ok: true, output: JSON.stringify(removed, null, 2), metadata: { action, count: list.length } };
        }
        list[index] = { ...list[index]!, done: true, updatedAt: new Date().toISOString() };
        todos.set(context.sessionId, list);
        return { toolName: 'todo.manage', runtime: 'worker', ok: true, output: JSON.stringify(list[index], null, 2), metadata: { action, count: list.length } };
      }
      return {
        toolName: 'todo.manage',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(list, null, 2),
        metadata: { action: 'list', count: list.length }
      };
    }
  };
}

export function createClarifyTool(): ToolDefinition {
  return {
    manifest: {
      name: 'clarify.ask',
      description: 'Produces a concise clarification question with rationale.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'The topic to clarify' }, question: { type: 'string', description: 'The specific question to ask' }, unknowns: { type: 'array', items: { type: 'string' }, description: 'List of unknown aspects' } }, required: ['topic'] }
    },
    async execute(input) {
      const topic = typeof input.topic === 'string' ? input.topic : 'the task';
      const unknowns = Array.isArray(input.unknowns) ? input.unknowns.map(String).filter(Boolean) : [];
      const question = typeof input.question === 'string' && input.question.trim()
        ? input.question.trim()
        : `Can you clarify ${topic}${unknowns.length ? ` (${unknowns.join(', ')})` : ''}?`;
      return {
        toolName: 'clarify.ask',
        runtime: 'worker',
        ok: true,
        output: question,
        metadata: { topic, unknowns }
      };
    }
  };
}

export function createSendMessageTool(): ToolDefinition {
  return {
    manifest: {
      name: 'send.message',
      description: 'Builds an outbound cross-platform message payload for operator delivery.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          platform: { type: 'string', description: 'Target platform (telegram, slack, discord, webhook)' },
          channel: { type: 'string', description: 'Channel or chat ID to send to' },
          text: { type: 'string', description: 'Message text content' }
        },
        required: ['platform', 'channel', 'text']
      }
    },
    async execute(input) {
      const platform = typeof input.platform === 'string' ? input.platform : 'webhook';
      const channel = typeof input.channel === 'string' ? input.channel : '';
      const text = typeof input.text === 'string' ? input.text : '';
      if (!channel || !text) {
        return {
          toolName: 'send.message',
          runtime: 'worker',
          ok: false,
          output: 'Missing channel or text.'
        };
      }
      const metadata = typeof input.metadata === 'object' && input.metadata ? input.metadata as Record<string, unknown> : undefined;
      const payload = (() => {
        if (platform === 'telegram') {
          const botToken = typeof input.botToken === 'string' ? input.botToken : '';
          return {
            platform,
            url: botToken ? buildTelegramSendUrl(botToken) : null,
            payload: buildTelegramSendPayload({ chatId: channel, text })
          };
        }
        if (platform === 'slack') {
          return {
            platform,
            url: buildSlackSendUrl(),
            payload: buildSlackSendPayload({
              channel,
              text,
              threadTs: typeof input.threadId === 'string' ? input.threadId : undefined
            })
          };
        }
        if (platform === 'discord') {
          return {
            platform,
            payload: buildDiscordSendPayload({ content: text }),
            webhookUrl: typeof input.webhookUrl === 'string' ? input.webhookUrl : null
          };
        }
        return {
          platform,
          channel,
          text,
          threadId: typeof input.threadId === 'string' ? input.threadId : undefined,
          metadata
        };
      })();
      return {
        toolName: 'send.message',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(payload, null, 2),
        metadata: { platform, channel }
      };
    }
  };
}

export function createSessionSearchTool(search: SessionSearchStore): ToolDefinition {
  return {
    manifest: {
      name: 'session.search',
      description: 'Searches indexed session transcripts.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string' },
          limit: { type: 'number', description: 'Max results to return (default: 10)' }
        },
        required: ['query']
      }
    },
    async execute(input, context) {
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      const results = await search.search(context.sessionId, query, limit);
      return {
        toolName: 'session.search',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(results, null, 2),
        metadata: { count: results.length }
      };
    }
  };
}

export function createMemoryRememberTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    manifest: {
      name: 'memory.remember',
      description: 'Stores a memory record for the current session.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'Summary text to remember' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
          scope: { type: 'string', enum: ['session', 'user', 'workspace'], description: 'Memory scope (default: session)' }
        },
        required: ['summary']
      }
    },
    async execute(input, context) {
      const scope = normalizeScope(input) ?? 'session';
      const scopeKey = typeof input.scopeKey === 'string' ? input.scopeKey : defaultScopeKey(scope, context);
      const record = {
        id: crypto.randomUUID(),
        sessionId: context.sessionId,
        scope,
        scopeKey,
        summary: typeof input.summary === 'string' ? input.summary : '',
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
        createdAt: new Date().toISOString(),
        metadata: typeof input.metadata === 'object' && input.metadata ? input.metadata as Record<string, unknown> : undefined
      };
      await memoryStore.write(record);
      return {
        toolName: 'memory.remember',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(record, null, 2)
      };
    }
  };
}

export function createMemorySearchTool(
  memoryStore: MemoryStore,
  options?: { recallFn?: (sessionId: string, query: string, limit: number) => Promise<MemoryRecord[]> }
): ToolDefinition {
  return {
    manifest: {
      name: 'memory.search',
      description: 'Searches memory records for the current session.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query string' },
          limit: { type: 'number', description: 'Max results to return (default: 10)' },
          scope: { type: 'string', enum: ['session', 'user', 'workspace'], description: 'Optional scope filter' }
        },
        required: ['query']
      }
    },
    async execute(input, context) {
      const query = typeof input.query === 'string' ? input.query : '';
      const limit = typeof input.limit === 'number' ? input.limit : 10;
      const scope = normalizeScope(input);

      // Route through MemoryService if available (for TTL filtering)
      if (options?.recallFn && !scope) {
        const results = await options.recallFn(context.sessionId, query, limit);
        return {
          toolName: 'memory.search',
          runtime: 'worker' as const,
          ok: true,
          output: JSON.stringify(results, null, 2),
          metadata: { count: results.length }
        };
      }

      // Existing direct store access (fallback or scoped queries)
      const scopeKey = typeof input.scopeKey === 'string' ? input.scopeKey : defaultScopeKey(scope, context);
      const results = scope
        ? await memoryStore.searchByScope(scope, query, limit, scopeKey)
        : await memoryStore.search(context.sessionId, query, limit);
      return {
        toolName: 'memory.search',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(results, null, 2),
        metadata: { count: results.length, ...(scope ? { scope, scopeKey } : {}) }
      };
    }
  };
}

export function createMemoryListTool(memoryStore: MemoryStore): ToolDefinition {
  return {
    manifest: {
      name: 'memory.list',
      description: 'Lists memory records for the current session or a specific scope.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max records to return (default: 50)' },
          scope: { type: 'string', enum: ['session', 'user', 'workspace'], description: 'Optional scope filter' }
        },
        required: []
      }
    },
    async execute(input, context) {
      const limit = typeof input.limit === 'number' ? input.limit : 50;
      const scope = normalizeScope(input);
      const scopeKey = typeof input.scopeKey === 'string' ? input.scopeKey : defaultScopeKey(scope, context);
      const results = scope
        ? await memoryStore.listByScope(scope, limit, scopeKey)
        : await memoryStore.list(context.sessionId);
      return {
        toolName: 'memory.list',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(results.slice(0, limit), null, 2),
        metadata: { count: Math.min(results.length, limit), ...(scope ? { scope, scopeKey } : {}) }
      };
    }
  };
}

export function createMcpListToolsTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.listTools',
      description: 'Lists tools exposed by the configured MCP server.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const tools = await client.listTools();
      return {
        toolName: 'mcp.listTools',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(tools, null, 2),
        metadata: { count: tools.length }
      };
    }
  };
}

export function createMcpListResourcesTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.listResources',
      description: 'Lists resources exposed by the configured MCP server(s).',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const resources = await client.listResources();
      return {
        toolName: 'mcp.listResources',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(resources, null, 2),
        metadata: { count: resources.length }
      };
    }
  };
}

export function createMcpListPromptsTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.listPrompts',
      description: 'Lists prompts exposed by the configured MCP server(s).',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const prompts = await client.listPrompts();
      return {
        toolName: 'mcp.listPrompts',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(prompts, null, 2),
        metadata: { count: prompts.length }
      };
    }
  };
}

export function createMcpStatusTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.status',
      description: 'Reports MCP client status and capability support.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] }
    },
    async execute() {
      const status = client.getStatus();
      return {
        toolName: 'mcp.status',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(status, null, 2),
        metadata: { ...status }
      };
    }
  };
}

export function createMcpInspectTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.inspect',
      description: 'Returns MCP status, tools, resources, and prompts in one response.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: { refresh: { type: 'boolean', description: 'If true, refresh cached data before inspecting' } }, required: [] }
    },
    async execute(input) {
      const refresh = Boolean(input.refresh);
      const inspected = await client.inspect({ refresh });
      return {
        toolName: 'mcp.inspect',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify(inspected, null, 2),
        metadata: {
          refresh,
          tools: inspected.tools.length,
          resources: inspected.resources.length,
          prompts: inspected.prompts.length,
          degraded: inspected.status.degraded
        }
      };
    }
  };
}

export function createMcpCallTool(client: McpClient): ToolDefinition {
  return {
    manifest: {
      name: 'mcp.callTool',
      description: 'Calls a tool exposed by the configured MCP server.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Name of the MCP tool to call' },
          arguments: { type: 'object', description: 'Arguments to pass to the MCP tool' }
        },
        required: ['name']
      }
    },
    async execute(input) {
      const name = typeof input.name === 'string' ? input.name : '';
      const arguments_ = typeof input.arguments === 'object' && input.arguments
        ? input.arguments as Record<string, unknown>
        : {};
      if (!name) {
        return {
          toolName: 'mcp.callTool',
          runtime: 'worker',
          ok: false,
          output: 'Missing MCP tool name.'
        };
      }
      const result = await client.callTool(name, arguments_);
      return {
        toolName: 'mcp.callTool',
        runtime: 'worker',
        ok: result.ok && !result.isError,
        output: JSON.stringify(result.content, null, 2),
        metadata: { name, isError: result.isError ?? false }
      };
    }
  };
}

export function createGitStatusTool(): ToolDefinition {
  return {
    manifest: {
      name: 'git.status',
      description: 'Show git repository status (staged, modified, untracked files)',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Working directory path (optional)' }
        }
      }
    },
    async execute(input) {
      const cwd = typeof input.path === 'string' ? input.path : undefined;
      const result = await runGitCommand(['status', '--porcelain', '-b'], cwd);
      if (!result.ok) {
        return {
          toolName: 'git.status',
          runtime: 'worker',
          ok: false,
          output: result.stderr.trim() || 'Not a git repository or git is not installed.'
        };
      }
      const lines = result.stdout.split('\n').filter(Boolean);
      const branchLine = lines.find((l) => l.startsWith('##'));
      const branch = branchLine ? branchLine.replace('## ', '') : 'unknown';
      const staged: string[] = [];
      const modified: string[] = [];
      const untracked: string[] = [];
      for (const line of lines) {
        if (line.startsWith('##')) continue;
        const x = line[0];
        const y = line[1];
        const file = line.slice(3);
        if (x === '?' && y === '?') {
          untracked.push(file);
        } else {
          if (x && x !== ' ' && x !== '?') staged.push(file);
          if (y && y !== ' ' && y !== '?') modified.push(file);
        }
      }
      return {
        toolName: 'git.status',
        runtime: 'worker',
        ok: true,
        output: JSON.stringify({ branch, staged, modified, untracked }, null, 2),
        metadata: { branch, stagedCount: staged.length, modifiedCount: modified.length, untrackedCount: untracked.length }
      };
    }
  };
}

export function createGitDiffTool(): ToolDefinition {
  return {
    manifest: {
      name: 'git.diff',
      description: 'Show changes in working directory or between commits',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          staged: { type: 'boolean', description: 'Show staged changes only' },
          path: { type: 'string', description: 'Specific file path' },
          ref: { type: 'string', description: 'Commit ref to diff against' }
        }
      }
    },
    async execute(input) {
      const args = ['diff'];
      if (input.staged === true) {
        args.push('--staged');
      }
      if (typeof input.ref === 'string' && input.ref) {
        args.push(input.ref);
      }
      if (typeof input.path === 'string' && input.path) {
        args.push('--', input.path);
      }
      const result = await runGitCommand(args);
      if (!result.ok) {
        return {
          toolName: 'git.diff',
          runtime: 'worker',
          ok: false,
          output: result.stderr.trim() || 'Failed to run git diff.'
        };
      }
      return {
        toolName: 'git.diff',
        runtime: 'worker',
        ok: true,
        output: result.stdout || '(no changes)'
      };
    }
  };
}

export function createGitLogTool(): ToolDefinition {
  return {
    manifest: {
      name: 'git.log',
      description: 'Show recent commit history',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of commits (default 10)' },
          oneline: { type: 'boolean', description: 'One line per commit' },
          path: { type: 'string', description: 'Filter by file path' }
        }
      }
    },
    async execute(input) {
      const count = typeof input.count === 'number' && input.count > 0 ? input.count : 10;
      const args = ['log', `-${count}`];
      if (input.oneline === true) {
        args.push('--oneline');
      } else {
        args.push('--format=%H %s (%an, %ar)');
      }
      if (typeof input.path === 'string' && input.path) {
        args.push('--', input.path);
      }
      const result = await runGitCommand(args);
      if (!result.ok) {
        return {
          toolName: 'git.log',
          runtime: 'worker',
          ok: false,
          output: result.stderr.trim() || 'Failed to run git log.'
        };
      }
      return {
        toolName: 'git.log',
        runtime: 'worker',
        ok: true,
        output: result.stdout.trim() || '(no commits)',
        metadata: { count }
      };
    }
  };
}

export function createGitCommitTool(): ToolDefinition {
  return {
    manifest: {
      name: 'git.commit',
      description: 'Stage and commit changes',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'Commit message (required)' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files to stage (default: all modified)' },
          all: { type: 'boolean', description: 'Stage all changes (-a flag)' }
        },
        required: ['message']
      }
    },
    async execute(input) {
      const message = typeof input.message === 'string' ? input.message : '';
      if (!message) {
        return {
          toolName: 'git.commit',
          runtime: 'worker',
          ok: false,
          output: 'Missing commit message.'
        };
      }

      // Stage files
      const files = Array.isArray(input.files) ? input.files.filter((f): f is string => typeof f === 'string') : [];
      if (files.length > 0) {
        const addResult = await runGitCommand(['add', ...files]);
        if (!addResult.ok) {
          return {
            toolName: 'git.commit',
            runtime: 'worker',
            ok: false,
            output: `Failed to stage files: ${addResult.stderr.trim()}`
          };
        }
      } else if (input.all === true) {
        const addResult = await runGitCommand(['add', '-A']);
        if (!addResult.ok) {
          return {
            toolName: 'git.commit',
            runtime: 'worker',
            ok: false,
            output: `Failed to stage files: ${addResult.stderr.trim()}`
          };
        }
      }

      // Commit
      const commitResult = await runGitCommand(['commit', '-m', message]);
      if (!commitResult.ok) {
        return {
          toolName: 'git.commit',
          runtime: 'worker',
          ok: false,
          output: commitResult.stderr.trim() || commitResult.stdout.trim() || 'Failed to commit.'
        };
      }
      return {
        toolName: 'git.commit',
        runtime: 'worker',
        ok: true,
        output: commitResult.stdout.trim(),
        metadata: { message }
      };
    }
  };
}

export function createGitBranchTool(): ToolDefinition {
  return {
    manifest: {
      name: 'git.branch',
      description: 'List branches or create a new branch',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'New branch name (omit to list)' },
          checkout: { type: 'boolean', description: 'Switch to the new branch' }
        }
      }
    },
    async execute(input) {
      const branchName = typeof input.name === 'string' ? input.name : '';
      if (!branchName) {
        // List branches
        const result = await runGitCommand(['branch', '--list']);
        if (!result.ok) {
          return {
            toolName: 'git.branch',
            runtime: 'worker',
            ok: false,
            output: result.stderr.trim() || 'Failed to list branches.'
          };
        }
        return {
          toolName: 'git.branch',
          runtime: 'worker',
          ok: true,
          output: result.stdout.trim() || '(no branches)'
        };
      }

      // Create branch
      const args = input.checkout === true
        ? ['checkout', '-b', branchName]
        : ['branch', branchName];
      const result = await runGitCommand(args);
      if (!result.ok) {
        return {
          toolName: 'git.branch',
          runtime: 'worker',
          ok: false,
          output: result.stderr.trim() || `Failed to create branch: ${branchName}`
        };
      }
      return {
        toolName: 'git.branch',
        runtime: 'worker',
        ok: true,
        output: result.stdout.trim() || `Branch '${branchName}' created.${input.checkout === true ? ' Switched to it.' : ''}`,
        metadata: { name: branchName, checkout: input.checkout === true }
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Scheduler tools — LLM-callable tools for managing scheduled jobs
// ---------------------------------------------------------------------------

export function createSchedulerCreateTool(
  schedulerStore: SchedulerStore,
  autonomousScheduler: { start: () => void; isRunning: () => boolean },
): ToolDefinition {
  return {
    manifest: {
      name: 'scheduler.create',
      description:
        'Creates a new scheduled job. The schedule can be an interval (every:5m, every:1h), a cron expression (0 9 * * *), or a cron alias (@daily, @hourly). Optionally deliver results to Telegram, Discord, or Slack.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Human-readable name for the job (used as ID)' },
          task: { type: 'string', description: 'The prompt/message the agent will execute on each run' },
          schedule: {
            type: 'string',
            description: 'Schedule expression: "every:5m", "every:1h", "0 9 * * *", "@daily", "@hourly"',
          },
          deliverTo: {
            type: 'object',
            description: 'Optional delivery target for results',
            properties: {
              platform: { type: 'string', description: 'Platform: "telegram", "discord", "slack"' },
              channel: { type: 'string', description: 'Chat ID, channel ID, or webhook URL' },
            },
          },
          model: { type: 'string', description: 'Optional model override for the agent' },
        },
        required: ['name', 'task', 'schedule'],
      },
    },
    async execute(input) {
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const task = typeof input.task === 'string' ? input.task.trim() : '';
      const schedule = typeof input.schedule === 'string' ? input.schedule.trim() : '';

      if (!name || !task || !schedule) {
        return {
          toolName: 'scheduler.create',
          runtime: 'worker',
          ok: false,
          output: 'Missing required fields: name, task, and schedule are all required.',
        };
      }

      const id = name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');

      const deliverTo =
        input.deliverTo &&
        typeof input.deliverTo === 'object' &&
        'platform' in (input.deliverTo as Record<string, unknown>) &&
        'channel' in (input.deliverTo as Record<string, unknown>)
          ? {
              platform: String((input.deliverTo as Record<string, unknown>).platform),
              config: { channel: String((input.deliverTo as Record<string, unknown>).channel) },
            }
          : undefined;

      const model = typeof input.model === 'string' ? input.model : undefined;

      try {
        const job = createScheduledAgentJob({
          id,
          schedule,
          task,
          model,
          deliverTo,
        });

        await schedulerStore.saveJob(job);

        // Auto-start the scheduler if not already running
        if (!autonomousScheduler.isRunning()) {
          autonomousScheduler.start();
        }

        return {
          toolName: 'scheduler.create',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify({
            id: job.id,
            schedule: job.schedule,
            task: job.task,
            enabled: job.enabled,
            nextRunAt: job.nextRunAt,
            deliverTo: job.deliverTo,
            model: job.model,
          }),
          metadata: { jobId: job.id },
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'scheduler.create',
          runtime: 'worker',
          ok: false,
          output: `Failed to create job: ${msg}`,
        };
      }
    },
  };
}

export function createSchedulerListTool(schedulerStore: SchedulerStore): ToolDefinition {
  return {
    manifest: {
      name: 'scheduler.list',
      description:
        'Lists all scheduled jobs with their id, schedule, task, status, next run time, and delivery target.',
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    async execute() {
      try {
        const jobs = await schedulerStore.listJobs();
        if (jobs.length === 0) {
          return {
            toolName: 'scheduler.list',
            runtime: 'worker',
            ok: true,
            output: 'No scheduled jobs.',
          };
        }

        const formatted = jobs.map((job) => ({
          id: job.id,
          schedule: job.schedule,
          task: job.task,
          enabled: job.enabled,
          nextRunAt: job.nextRunAt ?? null,
          lastRunAt: job.lastRunAt ?? null,
          lastRunStatus: job.lastRunStatus ?? null,
          runCount: job.runCount ?? 0,
          deliverTo: job.deliverTo ?? null,
          model: job.model ?? null,
        }));

        return {
          toolName: 'scheduler.list',
          runtime: 'worker',
          ok: true,
          output: JSON.stringify(formatted, null, 2),
          metadata: { count: jobs.length },
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'scheduler.list',
          runtime: 'worker',
          ok: false,
          output: `Failed to list jobs: ${msg}`,
        };
      }
    },
  };
}

export function createSchedulerDeleteTool(schedulerStore: SchedulerStore): ToolDefinition {
  return {
    manifest: {
      name: 'scheduler.delete',
      description: 'Deletes a scheduled job permanently by its ID.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'medium',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The ID of the job to delete' },
        },
        required: ['jobId'],
      },
    },
    async execute(input) {
      const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : '';
      if (!jobId) {
        return {
          toolName: 'scheduler.delete',
          runtime: 'worker',
          ok: false,
          output: 'Missing required field: jobId.',
        };
      }

      try {
        const deleted = await schedulerStore.deleteJob(jobId);
        return {
          toolName: 'scheduler.delete',
          runtime: 'worker',
          ok: deleted,
          output: deleted
            ? `Job '${jobId}' deleted successfully.`
            : `Job '${jobId}' not found.`,
          metadata: { jobId, deleted },
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'scheduler.delete',
          runtime: 'worker',
          ok: false,
          output: `Failed to delete job: ${msg}`,
        };
      }
    },
  };
}

export function createSchedulerToggleTool(schedulerStore: SchedulerStore): ToolDefinition {
  return {
    manifest: {
      name: 'scheduler.toggle',
      description: 'Pauses or resumes a scheduled job by its ID.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: {
        type: 'object',
        properties: {
          jobId: { type: 'string', description: 'The ID of the job to pause or resume' },
          action: { type: 'string', description: '"pause" or "resume"' },
        },
        required: ['jobId', 'action'],
      },
    },
    async execute(input) {
      const jobId = typeof input.jobId === 'string' ? input.jobId.trim() : '';
      const action = typeof input.action === 'string' ? input.action.trim() : '';

      if (!jobId || (action !== 'pause' && action !== 'resume')) {
        return {
          toolName: 'scheduler.toggle',
          runtime: 'worker',
          ok: false,
          output: 'Missing or invalid fields: jobId (string) and action ("pause" | "resume") are required.',
        };
      }

      try {
        const updated =
          action === 'pause'
            ? await schedulerStore.pauseJob(jobId)
            : await schedulerStore.resumeJob(jobId);

        if (!updated) {
          return {
            toolName: 'scheduler.toggle',
            runtime: 'worker',
            ok: false,
            output: `Job '${jobId}' not found.`,
            metadata: { jobId, action },
          };
        }

        return {
          toolName: 'scheduler.toggle',
          runtime: 'worker',
          ok: true,
          output: `Job '${jobId}' ${action === 'pause' ? 'paused' : 'resumed'}. Enabled: ${updated.enabled}`,
          metadata: { jobId, action, enabled: updated.enabled },
        };
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          toolName: 'scheduler.toggle',
          runtime: 'worker',
          ok: false,
          output: `Failed to ${action} job: ${msg}`,
        };
      }
    },
  };
}

export function registerSchedulerTools(
  registry: ToolRegistry,
  schedulerStore: SchedulerStore,
  autonomousScheduler: { start: () => void; isRunning: () => boolean },
): ToolRegistry {
  registry.register(createSchedulerCreateTool(schedulerStore, autonomousScheduler));
  registry.register(createSchedulerListTool(schedulerStore));
  registry.register(createSchedulerDeleteTool(schedulerStore));
  registry.register(createSchedulerToggleTool(schedulerStore));
  return registry;
}

export function registerCoreTools(registry: ToolRegistry): ToolRegistry {
  registry.register(createEchoTool());
  registry.register(createTimeTool());
  registry.register(createTerminalExecTool());
  registry.register(createTerminalBackgroundTool());
  registry.register(createTerminalBackendsTool());
  registry.register(createTerminalBackendStatusTool());
  registry.register(createTerminalProbeTool());
  registry.register(createTerminalProcessesTool());
  registry.register(createTerminalKillTool());
  registry.register(createTodoTool());
  registry.register(createClarifyTool());
  registry.register(createSendMessageTool());
  registry.register(createWebFetchTool());
  registry.register(createWebExtractMetadataTool());
  registry.register(createWebExtractLinksTool());
  registry.register(createWebExtractTextTool());
  registry.register(createWebSearchTool());
  registry.register(createWebCrawlTool());
  registry.register(createVisionAnalyzeToolImpl());
  registry.register(createImageGenerateToolImpl());
  registry.register(createTextPatchTool());
  registry.register(createLinePatchTool());
  registry.register(createGitStatusTool());
  registry.register(createGitDiffTool());
  registry.register(createGitLogTool());
  registry.register(createGitCommitTool());
  registry.register(createGitBranchTool());
  registry.register(createToolListTool(registry));
  return registry;
}

export function registerSearchAndMemoryTools(
  registry: ToolRegistry,
  sessionSearchStore: SessionSearchStore,
  memoryStore: MemoryStore,
  options?: { recallFn?: (sessionId: string, query: string, limit: number) => Promise<MemoryRecord[]> }
): ToolRegistry {
  registry.register(createSessionSearchTool(sessionSearchStore));
  registry.register(createMemoryRememberTool(memoryStore));
  registry.register(createMemorySearchTool(memoryStore, options));
  registry.register(createMemoryListTool(memoryStore));
  return registry;
}

export function registerMcpTools(registry: ToolRegistry, client: McpClient): ToolRegistry {
  registry.register(createMcpListToolsTool(client));
  registry.register(createMcpListResourcesTool(client));
  registry.register(createMcpListPromptsTool(client));
  registry.register(createMcpStatusTool(client));
  registry.register(createMcpInspectTool(client));
  registry.register(createMcpCallTool(client));
  return registry;
}

export function registerWorkspaceTools(registry: ToolRegistry, workspace: WorkspaceStore): ToolRegistry {
  registry.register(createWorkspaceReadTool(workspace));
  registry.register(createWorkspaceListTool(workspace));
  registry.register(createWorkspaceSearchFilesTool(workspace));
  registry.register(createWorkspaceWriteTool(workspace));
  registry.register(createWorkspaceExistsTool(workspace));
  registry.register(createWorkspacePatchTool(workspace));
  registry.register(createWorkspacePatchTextTool(workspace));
  registry.register(createWorkspaceDeleteTool(workspace));
  registry.register(createWorkspaceRenameTool(workspace));
  return registry;
}

export function createDefaultWorkerRegistry(options?: {
  sessionSearchStore?: SessionSearchStore;
  memoryStore?: MemoryStore;
  workspaceStore?: WorkspaceStore;
  mcpClient?: McpClient;
  recallFn?: (sessionId: string, query: string, limit: number) => Promise<MemoryRecord[]>;
  schedulerStore?: SchedulerStore;
  autonomousScheduler?: { start: () => void; isRunning: () => boolean };
}): ToolRegistry {
  const registry = registerCoreTools(new ToolRegistry());
  if (options?.sessionSearchStore && options.memoryStore) {
    registerSearchAndMemoryTools(registry, options.sessionSearchStore, options.memoryStore, {
      recallFn: options.recallFn
    });
  }
  if (options?.workspaceStore) {
    registerWorkspaceTools(registry, options.workspaceStore);
  }
  if (options?.mcpClient) {
    registerMcpTools(registry, options.mcpClient);
  }
  if (options?.schedulerStore && options?.autonomousScheduler) {
    registerSchedulerTools(registry, options.schedulerStore, options.autonomousScheduler);
  }
  return registry;
}

/**
 * Toolset Presets — Named tool bundles inspired by Hermes Agent's toolset distributions.
 * Each preset defines which tool categories to include.
 */
export type ToolsetPresetName = 'minimal' | 'web' | 'terminal' | 'workspace' | 'memory' | 'mcp' | 'full' | 'research' | 'devops' | 'creative';

export interface ToolsetPreset {
  name: ToolsetPresetName;
  description: string;
  toolNames: string[];
}

export const TOOLSET_PRESETS: Record<ToolsetPresetName, ToolsetPreset> = {
  minimal: {
    name: 'minimal',
    description: 'Core utilities only — echo, time, tool list',
    toolNames: ['echo', 'time', 'tool.list'],
  },
  web: {
    name: 'web',
    description: 'Web interaction — search, fetch, crawl, extract',
    toolNames: ['echo', 'time', 'tool.list', 'web.fetch', 'web.search', 'web.crawl', 'web.extractMetadata', 'web.extractLinks', 'web.extractText'],
  },
  terminal: {
    name: 'terminal',
    description: 'Shell execution — terminal commands and process management',
    toolNames: ['echo', 'time', 'tool.list', 'terminal.exec', 'terminal.background', 'terminal.backends', 'terminal.backendStatus', 'terminal.probe', 'terminal.processes', 'terminal.kill'],
  },
  workspace: {
    name: 'workspace',
    description: 'File operations — read, write, search, patch files',
    toolNames: ['echo', 'time', 'tool.list', 'workspace.read', 'workspace.write', 'workspace.list', 'workspace.exists', 'workspace.delete', 'workspace.rename', 'workspace.patchLines', 'workspace.patchText', 'workspace.searchFiles'],
  },
  memory: {
    name: 'memory',
    description: 'Memory and session — remember, recall, search across sessions',
    toolNames: ['echo', 'time', 'tool.list', 'memory.remember', 'memory.search', 'memory.list', 'session.search'],
  },
  mcp: {
    name: 'mcp',
    description: 'MCP integration — list, call, inspect MCP server tools',
    toolNames: ['echo', 'time', 'tool.list', 'mcp.listTools', 'mcp.listResources', 'mcp.listPrompts', 'mcp.status', 'mcp.inspect', 'mcp.call'],
  },
  research: {
    name: 'research',
    description: 'Research workflow — web search, fetch, crawl, memory, session search',
    toolNames: ['echo', 'time', 'tool.list', 'web.search', 'web.fetch', 'web.crawl', 'web.extractText', 'web.extractLinks', 'memory.remember', 'memory.search', 'session.search'],
  },
  devops: {
    name: 'devops',
    description: 'DevOps workflow — terminal, files, web fetch, git, process management, scheduler',
    toolNames: ['echo', 'time', 'tool.list', 'terminal.exec', 'terminal.background', 'terminal.backends', 'terminal.backendStatus', 'terminal.probe', 'terminal.processes', 'terminal.kill', 'workspace.read', 'workspace.write', 'workspace.list', 'workspace.searchFiles', 'web.fetch', 'git.status', 'git.diff', 'git.log', 'git.commit', 'git.branch', 'scheduler.create', 'scheduler.list', 'scheduler.delete', 'scheduler.toggle'],
  },
  creative: {
    name: 'creative',
    description: 'Creative workflow — web search, files, text patching, memory',
    toolNames: ['echo', 'time', 'tool.list', 'web.search', 'web.fetch', 'workspace.read', 'workspace.write', 'text.patch', 'text.patchLines', 'memory.remember', 'memory.search', 'todo.manage'],
  },
  full: {
    name: 'full',
    description: 'All available tools',
    toolNames: [], // Empty means "register everything"
  },
};

export function getToolsetPreset(name: ToolsetPresetName): ToolsetPreset {
  return TOOLSET_PRESETS[name];
}

export function listToolsetPresets(): ToolsetPreset[] {
  return Object.values(TOOLSET_PRESETS);
}

export function listToolsetPresetNames(): ToolsetPresetName[] {
  return Object.keys(TOOLSET_PRESETS) as ToolsetPresetName[];
}

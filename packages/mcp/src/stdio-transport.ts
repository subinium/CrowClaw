import { spawn, type ChildProcess } from 'node:child_process';
import type {
  McpTransport,
  McpCallResult,
  McpToolDefinition,
  McpResourceDefinition,
  McpPromptDefinition,
} from './index.js';

export interface McpStdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface McpJsonRpcStdioTransportOptions {
  requestTimeoutMs?: number;
  onStderr?: (data: string) => void;
  onClose?: (code: number | null) => void;
  onError?: (error: Error) => void;
  /**
   * Issue #103: Auto-reconnect on unexpected close. When true (default), the
   * transport will schedule `connect()` after the child process closes
   * unexpectedly, with exponential backoff (1s / 2s / 4s) up to
   * `reconnectMaxAttempts` (default 3). Disabled automatically once
   * `disconnect()` is called explicitly.
   */
  autoReconnect?: boolean;
  /** Issue #103: Max reconnect attempts (default 3). */
  reconnectMaxAttempts?: number;
  /** Issue #103: Initial backoff delay in ms (default 1000). Doubles each attempt. */
  reconnectInitialDelayMs?: number;
  /**
   * Issue #103: Hook fired before each reconnect attempt. Useful for tests
   * and operator metrics.
   */
  onReconnect?: (attempt: number, delayMs: number) => void;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class McpJsonRpcStdioTransport implements McpTransport {
  private childProcess: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = '';
  private connected = false;
  private readonly config: McpStdioServerConfig;
  private readonly requestTimeoutMs: number;
  private readonly onStderr?: (data: string) => void;
  private readonly onClose?: (code: number | null) => void;
  private readonly onError?: (error: Error) => void;

  // ---- Issue #103: auto-reconnect state ----
  private readonly autoReconnect: boolean;
  private readonly reconnectMaxAttempts: number;
  private readonly reconnectInitialDelayMs: number;
  private readonly onReconnect?: (attempt: number, delayMs: number) => void;
  /** Number of reconnect attempts since the last successful connect. */
  private reconnectAttempt = 0;
  /** Pending reconnect timer (if any). */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Set to true by `disconnect()` to suppress further reconnect attempts. */
  private disconnectRequested = false;

  constructor(config: McpStdioServerConfig, options?: McpJsonRpcStdioTransportOptions) {
    this.config = config;
    this.requestTimeoutMs = options?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.onStderr = options?.onStderr;
    this.onClose = options?.onClose;
    this.onError = options?.onError;
    // Issue #103: default autoReconnect = true. Backoff: 1s / 2s / 4s. Max 3.
    this.autoReconnect = options?.autoReconnect ?? true;
    this.reconnectMaxAttempts = options?.reconnectMaxAttempts ?? 3;
    this.reconnectInitialDelayMs = options?.reconnectInitialDelayMs ?? 1000;
    this.onReconnect = options?.onReconnect;
  }

  async connect(): Promise<void> {
    if (this.connected) {
      return;
    }

    const childEnv = this.config.env
      ? { ...process.env, ...this.config.env }
      : process.env;

    this.childProcess = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: childEnv as NodeJS.ProcessEnv,
      cwd: this.config.cwd,
    });

    this.childProcess.stdout!.on('data', (chunk: Buffer) => {
      this.handleData(chunk.toString('utf-8'));
    });

    this.childProcess.stderr!.on('data', (chunk: Buffer) => {
      this.onStderr?.(chunk.toString('utf-8'));
    });

    this.childProcess.on('error', (error: Error) => {
      this.onError?.(error);
      this.rejectAllPending(error);
    });

    this.childProcess.on('close', (code: number | null) => {
      this.connected = false;
      this.onClose?.(code);
      this.rejectAllPending(new Error(`MCP server process exited with code ${code}`));
      // Issue #103: schedule reconnect with exponential backoff unless an
      // explicit disconnect() was requested. Bound to `reconnectMaxAttempts`.
      this.maybeScheduleReconnect();
    });

    this.connected = true;
    // Issue #103: reset reconnect state on successful connect.
    this.reconnectAttempt = 0;

    // Send MCP initialize request
    await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'crowclaw-mcp-client',
        version: '0.1.0',
      },
    });

    // Send initialized notification (no id, no response expected)
    this.sendNotification('notifications/initialized', {});
  }

  /**
   * Issue #103: Schedule a reconnect attempt after unexpected close. No-op when
   * autoReconnect is disabled, the consumer requested disconnect, or we have
   * exhausted attempts. Backoff is `initialDelay * 2^attempt`.
   */
  private maybeScheduleReconnect(): void {
    if (!this.autoReconnect) return;
    if (this.disconnectRequested) return;
    if (this.reconnectAttempt >= this.reconnectMaxAttempts) return;
    if (this.reconnectTimer) return; // already scheduled

    const attempt = this.reconnectAttempt + 1;
    const delayMs = this.reconnectInitialDelayMs * Math.pow(2, this.reconnectAttempt);
    this.reconnectAttempt = attempt;
    this.onReconnect?.(attempt, delayMs);

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      // The connect() call resets `reconnectAttempt` on success and the close
      // handler will re-trigger this method on subsequent failures, capping at
      // `reconnectMaxAttempts`.
      void this.connect().catch((error: unknown) => {
        this.onError?.(error instanceof Error ? error : new Error(String(error)));
      });
    }, delayMs);
    // Issue #126 follow-on: don't keep the event loop alive solely to
    // retry — agents may exit while a backoff is pending.
    if (typeof this.reconnectTimer === 'object' && this.reconnectTimer !== null) {
      (this.reconnectTimer as { unref?: () => void }).unref?.();
    }
  }

  async disconnect(): Promise<void> {
    // Issue #103: mark explicit disconnect *first* so any in-flight close
    // handler (race with SIGTERM) suppresses the reconnect schedule.
    this.disconnectRequested = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (!this.connected || !this.childProcess) {
      return;
    }

    this.connected = false;
    this.rejectAllPending(new Error('MCP transport disconnected'));

    // Try graceful shutdown first
    this.childProcess.stdin!.end();
    const proc = this.childProcess;
    this.childProcess = null;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        proc.kill('SIGKILL');
        resolve();
      }, 5_000);

      // Use `once` instead of `on` (#126). The constructor at line 88 already
      // attaches a global 'close' handler; using `on` here would leave a
      // dangling listener that fires for every subsequent emission, growing
      // the listener count past Node's MaxListenersExceededWarning threshold
      // when transports are repeatedly created/destroyed (e.g. test runs,
      // long-lived dashboards reconnecting).
      proc.once('close', () => {
        clearTimeout(timer);
        resolve();
      });

      proc.kill('SIGTERM');
    });
  }

  async listTools(): Promise<McpToolDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('tools/list', {})) as { tools?: McpToolDefinition[] };
    return result.tools ?? [];
  }

  async callTool(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    this.ensureConnected();
    const result = (await this.sendRequest('tools/call', { name, arguments: arguments_ })) as {
      content?: unknown;
      isError?: boolean;
    };
    return {
      ok: !result.isError,
      content: result.content,
      isError: result.isError,
    };
  }

  async listResources(): Promise<McpResourceDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('resources/list', {})) as {
      resources?: McpResourceDefinition[];
    };
    return result.resources ?? [];
  }

  async listPrompts(): Promise<McpPromptDefinition[]> {
    this.ensureConnected();
    const result = (await this.sendRequest('prompts/list', {})) as {
      prompts?: McpPromptDefinition[];
    };
    return result.prompts ?? [];
  }

  private ensureConnected(): void {
    if (!this.connected || !this.childProcess) {
      throw new Error('MCP transport is not connected. Call connect() first.');
    }
  }

  private sendRequest(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = this.nextId++;
    const request: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      ...(params !== undefined ? { params } : {}),
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });

      const message = JSON.stringify(request) + '\n';
      this.childProcess!.stdin!.write(message, (error?: Error | null) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(new Error(`Failed to write to MCP server stdin: ${error.message}`));
        }
      });
    });
  }

  private sendNotification(method: string, params?: Record<string, unknown>): void {
    if (!this.childProcess?.stdin?.writable) {
      return;
    }
    const notification = {
      jsonrpc: '2.0' as const,
      method,
      ...(params !== undefined ? { params } : {}),
    };
    this.childProcess.stdin.write(JSON.stringify(notification) + '\n');
  }

  private handleData(data: string): void {
    this.buffer += data;
    const lines = this.buffer.split('\n');
    // Keep the last incomplete line in the buffer
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      try {
        const message = JSON.parse(trimmed) as JsonRpcResponse;
        this.handleMessage(message);
      } catch {
        // Ignore non-JSON lines (e.g. server debug output)
      }
    }
  }

  private handleMessage(message: JsonRpcResponse): void {
    if (message.id === undefined || message.id === null) {
      // Server notification — no pending handler
      return;
    }

    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }

    this.pending.delete(message.id);
    clearTimeout(pending.timer);

    if (message.error) {
      pending.reject(
        new Error(`MCP JSON-RPC error (${message.error.code}): ${message.error.message}`)
      );
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}

// ---------------------------------------------------------------------------
// tool-rpc — JSON-RPC bridge between the JS/TS sandbox and the host's
// existing tool registry (v0.8.0 #234, code.execute pipeline tool).
//
// The sandbox runs inside a Node `vm` context; user code interacts with the
// host through a generated `tools` shim that proxies every method onto a
// per-run JS callback (which we stash on the sandbox's globalThis as
// `__crowclawHostBridge`). The shim source is JS injected ahead of the user
// code, so the user can `await tools.web_fetch({...})` without knowing about
// the underlying transport.
//
// Why this shape (vs. exposing the registry directly):
//   - Keeps the sandbox boundary explicit. Every call goes through
//     `handleRequest`, which applies SandboxPolicy + budgets + emits events.
//   - Routes through the SAME `executeTool` callback the agent loop uses, so
//     plugins, hardline blocklist, redaction, and approval gate all apply.
//     We re-use the `executeWithGates` callback so we don't fork the security
//     pipeline.
//   - Lets us track per-call metadata (durationMs, ok, error) for the
//     code-execute trace component.
// ---------------------------------------------------------------------------

import type {
  AgentEventEmitter,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolCall,
} from '@crowclaw/core';
import { isHardlineBlocked } from '@crowclaw/core';
import type { ToolRegistry } from '@crowclaw/tools';
import { SandboxPolicyError, type SandboxPolicy } from './policy.js';

// ---------------------------------------------------------------------------
// Wire format
// ---------------------------------------------------------------------------

export interface ToolRpcRequest {
  id: number;
  /** Tool name in registry form (with dots, e.g. `web.fetch`). */
  tool: string;
  args: unknown;
}

export interface ToolRpcResponse {
  id: number;
  ok: boolean;
  /** Tool output as a string. JSON-shaped tools should pre-serialise. */
  result?: unknown;
  error?: string;
  durationMs: number;
}

/** Per-call record kept by the bridge so `executeWithTools` can return a
 *  structured trace alongside stdout/stderr. */
export interface ToolCallRecord {
  name: string;
  args: unknown;
  result?: unknown;
  ok: boolean;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Host bridge
// ---------------------------------------------------------------------------

export interface HostBridge {
  /** JS source string to prepend to user code. Defines a global `tools`
   *  object whose methods proxy to the host bridge installed on
   *  `globalThis.__crowclawHostBridge`. */
  shimSource: string;
  /** Process a single RPC request originating from the sandbox. Routes
   *  through `executeTool` if provided (preferred — runs plugins/hardline/
   *  approval), otherwise falls back to `toolRegistry.execute`. */
  handleRequest(req: ToolRpcRequest): Promise<ToolRpcResponse>;
  /** Per-run accumulator that `executeWithTools` returns to its caller. */
  readonly callRecords: ReadonlyArray<ToolCallRecord>;
}

export interface CreateHostBridgeOptions {
  toolRegistry: ToolRegistry;
  sessionId: string;
  agentId?: string;
  workspaceId?: string;
  policy: SandboxPolicy;
  eventBus?: AgentEventEmitter;
  /**
   * Preferred host execution path. The orchestrator passes the same callback
   * the agent loop's `executeToolCall` would invoke after plugins / hardline /
   * approval — so RPC calls go through the identical pipeline. When omitted,
   * the bridge falls back to `toolRegistry.execute`, which still runs the
   * tool's own redaction/validation but skips the agent-loop-only gates.
   *
   * Either way, this module also performs a hardline-blocklist check before
   * calling out, since the registry path does NOT include it.
   */
  executeTool?: (
    toolCall: ToolCall,
    context: ToolExecutionContext
  ) => Promise<ToolExecutionResult>;
  /** Optional hardline patterns to layer on top of the static defaults. Same
   *  contract as AgentLoopOptions.hardlineBlocklist. */
  hardlineBlocklist?: ReadonlyArray<{ pattern: RegExp; description: string }>;
  /** AbortSignal threaded through to the host registry. */
  signal?: AbortSignal;
  env?: unknown;
}

/**
 * The shim is loaded into the sandbox before user code. It defines a global
 * `tools` object whose methods translate to JSON-RPC requests dispatched
 * through `globalThis.__crowclawHostBridge`. The bridge function is JS, not
 * a socket — sandbox-executor v0.8 uses Node `vm` with a shared globalThis,
 * so synchronous-looking Promise dispatch is sufficient.
 *
 * Tool names in the registry use dots (`web.fetch`); JS identifiers can't.
 * We expose BOTH styles on the `tools` object: the dotted form via index
 * access (`tools['web.fetch']`) and the underscored form as a direct property
 * (`tools.web_fetch`) so user code can use either.
 */
export function buildShimSource(allowedTools: string[]): string {
  // Build property aliases: `web.fetch` -> alias `web_fetch` so users can
  // write `await tools.web_fetch(args)` without bracket syntax.
  const lines: string[] = [];
  lines.push('"use strict";');
  lines.push('const __bridge = globalThis.__crowclawHostBridge;');
  lines.push('if (!__bridge || typeof __bridge.call !== "function") {');
  lines.push('  throw new Error("CrowClaw host bridge missing — tool calls disabled");');
  lines.push('}');
  lines.push('let __nextId = 1;');
  lines.push('async function __invoke(name, args) {');
  lines.push('  const id = __nextId++;');
  lines.push('  const res = await __bridge.call({ id, tool: name, args });');
  lines.push('  if (!res.ok) {');
  lines.push('    const err = new Error(res.error || ("Tool " + name + " failed"));');
  lines.push('    err.toolName = name;');
  lines.push('    err.durationMs = res.durationMs;');
  lines.push('    throw err;');
  lines.push('  }');
  lines.push('  return res.result;');
  lines.push('}');
  // Use a Proxy so any tool name access returns an invoker. The bridge enforces
  // the actual allowlist at call time — that way `tools['web.search'](...)` for
  // a non-allowlisted tool surfaces the meaningful `Tool "X" is not in the
  // sandbox allowedTools list` error instead of a JS `undefined is not a
  // function`. Pre-allowed names also get an underscored alias for ergonomics.
  lines.push('const __toolHandler = {');
  lines.push('  get(_target, prop) {');
  lines.push('    if (typeof prop !== "string") return undefined;');
  lines.push('    return (args) => __invoke(prop, args);');
  lines.push('  },');
  lines.push('  has() { return true; }');
  lines.push('};');
  lines.push('const tools = new Proxy(Object.create(null), __toolHandler);');
  // Underscore-aliased names: only built for explicitly allowed tools so the
  // ergonomic `tools.web_fetch(...)` form continues to work for those, while
  // any other identifier access still flows through the proxy and reaches the
  // bridge's allowlist check.
  for (const name of allowedTools) {
    const alias = name.replace(/[^a-zA-Z0-9_$]/g, '_');
    if (alias !== name) {
      // Proxy intercepts `tools.alias` automatically via the `get` trap and
      // dispatches to __invoke(alias, args). The bridge will reject `alias`
      // unless the caller also added it to allowedTools — so we forward to
      // the canonical dotted name explicitly here.
      lines.push(`__toolHandler[${JSON.stringify(alias)}] = (args) => __invoke(${JSON.stringify(name)}, args);`);
    }
  }
  lines.push('globalThis.tools = tools;');
  return lines.join('\n');
}

export function createHostBridge(opts: CreateHostBridgeOptions): HostBridge {
  const records: ToolCallRecord[] = [];
  const allowedSet = new Set(opts.policy.allowedTools);

  const handleRequest = async (req: ToolRpcRequest): Promise<ToolRpcResponse> => {
    const start = Date.now();

    // 1. Allowlist check
    if (!allowedSet.has(req.tool)) {
      const err = new SandboxPolicyError(
        'ToolNotAllowed',
        `Tool "${req.tool}" is not in the sandbox allowedTools list`,
        req.tool
      );
      const rec: ToolCallRecord = {
        name: req.tool,
        args: req.args,
        ok: false,
        durationMs: 0,
        error: err.message,
      };
      records.push(rec);
      opts.eventBus?.emit('code:tool_called', {
        sessionId: opts.sessionId,
        toolName: req.tool,
        durationMs: 0,
        ok: false,
        error: err.code,
      });
      return { id: req.id, ok: false, error: err.message, durationMs: 0 };
    }

    // 2. Budget check (count attempted calls, not just successful — over-budget
    //    behaviour should be observable to the policy auditor).
    if (records.length >= opts.policy.maxToolCalls) {
      const err = new SandboxPolicyError(
        'ToolBudgetExceeded',
        `Sandbox tool-call budget exceeded (${opts.policy.maxToolCalls})`,
        req.tool
      );
      const rec: ToolCallRecord = {
        name: req.tool,
        args: req.args,
        ok: false,
        durationMs: 0,
        error: err.message,
      };
      records.push(rec);
      opts.eventBus?.emit('code:tool_called', {
        sessionId: opts.sessionId,
        toolName: req.tool,
        durationMs: 0,
        ok: false,
        error: err.code,
      });
      return { id: req.id, ok: false, error: err.message, durationMs: 0 };
    }

    // 3. Resolve definition for safety/manifest checks. If the registry doesn't
    //    have the tool we still let the executeTool path run — it'll return
    //    a structured "Unknown tool" result.
    const definition = opts.toolRegistry.get(req.tool);
    if (definition && definition.manifest.safety === 'destructive' && !opts.policy.allowDangerous) {
      const err = new SandboxPolicyError(
        'DangerousToolBlocked',
        `Tool "${req.tool}" is destructive and allowDangerous is false`,
        req.tool
      );
      const rec: ToolCallRecord = {
        name: req.tool,
        args: req.args,
        ok: false,
        durationMs: 0,
        error: err.message,
      };
      records.push(rec);
      opts.eventBus?.emit('code:tool_called', {
        sessionId: opts.sessionId,
        toolName: req.tool,
        durationMs: 0,
        ok: false,
        error: err.code,
      });
      return { id: req.id, ok: false, error: err.message, durationMs: 0 };
    }

    // 4. Hardline blocklist — sits BEFORE the registry path because the
    //    registry's `execute` doesn't include it (only AgentLoop does).
    //    Mirrors AgentLoop.executeToolCall's check at packages/core/src/index.ts
    //    so a sandboxed call can't bypass the same content gate.
    const inputForCheck = (req.args && typeof req.args === 'object')
      ? (req.args as Record<string, unknown>)
      : {};
    const toolCall: ToolCall = { name: req.tool, input: inputForCheck };
    const hardline = isHardlineBlocked(toolCall, opts.hardlineBlocklist ?? []);
    if (hardline.blocked) {
      const message = `Tool call rejected by hardline blocklist: ${hardline.description}`;
      const rec: ToolCallRecord = {
        name: req.tool,
        args: req.args,
        ok: false,
        durationMs: 0,
        error: message,
      };
      records.push(rec);
      opts.eventBus?.emit('code:tool_called', {
        sessionId: opts.sessionId,
        toolName: req.tool,
        durationMs: 0,
        ok: false,
        error: 'HardlineBlocked',
      });
      return { id: req.id, ok: false, error: message, durationMs: 0 };
    }

    // 5. Route through host. Prefer the agent-loop-equivalent `executeTool`
    //    callback (plugins + approval); fall back to registry.
    const ctx: ToolExecutionContext = {
      agentId: opts.agentId ?? 'sandbox',
      sessionId: opts.sessionId,
      workspaceId: opts.workspaceId,
      env: opts.env,
      signal: opts.signal,
    };

    let result: ToolExecutionResult;
    try {
      if (opts.executeTool) {
        result = await opts.executeTool(toolCall, ctx);
      } else {
        result = await opts.toolRegistry.execute(req.tool, inputForCheck, ctx);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - start;
      const rec: ToolCallRecord = {
        name: req.tool,
        args: req.args,
        ok: false,
        durationMs,
        error: message,
      };
      records.push(rec);
      opts.eventBus?.emit('code:tool_called', {
        sessionId: opts.sessionId,
        toolName: req.tool,
        durationMs,
        ok: false,
        error: 'HostExecutionThrew',
      });
      return { id: req.id, ok: false, error: message, durationMs };
    }

    const durationMs = Date.now() - start;
    const rec: ToolCallRecord = {
      name: req.tool,
      args: req.args,
      result: result.output,
      ok: result.ok,
      durationMs,
    };
    records.push(rec);
    opts.eventBus?.emit('code:tool_called', {
      sessionId: opts.sessionId,
      toolName: req.tool,
      durationMs,
      ok: result.ok,
    });
    return {
      id: req.id,
      ok: result.ok,
      result: result.output,
      durationMs,
      ...(result.ok ? {} : { error: result.output }),
    };
  };

  return {
    shimSource: buildShimSource(opts.policy.allowedTools),
    handleRequest,
    callRecords: records,
  };
}

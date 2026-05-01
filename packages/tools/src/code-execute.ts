// ---------------------------------------------------------------------------
// `code.execute` — pipeline tool (v0.8.0 #234, Hermes parity).
//
// Wraps `executeWithTools` from `@crowclaw/sandbox-executor` so the agent can
// chain multiple host-registry tools in one inference call:
//
//     await tools['web.fetch']({ url })
//     await tools['web.search']({ query })
//
// Every host call inside the sandbox routes through the same `executeTool`
// pipeline the agent loop uses (plugins, hardline, redaction, approval). The
// tool itself is `safety: 'destructive'` because it can transitively invoke
// any allowlisted destructive tool — operators must register it explicitly
// (it is NOT in the default agent toolset).
//
// Why dynamic import:
//   `@crowclaw/sandbox-executor` already depends on `@crowclaw/tools` (it
//   imports the `ToolRegistry` type). A static import here would close the
//   circle and break TS project references. Dynamic `await import(...)` keeps
//   the runtime cycle but avoids the build-time cycle, mirroring the pattern
//   used in runtime-node/cli for `@crowclaw/web` and `@crowclaw/mcp`.
//
// Shape:
//   input.language: 'js' | 'ts'
//   input.code:     string
//   input.allowedTools: string[]   // exact tool names from the host registry
//
// Output (string-encoded JSON of ExecuteWithToolsResult): the agent loop
// re-feeds this into the model on the next iteration. `metadata` carries
// `ok` / `durationMs` / `toolCallCount` for the dashboard trace.
// ---------------------------------------------------------------------------

import type {
  AgentEventEmitter,
  ToolCall,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  SecurityAuditLog,
} from '@crowclaw/core';
import { recordCodeExecuteAudit } from '@crowclaw/core';
import type { ToolRegistry } from './index.js';

// Type-only mirror of `ExecuteWithToolsOptions` / `ExecuteWithToolsResult`.
// We can't import the actual symbols from `@crowclaw/sandbox-executor` because
// it depends on `@crowclaw/tools`; mirroring the structural shape keeps the
// module decoupled at compile time. The dynamic import below resolves the
// real runtime export at call time.
interface ExecuteWithToolsRunner {
  (opts: {
    code: string;
    language: 'js' | 'ts' | 'python';
    toolRegistry: ToolRegistry;
    sessionId: string;
    agentId?: string;
    workspaceId?: string;
    policy?: {
      allowedTools: string[];
      timeoutMs: number;
      maxOutputBytes: number;
      maxToolCalls: number;
      allowDangerous: boolean;
    };
    eventBus?: AgentEventEmitter;
    executeTool?: (toolCall: ToolCall, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
    hardlineBlocklist?: ReadonlyArray<{ pattern: RegExp; description: string }>;
    signal?: AbortSignal;
    env?: unknown;
  }): Promise<{
    ok: boolean;
    returnValue?: unknown;
    stdout: string;
    stderr: string;
    toolCalls: Array<{
      name: string;
      args: unknown;
      result?: unknown;
      ok: boolean;
      durationMs: number;
      error?: string;
    }>;
    durationMs: number;
    error?: string;
  }>;
}

let cachedRunner: ExecuteWithToolsRunner | null = null;
async function loadRunner(): Promise<ExecuteWithToolsRunner> {
  if (cachedRunner) return cachedRunner;
  const mod = (await import('@crowclaw/sandbox-executor')) as {
    executeWithTools: ExecuteWithToolsRunner;
  };
  cachedRunner = mod.executeWithTools;
  return cachedRunner;
}

export interface CodeExecuteToolDeps {
  toolRegistry: ToolRegistry;
  /** Same-path executeTool (with plugins / hardline / approval) — when present
   *  we route every sandboxed RPC through this. When absent we fall back to
   *  `toolRegistry.execute`, which still applies the tool's own validation
   *  but skips the agent-loop-only gates. The orchestrator should always
   *  pass this to keep the sandbox honest. */
  executeTool?: (toolCall: ToolCall, context: ToolExecutionContext) => Promise<ToolExecutionResult>;
  eventBus?: AgentEventEmitter;
  /** Optional audit log — when supplied, every code.execute call appends a
   *  `tool.code-execute` audit entry capturing the (truncated) source +
   *  the allowed-tool list. */
  securityAuditLog?: SecurityAuditLog;
  /** Optional extra hardline patterns layered onto the static defaults. */
  hardlineBlocklist?: ReadonlyArray<{ pattern: RegExp; description: string }>;
  /** Override the default `executeWithTools` — primarily for tests. */
  runner?: ExecuteWithToolsRunner;
}

/** Source-code preamble length cap stored in the audit log — we don't want to
 *  pump megabytes of generated code into the security log. */
const AUDIT_CODE_LIMIT = 4 * 1024;

export function createCodeExecuteTool(deps: CodeExecuteToolDeps): ToolDefinition {
  return {
    manifest: {
      name: 'code.execute',
      description:
        'Execute JS/TS code in a sandboxed environment with access to a curated tool subset. Use this to chain multiple tools in one call (e.g., fetch -> parse -> fetch -> store) without per-step round-trips.',
      runtime: 'sandbox',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      // The transitive risk of any destructive allowlisted tool flows through
      // here, so we mark this destructive at the manifest level. The bridge
      // separately enforces `policy.allowDangerous` on the per-call check.
      safety: 'destructive',
      dangerLevel: 'high',
      inputSchema: {
        type: 'object',
        properties: {
          language: { type: 'string', enum: ['js', 'ts'] },
          code: { type: 'string' },
          allowedTools: { type: 'array', items: { type: 'string' } },
        },
        required: ['language', 'code'],
      },
    },
    async execute(input, context): Promise<ToolExecutionResult> {
      const language = input.language === 'ts' ? 'ts' : 'js';
      const code = typeof input.code === 'string' ? input.code : '';
      const allowedTools = Array.isArray(input.allowedTools)
        ? input.allowedTools.filter((x): x is string => typeof x === 'string')
        : [];

      if (!code) {
        return {
          toolName: 'code.execute',
          runtime: 'sandbox',
          ok: false,
          output: 'Missing required input: code',
          metadata: { ok: false, durationMs: 0, toolCallCount: 0 },
        };
      }

      // Audit-log entry — captured at the call site, BEFORE the sandbox runs,
      // so a runaway sandbox can't suppress its own audit row.
      if (deps.securityAuditLog) {
        recordCodeExecuteAudit(deps.securityAuditLog, {
          sessionId: context.sessionId,
          language,
          code,
          codeLimit: AUDIT_CODE_LIMIT,
          allowedTools,
        });
      }

      const runner = deps.runner ?? (await loadRunner());

      const result = await runner({
        code,
        language,
        toolRegistry: deps.toolRegistry,
        sessionId: context.sessionId,
        agentId: context.agentId,
        workspaceId: context.workspaceId,
        policy: {
          allowedTools,
          timeoutMs: 30_000,
          maxOutputBytes: 100_000,
          maxToolCalls: 50,
          allowDangerous: false,
        },
        eventBus: deps.eventBus,
        executeTool: deps.executeTool,
        hardlineBlocklist: deps.hardlineBlocklist,
        signal: context.signal,
        env: context.env,
      });

      // Stringify result so it round-trips through the conversation log
      // unchanged. The dashboard trace component reads .metadata.* directly,
      // so the JSON content is for the model only.
      const payload = {
        ok: result.ok,
        returnValue: result.returnValue,
        stdout: result.stdout,
        stderr: result.stderr,
        toolCalls: result.toolCalls,
        durationMs: result.durationMs,
        error: result.error,
        language,
      };

      return {
        toolName: 'code.execute',
        runtime: 'sandbox',
        ok: result.ok,
        output: JSON.stringify(payload, null, 2),
        metadata: {
          ok: result.ok,
          durationMs: result.durationMs,
          toolCallCount: result.toolCalls.length,
          language,
          allowedTools,
          stdout: result.stdout,
          stderr: result.stderr,
          toolCalls: result.toolCalls,
          error: result.error,
        },
      };
    },
  };
}

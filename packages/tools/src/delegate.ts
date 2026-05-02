import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ProviderAdapter,
  SessionStore,
  ToolCatalog,
  ToolExecutor,
  ToolManifest,
} from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';

/** Tools denied by default if deniedTools is not explicitly provided. */
const DEFAULT_DENIED_TOOLS = ['terminal.exec', 'terminal.background'];

export interface DelegationResult {
  childSessionId: string;
  toolsUsed: string[];
  iterationsRun: number;
  durationMs: number;
  success: boolean;
  summary: string;
}

export interface DelegateToolOptions {
  provider: ProviderAdapter;
  tools: ToolCatalog & ToolExecutor;
  sessions: SessionStore;
  maxDepth?: number;
  maxConcurrent?: number;
  maxIterations?: number;
  blockedTools?: string[];
  /** Whitelist: if set, child only gets these tools. */
  allowedTools?: string[];
  /** Blacklist: child gets all tools except these. Defaults to ['terminal.exec', 'terminal.background']. */
  deniedTools?: string[];
  /** Abort child after this duration (ms). Default: 120_000. */
  timeoutMs?: number;
  /** Whether child inherits parent credentials. Default: true. */
  inheritCredentials?: boolean;
  /** Callback invoked when a child task completes. */
  onComplete?: (result: DelegationResult) => void;
}

export interface DelegateTaskResult {
  task: string;
  response: string;
  toolsUsed: string[];
  success: boolean;
  childSessionId: string;
  iterationsRun: number;
  durationMs: number;
}

/**
 * Creates a delegate/subagent tool that spawns isolated child agent instances.
 * Each child gets its own session, filtered toolset, and depth tracking to
 * prevent infinite recursion.
 */
export function createDelegateTool(options: DelegateToolOptions): ToolDefinition {
  const {
    provider,
    tools,
    sessions,
    maxDepth = 2,
    maxConcurrent = 3,
    maxIterations = 50,
    blockedTools = ['delegate.task', 'clarify.ask', 'send.message'],
    allowedTools,
    deniedTools,
    timeoutMs = 120_000,
    inheritCredentials = true,
    onComplete,
  } = options;

  return {
    manifest: {
      name: 'delegate.task',
      description:
        'Spawns an isolated child agent to handle a subtask. The child has its own conversation context and restricted toolset.',
      runtime: 'worker',
      streaming: false,
      stateful: true,
      requiresWorkspace: false,
      requiresNetwork: true,
      dangerLevel: 'medium',
    },

    async execute(
      input: Record<string, unknown>,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      const currentDepth = context.delegateDepth ?? 0;
      if (typeof currentDepth === 'number' && currentDepth >= maxDepth) {
        return {
          toolName: 'delegate.task',
          runtime: 'worker',
          ok: false,
          output: `Maximum delegation depth (${maxDepth}) reached. Cannot spawn more child agents.`,
          metadata: { depth: currentDepth, maxDepth },
        };
      }

      const task = typeof input.task === 'string' ? input.task : '';
      const tasks = Array.isArray(input.tasks)
        ? input.tasks.filter((t): t is string => typeof t === 'string')
        : [];
      const customPrompt =
        typeof input.systemPrompt === 'string' ? input.systemPrompt : undefined;
      const childMaxIterations =
        typeof input.maxIterations === 'number' ? input.maxIterations : maxIterations;

      // Per-call overrides for toolset isolation
      const inputAllowedTools = Array.isArray(input.allowedTools)
        ? input.allowedTools.filter((t): t is string => typeof t === 'string')
        : undefined;
      const inputDeniedTools = Array.isArray(input.deniedTools)
        ? input.deniedTools.filter((t): t is string => typeof t === 'string')
        : undefined;
      const inputTimeoutMs =
        typeof input.timeoutMs === 'number' ? input.timeoutMs : timeoutMs;

      if (!task && tasks.length === 0) {
        return {
          toolName: 'delegate.task',
          runtime: 'worker',
          ok: false,
          output: 'Missing task description. Provide "task" (string) or "tasks" (string[]).',
        };
      }

      // Resolve toolset: allowedTools (whitelist) takes precedence over deniedTools (blacklist).
      // deniedTools defaults to DEFAULT_DENIED_TOOLS when neither is explicitly set.
      const effectiveAllowed = inputAllowedTools ?? allowedTools;
      const effectiveDenied = inputDeniedTools ?? deniedTools;
      const filteredTools = buildFilteredTools(
        tools,
        blockedTools,
        effectiveAllowed,
        effectiveDenied,
      );

      const depth = typeof currentDepth === 'number' ? currentDepth + 1 : 1;

      const runChild = async (childTask: string): Promise<DelegateTaskResult> => {
        const childSessionId = `child-${context.sessionId}-${crypto.randomUUID().slice(0, 8)}`;
        const systemPrompt =
          customPrompt ??
          `You are a CrowClaw sub-agent handling a delegated task. Task: ${childTask}`;

        const childLoop = new AgentLoop(provider, filteredTools, sessions, {
          maxToolIterations: childMaxIterations,
          stopOnToolError: true,
          concurrentToolCalls: true,
        });

        // Set up timeout + cancellation abort controller
        const childAbortController = new AbortController();
        const timeoutHandle = setTimeout(() => {
          childAbortController.abort(new Error(`Delegate task timed out after ${inputTimeoutMs}ms`));
        }, inputTimeoutMs);

        // Wire parent signal to child abort controller
        const parentSignal = context.signal;
        const onParentAbort = (): void => {
          childAbortController.abort(parentSignal?.reason ?? new Error('Parent cancelled'));
        };
        if (parentSignal) {
          if (parentSignal.aborted) {
            childAbortController.abort(parentSignal.reason ?? new Error('Parent already aborted'));
          } else {
            parentSignal.addEventListener('abort', onParentAbort, { once: true });
          }
        }

        const startTime = Date.now();

        try {
          const childContext: ToolExecutionContext = {
            agentId: context.agentId,
            sessionId: childSessionId,
            workspaceId: context.workspaceId,
            delegateDepth: depth,
            env: inheritCredentials ? context.env : undefined,
            signal: childAbortController.signal,
          };

          const result = await childLoop.run({
            agentId: context.agentId,
            sessionId: childSessionId,
            userMessage: childTask,
            systemPrompt,
            workspaceId: context.workspaceId,
            signal: childAbortController.signal,
          });

          const durationMs = Date.now() - startTime;
          const toolsUsed = result.toolResults.map((r) => r.toolName);
          const iterationsRun = result.toolResults.length;

          const delegationResult: DelegationResult = {
            childSessionId,
            toolsUsed,
            iterationsRun,
            durationMs,
            success: true,
            summary: result.finalResponse,
          };
          onComplete?.(delegationResult);

          return {
            task: childTask,
            response: result.finalResponse,
            toolsUsed,
            success: true,
            childSessionId,
            iterationsRun,
            durationMs,
          };
        } catch (error: unknown) {
          const durationMs = Date.now() - startTime;
          const message =
            error instanceof Error ? error.message : String(error);

          const delegationResult: DelegationResult = {
            childSessionId,
            toolsUsed: [],
            iterationsRun: 0,
            durationMs,
            success: false,
            summary: `Child agent failed: ${message}`,
          };
          onComplete?.(delegationResult);

          return {
            task: childTask,
            response: `Child agent failed: ${message}`,
            toolsUsed: [],
            success: false,
            childSessionId,
            iterationsRun: 0,
            durationMs,
          };
        } finally {
          clearTimeout(timeoutHandle);
          if (parentSignal && !parentSignal.aborted) {
            parentSignal.removeEventListener('abort', onParentAbort);
          }
        }
      };

      // Single task mode
      if (task && tasks.length === 0) {
        const result = await runChild(task);
        return {
          toolName: 'delegate.task',
          runtime: 'worker',
          ok: result.success,
          output: JSON.stringify(result),
          metadata: { depth, mode: 'single' },
        };
      }

      // Batch mode: run up to maxConcurrent tasks in parallel using a semaphore
      const allTasks = task ? [task, ...tasks] : tasks;
      const results = await runWithConcurrencyLimit(
        allTasks,
        maxConcurrent,
        runChild,
      );

      const allSucceeded = results.every((r) => r.success);
      return {
        toolName: 'delegate.task',
        runtime: 'worker',
        ok: allSucceeded,
        output: JSON.stringify(results),
        metadata: {
          depth,
          mode: 'batch',
          total: results.length,
          succeeded: results.filter((r) => r.success).length,
          failed: results.filter((r) => !r.success).length,
        },
      };
    },
  };
}

/**
 * Builds a filtered tool catalog/executor based on allow/deny lists.
 * Priority: blockedTools are always blocked. If allowedTools is set (whitelist mode),
 * only those tools pass. Otherwise, deniedTools (or DEFAULT_DENIED_TOOLS) are blocked.
 */
function buildFilteredTools(
  parent: ToolCatalog & ToolExecutor,
  blockedTools: string[],
  allowedTools: string[] | undefined,
  deniedTools: string[] | undefined,
): FilteredToolCatalogExecutor {
  if (allowedTools) {
    // Whitelist mode: only allowed tools pass, minus any blocked tools
    const allowedSet = new Set(allowedTools);
    const allNames = parent.list().map((m) => m.name);
    const denyList = allNames.filter((name) => !allowedSet.has(name));
    return new FilteredToolCatalogExecutor(parent, [...new Set([...denyList, ...blockedTools])]);
  }

  // Blacklist mode: blocked + denied + default denied
  const effectiveDenied = deniedTools ?? DEFAULT_DENIED_TOOLS;
  return new FilteredToolCatalogExecutor(parent, [...new Set([...blockedTools, ...effectiveDenied])]);
}

/**
 * Wraps a parent ToolCatalog & ToolExecutor, filtering out blocked tool names.
 * Children cannot access tools in the blocked list (e.g., delegate.task itself).
 */
export class FilteredToolCatalogExecutor implements ToolCatalog, ToolExecutor {
  private readonly blocked: Set<string>;

  constructor(
    private readonly parent: ToolCatalog & ToolExecutor,
    blockedTools: string[],
  ) {
    this.blocked = new Set(blockedTools);
  }

  list(): ToolManifest[] {
    return this.parent.list().filter((m) => !this.blocked.has(m.name));
  }

  get(name: string): ToolDefinition | undefined {
    if (this.blocked.has(name)) {
      return undefined;
    }
    return this.parent.get(name);
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (this.blocked.has(name)) {
      return {
        toolName: name,
        runtime: 'worker',
        ok: false,
        output: `Tool "${name}" is not available to child agents.`,
        metadata: { blocked: true },
      };
    }
    return this.parent.execute(name, input, context);
  }
}

/**
 * Runs an array of tasks with a concurrency limit using a simple semaphore pattern.
 */
async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index]!);
    }
  };

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

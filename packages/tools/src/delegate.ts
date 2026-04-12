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

export interface DelegateToolOptions {
  provider: ProviderAdapter;
  tools: ToolCatalog & ToolExecutor;
  sessions: SessionStore;
  maxDepth?: number;
  maxConcurrent?: number;
  maxIterations?: number;
  blockedTools?: string[];
}

export interface DelegateTaskResult {
  task: string;
  response: string;
  toolsUsed: string[];
  success: boolean;
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
      const currentDepth = (context as unknown as Record<string, unknown>).__delegateDepth ?? 0;
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

      if (!task && tasks.length === 0) {
        return {
          toolName: 'delegate.task',
          runtime: 'worker',
          ok: false,
          output: 'Missing task description. Provide "task" (string) or "tasks" (string[]).',
        };
      }

      const filteredTools = new FilteredToolCatalogExecutor(tools, blockedTools);
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

        try {
          const childContext: ToolExecutionContext = {
            agentId: context.agentId,
            sessionId: childSessionId,
            workspaceId: context.workspaceId,
            env: context.env,
            signal: context.signal,
          };
          // Attach depth metadata so recursive delegates are blocked
          (childContext as unknown as Record<string, unknown>).__delegateDepth = depth;

          const result = await childLoop.run({
            agentId: context.agentId,
            sessionId: childSessionId,
            userMessage: childTask,
            systemPrompt,
            workspaceId: context.workspaceId,
            signal: context.signal,
          });

          const toolsUsed = result.toolResults.map((r) => r.toolName);
          return {
            task: childTask,
            response: result.finalResponse,
            toolsUsed,
            success: true,
          };
        } catch (error: unknown) {
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            task: childTask,
            response: `Child agent failed: ${message}`,
            toolsUsed: [],
            success: false,
          };
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

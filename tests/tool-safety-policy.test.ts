import { beforeEach, describe, expect, it } from 'vitest';
import type {
  ProviderAdapter,
  ProviderRequest,
  ProviderResponse,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolSafetyLevel,
} from '@crowclaw/core';
import { AgentLoop, type ToolDefinition } from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry } from '@crowclaw/tools';

// Track execution order across tool calls
const executionLog: string[] = [];

function createSafetyTool(
  name: string,
  safety: ToolSafetyLevel | undefined,
  delayMs: number = 10,
): ToolDefinition {
  return {
    manifest: {
      name,
      description: `Tool ${name} with safety=${safety ?? 'undefined'}`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      safety,
    },
    async execute(
      _input: Record<string, unknown>,
      _context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> {
      executionLog.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      executionLog.push(`${name}:end`);
      return {
        toolName: name,
        runtime: 'worker',
        ok: true,
        output: `${name} done`,
      };
    },
  };
}

class SafetyTestProvider implements ProviderAdapter {
  constructor(private readonly toolNames: string[]) {}

  private called = false;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.called) {
      this.called = true;
      return {
        assistantMessage: 'Running tools.',
        toolCalls: this.toolNames.map((name) => ({ name, input: {} })),
      };
    }
    return { assistantMessage: 'Done.' };
  }
}

describe('Tool Safety Policy', () => {
  beforeEach(() => {
    executionLog.length = 0;
  });

  it('runs destructive tools sequentially after parallel tools', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('reader-a', 'read-only', 20))
      .register(createSafetyTool('reader-b', 'read-only', 20))
      .register(createSafetyTool('destroyer', 'destructive', 5));

    const agent = new AgentLoop(
      new SafetyTestProvider(['reader-a', 'reader-b', 'destroyer']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-1',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(3);
    expect(result.toolResults.every((r) => r.ok)).toBe(true);

    // Destructive tool must start after all parallel tools finish
    const destroyerStartIdx = executionLog.indexOf('destroyer:start');
    const readerAEndIdx = executionLog.indexOf('reader-a:end');
    const readerBEndIdx = executionLog.indexOf('reader-b:end');

    expect(destroyerStartIdx).toBeGreaterThan(readerAEndIdx);
    expect(destroyerStartIdx).toBeGreaterThan(readerBEndIdx);
  });

  it('runs read-only tools in parallel', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('reader-a', 'read-only', 30))
      .register(createSafetyTool('reader-b', 'read-only', 30));

    const agent = new AgentLoop(
      new SafetyTestProvider(['reader-a', 'reader-b']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-2',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(2);

    // Both should start before either ends (parallel execution)
    const aStart = executionLog.indexOf('reader-a:start');
    const bStart = executionLog.indexOf('reader-b:start');
    const aEnd = executionLog.indexOf('reader-a:end');
    const bEnd = executionLog.indexOf('reader-b:end');

    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(bEnd);
    // Both start before either ends
    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(aEnd);
  });

  it('runs multiple destructive tools sequentially', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('destroy-a', 'destructive', 10))
      .register(createSafetyTool('destroy-b', 'destructive', 10));

    const agent = new AgentLoop(
      new SafetyTestProvider(['destroy-a', 'destroy-b']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-3',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(2);

    // destroy-b must start after destroy-a ends (sequential)
    const aEnd = executionLog.indexOf('destroy-a:end');
    const bStart = executionLog.indexOf('destroy-b:start');

    expect(bStart).toBeGreaterThan(aEnd);
  });

  it('falls back to all-parallel when no safety annotations exist', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('tool-a', undefined, 30))
      .register(createSafetyTool('tool-b', undefined, 30));

    const agent = new AgentLoop(
      new SafetyTestProvider(['tool-a', 'tool-b']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-4',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(2);

    // Both should start before either ends (all-parallel fallback)
    const aStart = executionLog.indexOf('tool-a:start');
    const bStart = executionLog.indexOf('tool-b:start');
    const aEnd = executionLog.indexOf('tool-a:end');

    expect(aStart).toBeLessThan(aEnd);
    expect(bStart).toBeLessThan(aEnd);
  });

  it('treats idempotent tools as parallel-safe', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('idempotent-a', 'idempotent', 20))
      .register(createSafetyTool('reader-a', 'read-only', 20))
      .register(createSafetyTool('destroyer', 'destructive', 5));

    const agent = new AgentLoop(
      new SafetyTestProvider(['idempotent-a', 'reader-a', 'destroyer']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-5',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(3);

    // Idempotent and read-only should run in parallel, destructive after
    const idempotentStart = executionLog.indexOf('idempotent-a:start');
    const readerStart = executionLog.indexOf('reader-a:start');
    const destroyerStart = executionLog.indexOf('destroyer:start');
    const idempotentEnd = executionLog.indexOf('idempotent-a:end');
    const readerEnd = executionLog.indexOf('reader-a:end');

    // Both parallel tools start before either ends
    expect(idempotentStart).toBeLessThan(idempotentEnd);
    expect(readerStart).toBeLessThan(idempotentEnd);

    // Destructive starts after both parallel tools end
    expect(destroyerStart).toBeGreaterThan(idempotentEnd);
    expect(destroyerStart).toBeGreaterThan(readerEnd);
  });

  it('runs single tool call normally regardless of safety level', async () => {
    const tools = new ToolRegistry()
      .register(createSafetyTool('destroyer', 'destructive', 5));

    const agent = new AgentLoop(
      new SafetyTestProvider(['destroyer']),
      tools,
      new InMemorySessionStore(),
      { concurrentToolCalls: true },
    );

    const result = await agent.run({
      agentId: 'test',
      sessionId: 'safety-7',
      userMessage: 'go',
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0].ok).toBe(true);
    expect(result.toolResults[0].toolName).toBe('destroyer');
  });
});

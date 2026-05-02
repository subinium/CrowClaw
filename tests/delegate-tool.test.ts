import { describe, expect, it } from 'vitest';
import { createDelegateTool } from '@crowclaw/tools';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool, createTimeTool } from '@crowclaw/tools';

describe('delegate tool', () => {
  function buildDelegateSetup() {
    const provider = new EchoProvider();
    const tools = new ToolRegistry();
    tools.register(createEchoTool());
    tools.register(createTimeTool());
    const sessions = new InMemorySessionStore();

    const delegateTool = createDelegateTool({
      provider,
      tools,
      sessions,
      maxDepth: 2,
      maxConcurrent: 2,
      maxIterations: 3,
      blockedTools: ['delegate.task']
    });

    return { delegateTool, tools, sessions };
  }

  it('has correct manifest', () => {
    const { delegateTool } = buildDelegateSetup();
    expect(delegateTool.manifest.name).toBe('delegate.task');
    expect(delegateTool.manifest.dangerLevel).toBe('medium');
  });

  it('rejects when no task is provided', async () => {
    const { delegateTool } = buildDelegateSetup();
    const result = await delegateTool.execute({}, {
      agentId: 'crowclaw',
      sessionId: 'parent-1'
    });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Missing task');
  });

  it('executes a single delegated task', async () => {
    const { delegateTool } = buildDelegateSetup();
    const result = await delegateTool.execute(
      { task: 'Say hello to the world' },
      { agentId: 'crowclaw', sessionId: 'parent-2' }
    );
    expect(result.ok).toBe(true);
    expect(result.output).toBeTruthy();
    const parsed = JSON.parse(result.output);
    expect(parsed.task).toBe('Say hello to the world');
    expect(parsed.success).toBe(true);
    expect(typeof parsed.response).toBe('string');
  });

  it('executes batch tasks concurrently', async () => {
    const { delegateTool } = buildDelegateSetup();
    const result = await delegateTool.execute(
      { tasks: ['Task A', 'Task B'] },
      { agentId: 'crowclaw', sessionId: 'parent-3' }
    );
    expect(result.ok).toBe(true);
    const parsed = JSON.parse(result.output);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].task).toBe('Task A');
    expect(parsed[1].task).toBe('Task B');
  });

  it('blocks delegation beyond max depth', async () => {
    const { delegateTool } = buildDelegateSetup();
    const result = await delegateTool.execute(
      { task: 'Deep task' },
      {
        agentId: 'crowclaw',
        sessionId: 'parent-4',
        delegateDepth: 2
      }
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Maximum delegation depth');
  });

  it('rejects invalid delegation depth metadata', async () => {
    const { delegateTool } = buildDelegateSetup();
    const result = await delegateTool.execute(
      { task: 'Bad depth' },
      {
        agentId: 'crowclaw',
        sessionId: 'parent-invalid-depth',
        delegateDepth: Number.NaN
      }
    );
    expect(result.ok).toBe(false);
    expect(result.output).toContain('Invalid delegation depth');
    expect(result.metadata?.validationFailed).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse, ToolExecutionContext, ToolExecutionResult } from '@crowclaw/core';
import { AgentLoop, type ToolDefinition } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

class ScriptedLoopProvider implements ProviderAdapter {
  private callCount = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount += 1;
    if (this.callCount === 1) {
      return {
        assistantMessage: 'Need first tool.',
        toolCalls: [{ name: 'echo', input: { step: 1 } }]
      };
    }
    if (this.callCount === 2) {
      return {
        assistantMessage: 'Need second tool.',
        toolCalls: [{ name: 'echo', input: { step: 2 } }]
      };
    }
    return {
      assistantMessage: 'All done after multiple tool iterations.'
    };
  }
}

class ToolFailureProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      assistantMessage: 'Run the missing tool.',
      toolCalls: [{ name: 'missing.tool', input: {} }]
    };
  }
}

class FailingProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    throw new Error('Primary provider failed.');
  }
}

class RetryOnceProvider implements ProviderAdapter {
  private attempts = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error('Transient failure');
    }
    return { assistantMessage: 'Recovered after retry.' };
  }
}

class AbortAwareProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    if (request.signal?.aborted) {
      throw new Error('Provider saw abort');
    }
    return { assistantMessage: 'Should not happen if aborted early.' };
  }
}

function delayedTool(name: string, delayMs: number, dangerLevel: 'low' | 'medium' | 'high' = 'low'): ToolDefinition {
  return {
    manifest: {
      name,
      description: `Delayed tool ${name}`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel
    },
    async execute(_input: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionResult> {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return {
        toolName: name,
        runtime: 'worker',
        ok: true,
        output: name
      };
    }
  };
}

class ParallelProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length === 0) {
      return {
        assistantMessage: 'Run both tools.',
        toolCalls: [
          { name: 'slow', input: {} },
          { name: 'fast', input: {} }
        ]
      };
    }

    return {
      assistantMessage: `Observed order: ${toolMessages.map((message) => message.name).join(',')}`
    };
  }
}

class DangerousToolProvider implements ProviderAdapter {
  async generate(request: ProviderRequest): Promise<ProviderResponse> {
    const toolMessages = request.messages.filter((message) => message.role === 'tool');
    if (toolMessages.length > 0) {
      return {
        assistantMessage: 'Dangerous tool handled.'
      };
    }

    return {
      assistantMessage: 'Run the dangerous tool.',
      toolCalls: [{ name: 'danger', input: { command: 'rm -rf /tmp/demo' } }]
    };
  }
}

describe('AgentLoop', () => {
  it('returns a plain response for normal chat input', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore());
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-1',
      userMessage: 'hello crowclaw'
    });

    expect(result.finalResponse).toContain('CrowClaw received');
    expect(result.toolResults).toHaveLength(0);
    expect(result.session.messages.at(-1)?.role).toBe('assistant');
  });

  it('falls back to a secondary provider when the primary fails', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new FailingProvider(), tools, new InMemorySessionStore(), {
      fallbackProviders: [new EchoProvider()]
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'fallback-1',
      userMessage: 'fallback me'
    });

    expect(result.finalResponse).toContain('CrowClaw received: fallback me');
  });

  it('retries a transient provider failure before succeeding', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new RetryOnceProvider(), tools, new InMemorySessionStore(), {
      retryDelaysMs: [0]
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'retry-1',
      userMessage: 'retry me'
    });

    expect(result.finalResponse).toContain('Recovered after retry.');
  });

  it('throws if aborted before running', async () => {
    const controller = new AbortController();
    controller.abort();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new AbortAwareProvider(), tools, new InMemorySessionStore());

    await expect(agent.run({
      agentId: 'crowclaw',
      sessionId: 'abort-1',
      userMessage: 'should abort',
      signal: controller.signal
    })).rejects.toThrow('Agent run aborted.');
  });

  it('runs a tool then asks the provider for a final post-tool answer', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore());
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-2',
      userMessage: '/tool echo {"hello":"world"}'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({
      toolName: 'echo',
      runtime: 'worker',
      ok: true
    });
    expect(result.finalResponse).toContain('Tool echo returned');
  });

  it('continues looping while the provider keeps returning tool calls', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ScriptedLoopProvider(), tools, new InMemorySessionStore(), {
      maxToolIterations: 3
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-3',
      userMessage: 'do the whole workflow'
    });

    expect(result.toolResults).toHaveLength(2);
    expect(result.finalResponse).toContain('All done after multiple tool iterations.');
    expect(result.session.messages.filter((message) => message.role === 'tool')).toHaveLength(2);
  });

  it('stops early on tool failure by default', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ToolFailureProvider(), tools, new InMemorySessionStore(), {
      errorReflection: false,
    });
    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-4',
      userMessage: 'run failing tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.ok).toBe(false);
    expect(result.finalResponse).toContain('Stopped after tool failure.');
  });

  it('executes concurrent tool calls while preserving declared order in results/messages', async () => {
    const tools = new ToolRegistry()
      .register(delayedTool('slow', 20))
      .register(delayedTool('fast', 1));
    const agent = new AgentLoop(new ParallelProvider(), tools, new InMemorySessionStore(), {
      concurrentToolCalls: true
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-5',
      userMessage: 'run in parallel'
    });

    expect(result.toolResults.map((tool) => tool.toolName)).toEqual(['slow', 'fast']);
    expect(result.finalResponse).toContain('Observed order: slow,fast');
  });

  it('blocks dangerous tools when approval is required and denied', async () => {
    const tools = new ToolRegistry().register(delayedTool('danger', 0, 'high'));
    const agent = new AgentLoop(new DangerousToolProvider(), tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => false
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-6',
      userMessage: 'run dangerous tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({ ok: false });
    expect(result.toolResults[0]?.output).toContain('requires approval');
  });

  it('allows dangerous tools when approval is granted', async () => {
    const tools = new ToolRegistry().register(delayedTool('danger', 0, 'high'));
    const agent = new AgentLoop(new DangerousToolProvider(), tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => true
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-7',
      userMessage: 'run dangerous tool'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]).toMatchObject({ ok: true, toolName: 'danger' });
  });

  it('blocks medium-danger inputs that match destructive command patterns when approval is required', async () => {
    const riskyTool: ToolDefinition = {
      manifest: {
        name: 'terminal.exec',
        description: 'Runs shell commands',
        runtime: 'worker',
        streaming: false,
        stateful: false,
        requiresWorkspace: false,
        requiresNetwork: false,
        dangerLevel: 'medium'
      },
      async execute() {
        return { toolName: 'terminal.exec', runtime: 'worker', ok: true, output: 'should not run' };
      }
    };
    const provider: ProviderAdapter = {
      async generate() {
        return {
          assistantMessage: 'Run risky command.',
          toolCalls: [{ name: 'terminal.exec', input: { command: 'rm -rf /tmp/demo' } }]
        };
      }
    };
    const tools = new ToolRegistry().register(riskyTool);
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      requireApprovalForDangerousTools: true,
      approvalDecider: async () => false
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-7b',
      userMessage: 'run dangerous pattern'
    });

    expect(result.toolResults[0]?.metadata).toMatchObject({ blockedByApproval: true });
    expect(result.toolResults[0]?.output).toContain('requires approval');
  });

  it('stops when max tool iterations are exhausted', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new ScriptedLoopProvider(), tools, new InMemorySessionStore(), {
      maxToolIterations: 1,
      synthesizeOnExhaustion: false,
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'session-8',
      userMessage: 'loop until capped'
    });

    expect(result.toolResults).toHaveLength(1);
    expect(result.finalResponse).toContain('Reached maximum tool iterations.');
  });
});

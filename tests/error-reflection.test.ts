import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

/** Provider that always requests a non-existent tool */
class AlwaysFailProvider implements ProviderAdapter {
  callCount = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount++;
    return {
      assistantMessage: `Attempt ${this.callCount}`,
      toolCalls: [{ name: 'nonexistent.tool', input: {} }],
    };
  }
}

/** Provider that fails once then succeeds */
class RecoverableProvider implements ProviderAdapter {
  callCount = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.callCount++;
    if (this.callCount <= 2) {
      return {
        assistantMessage: 'Trying bad tool',
        toolCalls: [{ name: 'nonexistent.tool', input: {} }],
      };
    }
    return { assistantMessage: 'Recovered successfully' };
  }
}

describe('error reflection', () => {
  it('injects reflection messages on tool failure before stopping', async () => {
    const provider = new AlwaysFailProvider();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      errorReflection: true,
      maxErrorReflections: 2,
      maxToolIterations: 10,
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'reflect-1',
      userMessage: 'do something',
    });

    // Should have reflection system messages in session
    const reflectionMessages = result.session.messages.filter(
      (m) => m.metadata?.errorReflection === true,
    );
    expect(reflectionMessages.length).toBeGreaterThanOrEqual(1);
    expect(reflectionMessages.length).toBeLessThanOrEqual(2);

    // Should eventually stop
    expect(result.finalResponse).toContain('Stopped after tool failure');
  });

  it('allows recovery after reflection', async () => {
    const provider = new RecoverableProvider();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
      errorReflection: true,
      maxErrorReflections: 3,
      maxToolIterations: 10,
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'reflect-2',
      userMessage: 'try something',
    });

    // Provider recovers on call 3, so final response should not be "Stopped"
    expect(result.finalResponse).toBe('Recovered successfully');
  });

  it('skips reflection when errorReflection is disabled', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new AlwaysFailProvider(), tools, new InMemorySessionStore(), {
      errorReflection: false,
      maxToolIterations: 5,
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'reflect-3',
      userMessage: 'fail immediately',
    });

    // Should stop after first failure with no reflection messages
    expect(result.toolResults).toHaveLength(1);
    expect(result.finalResponse).toContain('Stopped after tool failure');
    const reflections = result.session.messages.filter(
      (m) => m.metadata?.errorReflection === true,
    );
    expect(reflections).toHaveLength(0);
  });
});

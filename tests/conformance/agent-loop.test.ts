import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

class EndlessToolProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      assistantMessage: 'Still need a tool.',
      toolCalls: [{ name: 'echo', input: { looping: true } }]
    };
  }
}

describe('conformance: basic agent semantics', () => {
  it('persists prior turns between calls', async () => {
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, store);

    await agent.run({ agentId: 'crowclaw', sessionId: 'persisted', userMessage: 'first' });
    const second = await agent.run({ agentId: 'crowclaw', sessionId: 'persisted', userMessage: 'second' });

    const userMessages = second.session.messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(2);
  });

  it('stops looping after the configured max tool iterations', async () => {
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EndlessToolProvider(), tools, store, { maxToolIterations: 2 });

    const result = await agent.run({ agentId: 'crowclaw', sessionId: 'loop-cap', userMessage: 'loop' });

    expect(result.toolResults).toHaveLength(2);
    expect(result.finalResponse).toContain('Still need a tool.');
  });

  it('can disable concurrent tool execution when stricter sequencing is needed', async () => {
    const store = new InMemorySessionStore();
    const tools = new ToolRegistry().register(createEchoTool());
    const provider: ProviderAdapter = {
      async generate(_request: ProviderRequest): Promise<ProviderResponse> {
        return { assistantMessage: 'done' };
      }
    };

    const agent = new AgentLoop(provider, tools, store, { concurrentToolCalls: false });
    const result = await agent.run({ agentId: 'crowclaw', sessionId: 'seq', userMessage: 'no tool' });
    expect(result.finalResponse).toContain('done');
  });
});

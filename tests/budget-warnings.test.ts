import { describe, expect, it } from 'vitest';
import type { ProviderAdapter, ProviderRequest, ProviderResponse } from '@crowclaw/core';
import { AgentLoop } from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

class RepeatingToolProvider implements ProviderAdapter {
  private count = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.count += 1;
    if (this.count <= 2) {
      return {
        assistantMessage: 'Keep working.',
        toolCalls: [{ name: 'echo', input: { count: this.count } }]
      };
    }
    return { assistantMessage: 'done' };
  }
}

describe('budget warning semantics', () => {
  it('annotates tool results with budget warnings near the iteration cap', async () => {
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new RepeatingToolProvider(), tools, new InMemorySessionStore(), {
      maxToolIterations: 2,
      budgetWarningThreshold: 40,
      budgetCriticalThreshold: 90
    });

    const result = await agent.run({
      agentId: 'crowclaw',
      sessionId: 'budget-1',
      userMessage: 'go'
    });

    expect(result.toolResults).toHaveLength(2);
    expect(result.toolResults[0]?.metadata?.budgetWarning).toContain('BUDGET');
    expect(result.toolResults[1]?.metadata?.budgetWarning).toContain('BUDGET WARNING');
  });
});

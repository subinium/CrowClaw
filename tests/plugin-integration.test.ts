import { describe, expect, it } from 'vitest';
import { AgentLoop, type ProviderAdapter, type ProviderRequest, type ProviderResponse } from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { MemoryCapturePlugin, PluginManager } from '../packages/plugins/src/index.js';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

class FlakyProvider implements ProviderAdapter {
  private attempts = 0;

  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    this.attempts += 1;
    if (this.attempts === 1) {
      throw new Error('Transient provider issue');
    }
    return {
      assistantMessage: 'Recovered response.',
      toolCalls: [{ name: 'echo', input: { value: 'hi' } }]
    };
  }
}

class MissingToolProvider implements ProviderAdapter {
  async generate(_request: ProviderRequest): Promise<ProviderResponse> {
    return {
      assistantMessage: 'Run a missing tool.',
      toolCalls: [{ name: 'missing.tool', input: {} }]
    };
  }
}

describe('plugin integration with agent loop', () => {
  it('emits beforeRun, tool:result, and afterRun hooks during an agent turn', async () => {
    const plugin = new MemoryCapturePlugin();
    const plugins = new PluginManager().register(plugin);
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new EchoProvider(), tools, new InMemorySessionStore(), {
      plugins,
      runtimeName: 'node'
    });

    await agent.run({
      agentId: 'crowclaw',
      sessionId: 'plugin-run-1',
      userMessage: '/tool echo {"value":"hi"}'
    });

    expect(plugin.seen).toEqual([
      { hook: 'agent:beforeRun', sessionId: 'plugin-run-1' },
      { hook: 'provider:beforeGenerate', sessionId: 'plugin-run-1' },
      { hook: 'provider:afterGenerate', sessionId: 'plugin-run-1' },
      { hook: 'tool:beforeExecute', sessionId: 'plugin-run-1' },
      { hook: 'tool:result', sessionId: 'plugin-run-1' },
      { hook: 'provider:beforeGenerate', sessionId: 'plugin-run-1' },
      { hook: 'provider:afterGenerate', sessionId: 'plugin-run-1' },
      { hook: 'agent:afterRun', sessionId: 'plugin-run-1' }
    ]);
  });

  it('emits provider:error hooks during retry recovery', async () => {
    const plugin = new MemoryCapturePlugin();
    const plugins = new PluginManager().register(plugin);
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new FlakyProvider(), tools, new InMemorySessionStore(), {
      plugins,
      runtimeName: 'node',
      retryDelaysMs: [0]
    });

    await agent.run({
      agentId: 'crowclaw',
      sessionId: 'plugin-run-2',
      userMessage: 'recover with retry'
    });

    expect(plugin.seen).toContainEqual({ hook: 'provider:error', sessionId: 'plugin-run-2' });
    expect(plugin.seen).toContainEqual({ hook: 'tool:beforeExecute', sessionId: 'plugin-run-2' });
  });

  it('emits tool:error hooks when tool execution fails', async () => {
    const plugin = new MemoryCapturePlugin();
    const plugins = new PluginManager().register(plugin);
    const tools = new ToolRegistry().register(createEchoTool());
    const agent = new AgentLoop(new MissingToolProvider(), tools, new InMemorySessionStore(), {
      plugins,
      runtimeName: 'node'
    });

    await agent.run({
      agentId: 'crowclaw',
      sessionId: 'plugin-run-3',
      userMessage: 'trigger missing tool'
    });

    expect(plugin.seen).toContainEqual({ hook: 'tool:error', sessionId: 'plugin-run-3' });
    expect(plugin.seen).toContainEqual({ hook: 'tool:result', sessionId: 'plugin-run-3' });
  });
});

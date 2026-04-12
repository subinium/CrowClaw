import { describe, expect, it } from 'vitest';
import { MemoryCapturePlugin, PluginManager } from '../packages/plugins/src/index.js';

describe('plugin foundation', () => {
  it('registers plugins and emits lifecycle hooks', async () => {
    const plugin = new MemoryCapturePlugin();
    const manager = new PluginManager().register(plugin);

    await manager.emit('agent:beforeRun', {
      input: {
        agentId: 'crowclaw',
        sessionId: 'plugin-1',
        userMessage: 'hello plugins'
      }
    }, {
      runtime: 'node',
      sessionId: 'plugin-1',
      agentId: 'crowclaw'
    });

    expect(manager.list()).toHaveLength(1);
    expect(plugin.seen).toEqual([{ hook: 'agent:beforeRun', sessionId: 'plugin-1' }]);
  });

  it('emits tool result hooks', async () => {
    const plugin = new MemoryCapturePlugin();
    const manager = new PluginManager().register(plugin);

    await manager.emit('tool:result', {
      result: {
        toolName: 'echo',
        runtime: 'worker',
        ok: true,
        output: 'ok'
      },
      sessionId: 'plugin-2',
      agentId: 'crowclaw'
    }, {
      runtime: 'cloudflare',
      sessionId: 'plugin-2',
      agentId: 'crowclaw'
    });

    expect(plugin.seen).toEqual([{ hook: 'tool:result', sessionId: 'plugin-2' }]);
  });

  it('emits provider lifecycle hooks', async () => {
    const plugin = new MemoryCapturePlugin();
    const manager = new PluginManager().register(plugin);

    await manager.emit('provider:beforeGenerate', {
      attempt: 1,
      providerIndex: 0,
      messageCount: 2
    }, {
      runtime: 'node',
      sessionId: 'plugin-3',
      agentId: 'crowclaw'
    });

    await manager.emit('provider:afterGenerate', {
      attempt: 1,
      providerIndex: 0,
      messageCount: 2,
      toolCallCount: 1,
      assistantMessage: 'hello'
    }, {
      runtime: 'node',
      sessionId: 'plugin-3',
      agentId: 'crowclaw'
    });

    expect(plugin.seen).toEqual([
      { hook: 'provider:beforeGenerate', sessionId: 'plugin-3' },
      { hook: 'provider:afterGenerate', sessionId: 'plugin-3' }
    ]);
  });

  it('emits provider error and tool beforeExecute hooks', async () => {
    const plugin = new MemoryCapturePlugin();
    const manager = new PluginManager().register(plugin);

    await manager.emit('provider:error', {
      attempt: 1,
      providerIndex: 0,
      messageCount: 2,
      error: 'boom'
    }, {
      runtime: 'node',
      sessionId: 'plugin-4',
      agentId: 'crowclaw'
    });

    await manager.emit('tool:beforeExecute', {
      toolName: 'echo',
      input: { value: 'hi' },
      sessionId: 'plugin-4',
      agentId: 'crowclaw'
    }, {
      runtime: 'node',
      sessionId: 'plugin-4',
      agentId: 'crowclaw'
    });

    expect(plugin.seen).toEqual([
      { hook: 'provider:error', sessionId: 'plugin-4' },
      { hook: 'tool:beforeExecute', sessionId: 'plugin-4' }
    ]);
  });

  it('emits tool error hooks', async () => {
    const plugin = new MemoryCapturePlugin();
    const manager = new PluginManager().register(plugin);

    await manager.emit('tool:error', {
      result: {
        toolName: 'danger',
        ok: false,
        output: 'Tool requires approval: danger'
      },
      sessionId: 'plugin-5',
      agentId: 'crowclaw'
    }, {
      runtime: 'node',
      sessionId: 'plugin-5',
      agentId: 'crowclaw'
    });

    expect(plugin.seen).toEqual([{ hook: 'tool:error', sessionId: 'plugin-5' }]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  MemoryCapturePlugin,
  PluginCatalog,
  PluginManager,
  ReferencePreToolCallPlugin,
  ReferenceToolResultPlugin,
  createMemoryBackendPlugin,
  validatePluginManifest,
} from '../packages/plugins/src/index.js';

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

  it('validates plugin manifests without allowing raw command execution requests', () => {
    expect(validatePluginManifest({
      name: 'safe-plugin',
      hooks: ['tool:preExecute'],
      permissions: { tools: ['workspace.read'], memory: 'read' },
    }).valid).toBe(true);

    const unsafe = validatePluginManifest({
      name: 'unsafe-plugin',
      permissions: { tools: ['terminal.exec'] },
    });
    expect(unsafe.valid).toBe(false);
    expect(unsafe.errors.join('\n')).toContain('terminal.exec');
  });

  it('registers plugin catalog entries and memory backend plugin references', () => {
    const provider = {
      recall: async () => [],
      store: async (record: Record<string, unknown>) => record,
      delete: async () => true,
      list: async () => [],
    };
    const plugin = createMemoryBackendPlugin({ name: 'memory-test', provider });
    const catalog = new PluginCatalog();
    const result = catalog.register(plugin.manifest, plugin);

    expect(result.valid).toBe(true);
    expect(catalog.get('memory-test')?.plugin).toBe(plugin);
    expect(catalog.list()[0]?.memoryBackend).toBe(true);
  });

  it('provides reference pre-tool-call and tool-result plugins', async () => {
    const pre = new ReferencePreToolCallPlugin('deny-shell', ['terminal.exec']);
    expect(pre.preToolCall!({ toolName: 'terminal.exec', input: {}, sessionId: 's', agentId: 'a' }, {
      runtime: 'node',
      sessionId: 's',
      agentId: 'a',
    })).toMatchObject({ veto: true });

    const transform = new ReferenceToolResultPlugin('tagger');
    expect(transform.transformToolResult!({
      toolName: 'echo',
      input: {},
      result: { toolName: 'echo', ok: true, output: 'ok' },
      sessionId: 's',
      agentId: 'a',
    }, {
      runtime: 'node',
      sessionId: 's',
      agentId: 'a',
    })).toEqual({ metadata: { transformedBy: 'tagger' } });
  });
});

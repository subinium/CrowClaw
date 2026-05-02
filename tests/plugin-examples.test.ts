import { describe, expect, it } from 'vitest';
import { PluginManager } from '../packages/plugins/src/index.js';
import { BlockRmRfEverythingPlugin } from '../packages/plugins/examples/block-rm-rf-everything.js';
import { AutoRedactPiiPlugin } from '../packages/plugins/examples/auto-redact-pii.js';
import { MetricTapPlugin } from '../packages/plugins/examples/metric-tap.js';

const context = { runtime: 'node', sessionId: 'plugin-examples', agentId: 'agent-1' };

describe('plugin reference examples', () => {
  it('vetoes broad destructive shell commands before execution', async () => {
    const manager = new PluginManager().register(new BlockRmRfEverythingPlugin());

    const veto = await manager.preToolCall({
      toolName: 'terminal.exec',
      input: { command: 'rm -rf /' },
      sessionId: context.sessionId,
      agentId: context.agentId,
    }, context);

    expect(veto.veto).toBe(true);
    expect(veto.reason).toContain('block-rm-rf-everything');
  });

  it('redacts PII in transformed tool results', async () => {
    const manager = new PluginManager().register(new AutoRedactPiiPlugin());

    const result = await manager.transformToolResult({
      toolName: 'echo',
      input: {},
      result: {
        toolName: 'echo',
        ok: true,
        output: 'Contact me at jane@example.com',
      },
      sessionId: context.sessionId,
      agentId: context.agentId,
    }, context);

    expect(result.output).not.toContain('jane@example.com');
    expect(result.metadata?.piiRedactedCount).toBeGreaterThan(0);
  });

  it('records post-tool metrics through the hook contract', async () => {
    const plugin = new MetricTapPlugin();
    const manager = new PluginManager().register(plugin);

    await manager.preToolCall({
      toolName: 'echo',
      input: {},
      sessionId: context.sessionId,
      agentId: context.agentId,
    }, context);
    await manager.emit('tool:result', {
      result: { toolName: 'echo', ok: true, output: 'ok' },
      sessionId: context.sessionId,
      agentId: context.agentId,
    }, context);

    expect(plugin.snapshot()).toHaveLength(1);
    expect(plugin.renderPrometheus()).toContain('crowclaw_plugin_tool_calls_total{tool="echo"} 1');
  });
});

import { describe, expect, it } from 'vitest';
import { ToolRegistry, createEchoTool, createTimeTool, createToolListTool } from '@crowclaw/tools';

describe('tool.list helper', () => {
  it('reports registered tool manifests', async () => {
    const registry = new ToolRegistry();
    registry.register(createEchoTool()).register(createTimeTool()).register(createToolListTool(registry));
    const result = await registry.execute('tool.list', {}, {
      agentId: 'crowclaw',
      sessionId: 'session-tool-list'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toContain('tool.list');
    expect(result.output).toContain('echo');
  });
});

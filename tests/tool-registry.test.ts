import { describe, expect, it } from 'vitest';
import { ToolRegistry, createEchoTool, createTimeTool } from '@crowclaw/tools';

describe('ToolRegistry', () => {
  it('lists registered manifests', () => {
    const registry = new ToolRegistry().register(createEchoTool()).register(createTimeTool());
    expect(registry.list().map((tool) => tool.name)).toEqual(['echo', 'time']);
  });

  it('returns an error result for missing tools', async () => {
    const registry = new ToolRegistry();
    const result = await registry.execute('missing', {}, {
      agentId: 'crowclaw',
      sessionId: 'session-3'
    });
    expect(result.ok).toBe(false);
  });
});

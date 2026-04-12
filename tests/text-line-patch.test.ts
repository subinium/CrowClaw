import { describe, expect, it } from 'vitest';
import { ToolRegistry, createLinePatchTool } from '@crowclaw/tools';

describe('line-based text patch tool', () => {
  it('patches specific line numbers while preserving others', async () => {
    const registry = new ToolRegistry().register(createLinePatchTool());
    const result = await registry.execute('text.patchLines', {
      text: 'alpha\nbeta\ngamma',
      patches: [
        { line: 2, value: 'BETA' },
        { line: 3, value: 'GAMMA' }
      ]
    }, {
      agentId: 'crowclaw',
      sessionId: 'line-patch-1'
    });

    expect(result.ok).toBe(true);
    expect(result.output).toBe('alpha\nBETA\nGAMMA');
    expect(result.metadata).toMatchObject({ patches: 2 });
  });
});

import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from '@crowclaw/core';

describe('prompt builder', () => {
  it('assembles a structured system prompt from runtime context and tools', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
      runtimeName: 'node',
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      userId: 'user-1',
      availableTools: [
        {
          name: 'echo',
          description: 'Echo tool',
          runtime: 'worker',
          streaming: false,
          stateful: false,
          requiresWorkspace: false,
          requiresNetwork: false,
          dangerLevel: 'low'
        }
      ]
    });

    expect(prompt).toContain('You are CrowClaw.');
    expect(prompt).toContain('Runtime context:');
    expect(prompt).toContain('Runtime: node');
    expect(prompt).toContain('Session: session-1');
    expect(prompt).toContain('Workspace: workspace-1');
    expect(prompt).toContain('User: user-1');
    expect(prompt).toContain('Available tools:');
    expect(prompt).toContain('- echo (worker, danger:low)');
  });
});

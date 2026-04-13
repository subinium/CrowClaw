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

  it('injects recalled memories into the system prompt', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
      runtimeName: 'node',
      sessionId: 'session-1',
      memories: [
        'User prefers TypeScript over JavaScript',
        'Previous session discussed Cloudflare Workers deployment',
      ],
    });

    expect(prompt).toContain('## Relevant Memories');
    expect(prompt).toContain('- User prefers TypeScript over JavaScript');
    expect(prompt).toContain('- Previous session discussed Cloudflare Workers deployment');
  });

  it('omits memory section when memories array is empty', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
      memories: [],
    });

    expect(prompt).not.toContain('Relevant Memories');
  });

  it('omits memory section when memories is undefined', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
    });

    expect(prompt).not.toContain('Relevant Memories');
  });

  it('places memories after runtime context and before tools', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
      runtimeName: 'node',
      sessionId: 'session-1',
      memories: ['User expertise: TypeScript, React'],
      availableTools: [
        {
          name: 'echo',
          description: 'Echo tool',
          runtime: 'worker',
          streaming: false,
          stateful: false,
          requiresWorkspace: false,
          requiresNetwork: false,
          dangerLevel: 'low',
        },
      ],
      reasoningGuidance: false,
    });

    const runtimeIdx = prompt!.indexOf('Runtime context:');
    const memoryIdx = prompt!.indexOf('## Relevant Memories');
    const toolsIdx = prompt!.indexOf('Available tools:');

    expect(runtimeIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(toolsIdx);
  });
});

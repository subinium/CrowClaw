import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, buildMemoryPrefix } from '@crowclaw/core';

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

  it('does not inject memories into system prompt (moved to untrusted prefix)', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are CrowClaw.',
      runtimeName: 'node',
      sessionId: 'session-1',
      memories: [
        'User prefers TypeScript over JavaScript',
        'Previous session discussed Cloudflare Workers deployment',
      ],
    });

    // Memories are no longer in system prompt — they use buildMemoryPrefix() instead
    expect(prompt).not.toContain('## Relevant Memories');
  });

  it('buildMemoryPrefix creates untrusted context block', () => {
    const prefix = buildMemoryPrefix([
      'User prefers TypeScript over JavaScript',
      'Previous session discussed Cloudflare Workers deployment',
    ]);

    expect(prefix).toContain('<recalled-context');
    expect(prefix).toContain('trust="low"');
    expect(prefix).toContain('- User prefers TypeScript over JavaScript');
    expect(prefix).toContain('- Previous session discussed Cloudflare Workers deployment');
  });

  it('buildMemoryPrefix returns undefined for empty memories', () => {
    expect(buildMemoryPrefix([])).toBeUndefined();
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

  it('system prompt has no memory section even with memories passed', () => {
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

    expect(prompt).toContain('Runtime context:');
    expect(prompt).toContain('Available tools:');
    // Memories are now in a separate untrusted prefix, not in system prompt
    expect(prompt).not.toContain('Relevant Memories');
  });
});

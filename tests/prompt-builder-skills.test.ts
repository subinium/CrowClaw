import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../packages/core/src/prompt-builder.js';

describe('Prompt Builder - Skill Injection (Hermes parity, #230)', () => {
  // v0.8.0 #230: matched skills moved out of the system prompt and into a
  // synthetic user-role message in the agent loop. The `matchedSkills`
  // parameter is still accepted by buildSystemPrompt() for backward compat
  // and observability, but its contents are NOT serialised into the prompt.
  it('does NOT include matched skill content in system prompt', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'You are a helpful assistant.',
      matchedSkills: [
        {
          name: 'deploy-vercel',
          description: 'Deploy to Vercel',
          instructions: '1. Run npm build\n2. Run vercel deploy',
          tools: ['terminal.exec'],
        },
      ],
    });
    expect(prompt).toContain('You are a helpful assistant.');
    expect(prompt).not.toContain('deploy-vercel');
    expect(prompt).not.toContain('Deploy to Vercel');
    expect(prompt).not.toContain('npm build');
    expect(prompt).not.toContain('Relevant skills');
  });

  it('should include agent preset in prompt', () => {
    const prompt = buildSystemPrompt({
      agentPreset: {
        role: 'Senior engineer',
        goal: 'Write clean code',
        backstory: 'Expert in TypeScript',
      },
    });
    expect(prompt).toContain('Senior engineer');
    expect(prompt).toContain('Write clean code');
    expect(prompt).toContain('Expert in TypeScript');
  });

  it('system prompt is byte-stable when matchedSkills changes (#230 cache-hit invariant)', () => {
    // Two identical inputs except for skills must produce identical system
    // prompts so the prefix cache key never changes when skills rotate.
    const base = {
      basePrompt: 'You are CrowClaw.',
      runtimeName: 'node',
      sessionId: 'session-stable',
    };
    const promptA = buildSystemPrompt({
      ...base,
      matchedSkills: [{ name: 'a', description: 'A', instructions: 'do A' }],
    });
    const promptB = buildSystemPrompt({
      ...base,
      matchedSkills: [
        { name: 'a', description: 'A', instructions: 'do A' },
        { name: 'b', description: 'B', instructions: 'do B' },
      ],
    });
    const promptC = buildSystemPrompt({ ...base, matchedSkills: [] });
    expect(promptA).toBe(promptB);
    expect(promptA).toBe(promptC);
  });

  it('should work without skills or preset', () => {
    const prompt = buildSystemPrompt({
      basePrompt: 'Hello',
      runtimeName: 'test',
    });
    expect(prompt).toContain('Hello');
    expect(prompt).toContain('test');
  });
});

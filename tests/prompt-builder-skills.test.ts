import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../packages/core/src/prompt-builder.js';

describe('Prompt Builder - Skill Injection', () => {
  it('should include matched skills in prompt', () => {
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
    expect(prompt).toContain('deploy-vercel');
    expect(prompt).toContain('Deploy to Vercel');
    expect(prompt).toContain('npm build');
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

  it('should limit matched skills to 3', () => {
    const skills = Array.from({ length: 5 }, (_, i) => ({
      name: `skill-${i}`,
      description: `Skill ${i}`,
      instructions: `Do thing ${i}`,
    }));
    const prompt = buildSystemPrompt({
      matchedSkills: skills,
    });
    // Only first 3 should appear
    expect(prompt).toContain('skill-0');
    expect(prompt).toContain('skill-2');
    expect(prompt).not.toContain('skill-3');
    expect(prompt).not.toContain('skill-4');
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

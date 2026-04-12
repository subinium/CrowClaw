import { describe, expect, it } from 'vitest';
import { detectTaskCompletion, matchSkills, LearningPipeline, InMemorySkillStore, type StoredSkillDraft } from '@crowclaw/learning';

describe('improved task completion detection', () => {
  it('detects strong completion signals with high confidence', () => {
    const result = detectTaskCompletion([
      { role: 'user', content: 'fix the bug', createdAt: '' },
      { role: 'assistant', content: 'I\'ve finished applying the fix. The changes have been applied successfully.', createdAt: '' }
    ]);

    expect(result.completed).toBe(true);
    expect(result.confidence).toBe('high');
  });

  it('detects medium completion signals', () => {
    const result = detectTaskCompletion([
      { role: 'user', content: 'list files', createdAt: '' },
      { role: 'assistant', content: 'Here you go, let me know if you need anything else.', createdAt: '' }
    ]);

    expect(result.completed).toBe(true);
    expect(result.confidence).toMatch(/medium|high/);
  });

  it('detects non-completion when asking questions', () => {
    const result = detectTaskCompletion([
      { role: 'user', content: 'help me debug', createdAt: '' },
      { role: 'assistant', content: 'What error are you seeing?', createdAt: '' }
    ]);

    expect(result.completed).toBe(false);
  });

  it('detects non-completion on errors', () => {
    const result = detectTaskCompletion([
      { role: 'user', content: 'deploy the app', createdAt: '' },
      { role: 'assistant', content: 'The deployment failed with an error.', createdAt: '' }
    ]);

    expect(result.completed).toBe(false);
  });

  it('detects non-completion when work is in progress', () => {
    const result = detectTaskCompletion([
      { role: 'user', content: 'refactor the module', createdAt: '' },
      { role: 'assistant', content: 'I\'m still working on the refactor.', createdAt: '' }
    ]);

    expect(result.completed).toBe(false);
  });
});

describe('skill matching', () => {
  const skills: StoredSkillDraft[] = [
    {
      id: '1', slug: 'deploy-vercel', title: 'Deploy to Vercel',
      summary: 'Deploy a Next.js app to Vercel', triggerPhrases: ['deploy to vercel', 'vercel deployment'],
      steps: ['Run vercel deploy'], sourceMessages: 5,
      status: 'published', createdAt: '', updatedAt: '', markdown: ''
    },
    {
      id: '2', slug: 'setup-tailwind', title: 'Setup Tailwind CSS',
      summary: 'Install and configure Tailwind CSS', triggerPhrases: ['setup tailwind', 'add tailwind'],
      steps: ['npm install tailwindcss'], sourceMessages: 3,
      status: 'published', createdAt: '', updatedAt: '', markdown: ''
    },
    {
      id: '3', slug: 'git-workflow', title: 'Git Branch Workflow',
      summary: 'Standard git branching strategy', triggerPhrases: ['git workflow', 'branch strategy'],
      steps: ['Create feature branch'], sourceMessages: 4,
      status: 'draft', createdAt: '', updatedAt: '', markdown: ''
    }
  ];

  it('matches skills by trigger phrase', () => {
    const matches = matchSkills('deploy to vercel', skills);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skill.id).toBe('1');
  });

  it('matches skills by title words', () => {
    const matches = matchSkills('tailwind', skills);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].skill.id).toBe('2');
  });

  it('returns empty for no match', () => {
    const matches = matchSkills('quantum computing', skills);
    expect(matches.every(m => m.relevance === 0)).toBe(true);
  });

  it('respects limit parameter', () => {
    const matches = matchSkills('deploy', skills, 1);
    expect(matches.length).toBeLessThanOrEqual(1);
  });
});

describe('learning pipeline findRelevantSkills', () => {
  it('finds relevant published skills', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const draft = await pipeline.captureDraft([
      { role: 'user', content: 'deploy to vercel', createdAt: '' },
      { role: 'assistant', content: 'Running vercel deploy...', createdAt: '' }
    ], 'Deploy to Vercel');

    await pipeline.publishDraft(draft.id);

    const results = await pipeline.findRelevantSkills('vercel deployment');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].skill.title).toBe('Deploy to Vercel');
  });
});

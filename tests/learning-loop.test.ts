import { describe, expect, it } from 'vitest';
import {
  detectTaskCompletion,
  extractSkillDraft,
  InMemorySkillStore,
  LearningPipeline,
  renderSkillMarkdown,
} from '../packages/learning/src/index.js';

describe('learning loop foundation', () => {
  it('detects simple completion signals from assistant messages', () => {
    const signal = detectTaskCompletion([
      { role: 'user', content: 'please finish the task', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'All done. Task completed.', createdAt: new Date().toISOString() },
    ]);

    expect(signal.completed).toBe(true);
    expect(signal.confidence).toBe('high');
  });

  it('extracts a skill draft from a conversation and renders markdown', () => {
    const draft = extractSkillDraft([
      { role: 'user', content: 'deploy crowclaw to cloudflare', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'I configured the runtime and verified it.', createdAt: new Date().toISOString() },
    ], 'Deploy CrowClaw');

    expect(draft.slug).toBe('deploy-crowclaw');
    expect(draft.triggerPhrases).toContain('deploy crowclaw to cloudflare');

    const markdown = renderSkillMarkdown(draft);
    expect(markdown).toContain('# Deploy CrowClaw');
    expect(markdown).toContain('Trigger phrases');
  });

  it('captures and publishes skill drafts through the learning pipeline', async () => {
    const pipeline = new LearningPipeline(new InMemorySkillStore());
    const stored = await pipeline.captureDraft([
      { role: 'user', content: 'summarize the repo', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'I summarized the repository.', createdAt: new Date().toISOString() },
    ], 'Summarize Repo');

    expect(stored.status).toBe('draft');
    expect(stored.markdown).toContain('# Summarize Repo');

    const published = await pipeline.publishDraft(stored.id);
    expect(published.status).toBe('published');

    const all = await pipeline.listDrafts();
    expect(all).toHaveLength(1);
    expect(all[0]?.status).toBe('published');
  });
});

import { describe, it, expect } from 'vitest';
import {
  SkillRegistry,
  LearningPipeline,
  InMemorySkillStore,
  type StoredSkillDraft,
} from '@crowclaw/learning';

function makeDraft(overrides: Partial<StoredSkillDraft> = {}): StoredSkillDraft {
  return {
    id: crypto.randomUUID(),
    slug: 'test-skill',
    title: 'Test Skill',
    summary: 'A test skill for unit tests',
    triggerPhrases: ['test trigger'],
    steps: ['Step 1', 'Step 2'],
    sourceMessages: 2,
    status: 'published',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    markdown: '# Test Skill\n\nA test skill.',
    ...overrides,
  };
}

describe('SkillRegistry', () => {
  it('loads built-in skills from StoredSkillDraft[]', () => {
    const registry = new SkillRegistry();
    const drafts = [
      makeDraft({ slug: 'builtin-a', status: 'published' }),
      makeDraft({ slug: 'builtin-b', status: 'published' }),
    ];

    registry.loadBuiltIn(drafts);
    const resolved = registry.resolve();

    expect(resolved).toHaveLength(2);
    expect(resolved.map(s => s.manifest.name)).toContain('builtin-a');
    expect(resolved.map(s => s.manifest.name)).toContain('builtin-b');
  });

  it('adds published learned skills via addPublishedSkill', () => {
    const registry = new SkillRegistry();
    const draft = makeDraft({ slug: 'learned-skill', status: 'published' });

    registry.addPublishedSkill(draft);
    const resolved = registry.resolve();

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.name).toBe('learned-skill');
  });

  it('learned skills override built-in with same slug', () => {
    const registry = new SkillRegistry();
    const builtIn = makeDraft({
      slug: 'shared-slug',
      summary: 'built-in version',
      status: 'published',
    });
    const learned = makeDraft({
      slug: 'shared-slug',
      summary: 'learned version',
      status: 'published',
    });

    registry.loadBuiltIn([builtIn]);
    registry.addPublishedSkill(learned);
    const resolved = registry.resolve();

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.description).toBe('learned version');
  });

  it('local skills override learned skills with same slug', () => {
    const registry = new SkillRegistry();
    const learned = makeDraft({
      slug: 'shared-slug',
      summary: 'learned version',
      status: 'published',
    });

    registry.addPublishedSkill(learned);
    registry.setLocalSkills([{
      manifest: {
        name: 'shared-slug',
        description: 'local version',
        triggers: ['local trigger'],
        tools: [],
        category: 'local',
      },
      instructions: 'Local instructions',
      raw: '# Local Skill',
    }]);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.description).toBe('local version');
  });

  it('disabled skills are filtered out', () => {
    const registry = new SkillRegistry({
      disabledSlugs: new Set(['disabled-skill']),
    });
    const drafts = [
      makeDraft({ slug: 'enabled-skill', status: 'published' }),
      makeDraft({ slug: 'disabled-skill', status: 'published' }),
    ];

    registry.loadBuiltIn(drafts);
    const resolved = registry.resolve();

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.name).toBe('enabled-skill');
  });

  it('toggleSkill enables and disables skills', () => {
    const registry = new SkillRegistry();
    registry.loadBuiltIn([makeDraft({ slug: 'toggle-me', status: 'published' })]);

    expect(registry.resolve()).toHaveLength(1);

    registry.toggleSkill('toggle-me', false);
    expect(registry.resolve()).toHaveLength(0);

    registry.toggleSkill('toggle-me', true);
    expect(registry.resolve()).toHaveLength(1);
  });

  it('removeLearnedSkill removes a skill from learned list', () => {
    const registry = new SkillRegistry();
    registry.addPublishedSkill(makeDraft({ slug: 'to-remove', status: 'published' }));

    expect(registry.resolve()).toHaveLength(1);

    registry.removeLearnedSkill('to-remove');
    expect(registry.resolve()).toHaveLength(0);
  });

  it('refreshLearned loads published skills from store', async () => {
    const store = new InMemorySkillStore();
    await store.save(makeDraft({ id: '1', slug: 'stored-skill', status: 'published' }));
    await store.save(makeDraft({ id: '2', slug: 'draft-skill', status: 'draft' }));

    const registry = new SkillRegistry({ skillStore: store });
    await registry.refreshLearned();
    const resolved = registry.resolve();

    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.name).toBe('stored-skill');
  });

  it('refreshLearned is a no-op without a skill store', async () => {
    const registry = new SkillRegistry();
    await registry.refreshLearned();
    expect(registry.resolve()).toHaveLength(0);
  });

  it('stats() returns correct counts', () => {
    const registry = new SkillRegistry({
      disabledSlugs: new Set(['disabled-one']),
    });
    registry.loadBuiltIn([
      makeDraft({ slug: 'bi-1', status: 'published' }),
      makeDraft({ slug: 'bi-2', status: 'published' }),
    ]);
    registry.addPublishedSkill(makeDraft({ slug: 'learned-1', status: 'published' }));
    registry.setLocalSkills([{
      manifest: { name: 'local-1', description: '', triggers: [], tools: [] },
      instructions: '',
      raw: '',
    }]);

    const stats = registry.stats();
    expect(stats.builtin).toBe(2);
    expect(stats.learned).toBe(1);
    expect(stats.local).toBe(1);
    expect(stats.disabled).toBe(1);
    // 2 built-in + 1 learned + 1 local = 4 unique, 0 disabled from those = 4
    expect(stats.total).toBe(4);
  });

  it('updates existing learned skill with same slug via addPublishedSkill', () => {
    const registry = new SkillRegistry();
    const v1 = makeDraft({ slug: 'versioned', summary: 'v1', status: 'published' });
    const v2 = makeDraft({ slug: 'versioned', summary: 'v2', status: 'published' });

    registry.addPublishedSkill(v1);
    registry.addPublishedSkill(v2);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.description).toBe('v2');
  });
});

describe('LearningPipeline registry integration', () => {
  it('publishDraft() notifies the registry', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);
    const registry = new SkillRegistry();
    pipeline.setRegistry(registry);

    const draft = await pipeline.captureDraft([
      { role: 'user', content: 'deploy to vercel', createdAt: '' },
      { role: 'assistant', content: 'Deployed successfully.', createdAt: '' },
    ], 'Deploy Vercel');

    expect(registry.resolve()).toHaveLength(0);

    await pipeline.publishDraft(draft.id);

    const resolved = registry.resolve();
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.manifest.name).toBe('deploy-vercel');
  });

  it('unpublishDraft() removes from registry', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);
    const registry = new SkillRegistry();
    pipeline.setRegistry(registry);

    const draft = await pipeline.captureDraft([
      { role: 'user', content: 'setup tailwind', createdAt: '' },
      { role: 'assistant', content: 'Tailwind configured.', createdAt: '' },
    ], 'Setup Tailwind');

    const published = await pipeline.publishDraft(draft.id);
    expect(registry.resolve()).toHaveLength(1);

    await pipeline.unpublishDraft(published.id);
    expect(registry.resolve()).toHaveLength(0);
  });

  it('unpublishDraft() throws for non-existent draft', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    await expect(pipeline.unpublishDraft('nonexistent')).rejects.toThrow(
      'Skill draft not found: nonexistent'
    );
  });

  it('autoCapture() only captures on high/medium confidence completion', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    // Low confidence / incomplete -- should return null
    const noCapture = await pipeline.autoCapture([
      { role: 'user', content: 'help me debug', createdAt: '' },
      { role: 'assistant', content: 'What error are you seeing?', createdAt: '' },
    ]);
    expect(noCapture).toBeNull();

    // High confidence completion -- should capture
    const captured = await pipeline.autoCapture([
      { role: 'user', content: 'fix the bug', createdAt: '' },
      { role: 'assistant', content: 'I\'ve finished applying the fix. The changes have been applied successfully.', createdAt: '' },
    ], 'Bug Fix Skill');
    expect(captured).not.toBeNull();
    expect(captured!.status).toBe('draft');
    expect(captured!.title).toBe('Bug Fix Skill');
  });

  it('autoCapture() uses default title when none provided', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const captured = await pipeline.autoCapture([
      { role: 'user', content: 'deploy the app', createdAt: '' },
      { role: 'assistant', content: 'All done. Task complete. Successfully completed.', createdAt: '' },
    ]);
    expect(captured).not.toBeNull();
    expect(captured!.slug).toBe('auto-captured-skill');
  });

  it('pipeline works without registry set (no crash)', async () => {
    const store = new InMemorySkillStore();
    const pipeline = new LearningPipeline(store);

    const draft = await pipeline.captureDraft([
      { role: 'user', content: 'test', createdAt: '' },
      { role: 'assistant', content: 'Done.', createdAt: '' },
    ], 'Test Skill');

    // Should not throw even without registry
    const published = await pipeline.publishDraft(draft.id);
    expect(published.status).toBe('published');

    const unpublished = await pipeline.unpublishDraft(draft.id);
    expect(unpublished.status).toBe('draft');
  });
});

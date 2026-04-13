/**
 * E2E: Learning Flow — cross-subsystem integration
 *
 * Tests the learning pipeline end-to-end: capture drafts, publish, match,
 * LLM-powered extraction, skill rating, and auto-unpublish.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';

import {
  LearningPipeline,
  InMemorySkillStore,
  SkillRegistry,
  getBuiltInSkills,
  loadBuiltInSkills,
  detectTaskCompletion,
  matchSkills,
  createLlmSkillExtractor,
  type StoredSkillDraft,
  type SkillExtractionProvider,
} from '@crowclaw/learning';
import type { ConversationMessage } from '@crowclaw/core';

// ============================================================================
// 1. Learning pipeline: capture -> publish -> match
// ============================================================================

describe('E2E: learning pipeline capture -> publish -> match', () => {
  let store: InMemorySkillStore;
  let registry: SkillRegistry;
  let pipeline: LearningPipeline;

  beforeEach(async () => {
    store = new InMemorySkillStore();
    registry = new SkillRegistry({ skillStore: store });
    pipeline = new LearningPipeline(store);
    pipeline.setRegistry(registry);
    await loadBuiltInSkills(store);
    registry.loadBuiltIn(getBuiltInSkills());
  });

  it('captures a draft from conversation, publishes it, and matches via findRelevantSkills', async () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'how do I deploy to kubernetes?', createdAt: new Date().toISOString() },
      { role: 'assistant', content: '1. Create a deployment.yaml\n2. Run kubectl apply -f deployment.yaml\n3. Check pod status with kubectl get pods\nAll done!', createdAt: new Date().toISOString() },
    ];

    // Capture
    const draft = await pipeline.captureDraft(messages, 'kubernetes-deploy');
    expect(draft.status).toBe('draft');
    expect(draft.slug).toBe('kubernetes-deploy');
    expect(draft.triggerPhrases.length).toBeGreaterThan(0);

    // Publish
    const published = await pipeline.publishDraft(draft.id);
    expect(published.status).toBe('published');

    // Registry should now include the learned skill
    const resolved = registry.resolve();
    const found = resolved.find((s) => s.manifest.name === 'kubernetes-deploy');
    expect(found).toBeDefined();

    // findRelevantSkills should match
    const matches = await pipeline.findRelevantSkills('deploy to kubernetes');
    expect(matches.length).toBeGreaterThan(0);
    const k8sMatch = matches.find((m) => m.skill.slug === 'kubernetes-deploy');
    expect(k8sMatch).toBeDefined();
    expect(k8sMatch!.relevance).toBeGreaterThan(0);
  });

  it('autoCapture produces a draft only for completed conversations', async () => {
    // Incomplete: assistant asks a question
    const incomplete: ConversationMessage[] = [
      { role: 'user', content: 'help me set up authentication', createdAt: '' },
      { role: 'assistant', content: 'Which authentication provider do you want to use?', createdAt: '' },
    ];
    const noDraft = await pipeline.autoCapture(incomplete);
    expect(noDraft).toBeNull();

    // Completed: assistant declares success
    const complete: ConversationMessage[] = [
      { role: 'user', content: 'set up OAuth2 with NextAuth', createdAt: '' },
      { role: 'assistant', content: 'Successfully configured NextAuth with Google OAuth2. All done! Here is the URL.', createdAt: '' },
    ];
    const draft = await pipeline.autoCapture(complete);
    expect(draft).not.toBeNull();
    expect(draft!.status).toBe('draft');
  });

  it('unpublish removes skill from registry', async () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'create a CI pipeline', createdAt: '' },
      { role: 'assistant', content: 'Pipeline created and running. Done.', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'ci-pipeline-setup');
    await pipeline.publishDraft(draft.id);

    // Verify present
    expect(registry.resolve().find((s) => s.manifest.name === 'ci-pipeline-setup')).toBeDefined();

    // Unpublish
    await pipeline.unpublishDraft(draft.id);

    // Verify removed
    expect(registry.resolve().find((s) => s.manifest.name === 'ci-pipeline-setup')).toBeUndefined();
  });
});

// ============================================================================
// 2. LLM-powered extraction with mock
// ============================================================================

describe('E2E: LLM-powered skill extraction', () => {
  it('uses LLM extractor when provided and includes pitfalls and verificationSteps', async () => {
    const store = new InMemorySkillStore();
    let llmCalled = false;

    const mockLlm = async (_prompt: string): Promise<string> => {
      llmCalled = true;
      return JSON.stringify({
        slug: 'docker-setup',
        title: 'Docker Setup',
        summary: 'Set up Docker for local development',
        triggerPhrases: ['set up docker', 'docker setup', 'configure docker'],
        steps: ['Install Docker', 'Create Dockerfile', 'Run docker compose up'],
        pitfalls: ['Forgetting to add .dockerignore', 'Using latest tag in production'],
        verificationSteps: ['Run docker ps to verify containers', 'Check docker logs'],
      });
    };

    const extractionProvider = createLlmSkillExtractor(mockLlm);
    const pipeline = new LearningPipeline(store, { extractionProvider });

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'help me set up docker', createdAt: '' },
      { role: 'assistant', content: 'Sure! Install Docker, create a Dockerfile, run docker compose up. All done!', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'docker-setup');

    expect(llmCalled).toBe(true);
    expect(draft.slug).toBe('docker-setup');
    expect(draft.pitfalls).toBeDefined();
    expect(draft.pitfalls!.length).toBeGreaterThan(0);
    expect(draft.verificationSteps).toBeDefined();
    expect(draft.verificationSteps!.length).toBeGreaterThan(0);
  });

  it('falls back to heuristic when LLM extractor returns null', async () => {
    const store = new InMemorySkillStore();

    const mockLlm = async (_prompt: string): Promise<string> => {
      return 'null'; // LLM decides this is not a skill
    };

    const extractionProvider = createLlmSkillExtractor(mockLlm);
    const pipeline = new LearningPipeline(store, { extractionProvider });

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'deploy the app', createdAt: '' },
      { role: 'assistant', content: 'Running deployment. All done!', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'deploy-app');
    // Should fall back to heuristic extraction
    expect(draft.slug).toBe('deploy-app');
    expect(draft.status).toBe('draft');
  });
});

// ============================================================================
// 3. Skill rating and auto-unpublish
// ============================================================================

describe('E2E: skill rating and auto-unpublish', () => {
  it('auto-unpublishes after 3 unhelpful ratings', async () => {
    const store = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore: store });
    const pipeline = new LearningPipeline(store, { unpublishThreshold: 3 });
    pipeline.setRegistry(registry);

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'set up monitoring', createdAt: '' },
      { role: 'assistant', content: 'Monitoring configured. Done.', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'monitoring-setup');
    await pipeline.publishDraft(draft.id);

    // Verify published
    expect(registry.resolve().find((s) => s.manifest.name === 'monitoring-setup')).toBeDefined();

    // Rate unhelpful 3 times
    await pipeline.rateSkill('monitoring-setup', 'unhelpful');
    await pipeline.rateSkill('monitoring-setup', 'unhelpful');
    await pipeline.rateSkill('monitoring-setup', 'unhelpful');

    // Verify auto-unpublished
    const skill = await store.get(draft.id);
    expect(skill!.status).toBe('draft');
    expect(skill!.ratings!.unhelpful).toBe(3);

    // Registry should no longer include it
    expect(registry.resolve().find((s) => s.manifest.name === 'monitoring-setup')).toBeUndefined();
  });

  it('helpful ratings do not trigger auto-unpublish', async () => {
    const store = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore: store });
    const pipeline = new LearningPipeline(store, { unpublishThreshold: 3 });
    pipeline.setRegistry(registry);

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'set up logging', createdAt: '' },
      { role: 'assistant', content: 'Logging configured. Done.', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'logging-setup');
    await pipeline.publishDraft(draft.id);

    // Rate helpful 5 times
    for (let i = 0; i < 5; i++) {
      await pipeline.rateSkill('logging-setup', 'helpful');
    }

    // Should still be published
    const skill = await store.get(draft.id);
    expect(skill!.status).toBe('published');
    expect(skill!.ratings!.helpful).toBe(5);
    expect(skill!.ratings!.unhelpful).toBe(0);
  });

  it('mixed ratings only unpublish when threshold is reached', async () => {
    const store = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore: store });
    const pipeline = new LearningPipeline(store, { unpublishThreshold: 3 });
    pipeline.setRegistry(registry);

    const messages: ConversationMessage[] = [
      { role: 'user', content: 'set up caching', createdAt: '' },
      { role: 'assistant', content: 'Caching configured. Done.', createdAt: '' },
    ];

    const draft = await pipeline.captureDraft(messages, 'caching-setup');
    await pipeline.publishDraft(draft.id);

    // Mixed: 5 helpful, 2 unhelpful = still published
    for (let i = 0; i < 5; i++) {
      await pipeline.rateSkill('caching-setup', 'helpful');
    }
    await pipeline.rateSkill('caching-setup', 'unhelpful');
    await pipeline.rateSkill('caching-setup', 'unhelpful');

    let skill = await store.get(draft.id);
    expect(skill!.status).toBe('published');

    // 3rd unhelpful triggers unpublish
    await pipeline.rateSkill('caching-setup', 'unhelpful');
    skill = await store.get(draft.id);
    expect(skill!.status).toBe('draft');
  });
});

// ============================================================================
// 4. Skill matching accuracy
// ============================================================================

describe('E2E: skill matching across built-in and learned skills', () => {
  it('learned skills match queries alongside built-in skills', async () => {
    const store = new InMemorySkillStore();
    const registry = new SkillRegistry({ skillStore: store });
    const pipeline = new LearningPipeline(store);
    pipeline.setRegistry(registry);

    // Load built-in skills
    await loadBuiltInSkills(store);
    registry.loadBuiltIn(getBuiltInSkills());

    // Add a learned skill
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'set up terraform for AWS', createdAt: '' },
      { role: 'assistant', content: 'Terraform configured with AWS provider. All done.', createdAt: '' },
    ];
    const draft = await pipeline.captureDraft(messages, 'terraform-aws-setup');
    await pipeline.publishDraft(draft.id);

    // Query should match both built-in and learned
    const allSkills = await store.list();
    const published = allSkills.filter((s) => s.status === 'published');
    const matches = matchSkills('terraform infrastructure setup', published, 10);

    expect(matches.length).toBeGreaterThan(0);
    // The learned terraform skill should appear in results
    const terraformMatch = matches.find((m) => m.skill.slug === 'terraform-aws-setup');
    expect(terraformMatch).toBeDefined();
  });
});

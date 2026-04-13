import { describe, expect, it } from 'vitest';
import {
  detectTaskCompletion,
  extractSkillDraft,
  InMemorySkillStore,
  LearningPipeline,
  renderSkillMarkdown,
} from '../packages/learning/src/index.js';
import type { StoredSkillDraft } from '../packages/learning/src/index.js';
import { SkillMetricsTracker } from '../packages/learning/src/skill-metrics.js';
import type { SkillUsageRecord } from '../packages/learning/src/skill-metrics.js';
import { skillSimilarity, findDuplicates, mergeSkills } from '../packages/learning/src/skill-dedup.js';
import { generateImprovementPlan, detectCompletionEnhanced } from '../packages/learning/src/auto-improver.js';

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

// --- Helper: create a StoredSkillDraft for testing ---
function makeSkill(overrides: Partial<StoredSkillDraft> = {}): StoredSkillDraft {
  return {
    id: crypto.randomUUID(),
    slug: 'test-skill',
    title: 'Test Skill',
    summary: 'A test skill for unit testing',
    triggerPhrases: ['run test', 'execute tests'],
    steps: ['Step one', 'Step two'],
    sourceMessages: 2,
    status: 'published',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    markdown: '# Test Skill',
    version: 1,
    ratings: { helpful: 0, unhelpful: 0 },
    ...overrides,
  };
}

function makeUsageRecord(overrides: Partial<SkillUsageRecord> = {}): SkillUsageRecord {
  return {
    skillSlug: 'test-skill',
    sessionId: 'session-1',
    usedAt: new Date().toISOString(),
    completionConfidence: 'high',
    durationMs: 1000,
    toolsUsed: ['web.search'],
    ...overrides,
  };
}

// =====================================================================
// Skill Metrics Tests
// =====================================================================

describe('SkillMetricsTracker', () => {
  it('records usage and retrieves metrics', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord({ skillSlug: 'deploy', durationMs: 500 }));
    tracker.record(makeUsageRecord({ skillSlug: 'deploy', durationMs: 1500 }));

    const metrics = tracker.getMetrics('deploy');
    expect(metrics.slug).toBe('deploy');
    expect(metrics.totalUses).toBe(2);
    expect(metrics.lastUsedAt).not.toBeNull();
  });

  it('calculates success rate from completion confidence', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord({ completionConfidence: 'high' }));
    tracker.record(makeUsageRecord({ completionConfidence: 'medium' }));
    tracker.record(makeUsageRecord({ completionConfidence: 'low' }));

    const metrics = tracker.getMetrics('test-skill');
    // 2 successes (high + medium) out of 3
    expect(metrics.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('calculates average duration', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord({ durationMs: 100 }));
    tracker.record(makeUsageRecord({ durationMs: 300 }));

    const metrics = tracker.getMetrics('test-skill');
    expect(metrics.averageDurationMs).toBe(200);
  });

  it('calculates helpful rate from user ratings', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord({ userRating: 'helpful' }));
    tracker.record(makeUsageRecord({ userRating: 'helpful' }));
    tracker.record(makeUsageRecord({ userRating: 'unhelpful' }));
    tracker.record(makeUsageRecord({})); // no rating

    const metrics = tracker.getMetrics('test-skill');
    // 2 helpful out of 3 rated (unrated excluded)
    expect(metrics.helpfulRate).toBeCloseTo(2 / 3, 5);
  });

  it('detects improving trend', () => {
    const tracker = new SkillMetricsTracker();
    const baseTime = new Date('2025-01-01').getTime();

    // Previous 5: mostly low confidence (failures)
    for (let i = 0; i < 5; i++) {
      tracker.record(
        makeUsageRecord({
          completionConfidence: i < 4 ? 'low' : 'high',
          usedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
    }
    // Recent 5: all high confidence (successes)
    for (let i = 5; i < 10; i++) {
      tracker.record(
        makeUsageRecord({
          completionConfidence: 'high',
          usedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
    }

    const metrics = tracker.getMetrics('test-skill');
    expect(metrics.trend).toBe('improving');
  });

  it('detects stable trend', () => {
    const tracker = new SkillMetricsTracker();
    const baseTime = new Date('2025-01-01').getTime();

    // All 10 records: high confidence
    for (let i = 0; i < 10; i++) {
      tracker.record(
        makeUsageRecord({
          completionConfidence: 'high',
          usedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
    }

    const metrics = tracker.getMetrics('test-skill');
    expect(metrics.trend).toBe('stable');
  });

  it('detects declining trend', () => {
    const tracker = new SkillMetricsTracker();
    const baseTime = new Date('2025-01-01').getTime();

    // Previous 5: all high confidence
    for (let i = 0; i < 5; i++) {
      tracker.record(
        makeUsageRecord({
          completionConfidence: 'high',
          usedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
    }
    // Recent 5: mostly low confidence
    for (let i = 5; i < 10; i++) {
      tracker.record(
        makeUsageRecord({
          completionConfidence: i < 9 ? 'low' : 'high',
          usedAt: new Date(baseTime + i * 1000).toISOString(),
        }),
      );
    }

    const metrics = tracker.getMetrics('test-skill');
    expect(metrics.trend).toBe('declining');
  });

  it('returns insufficient-data for few records', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord());

    const metrics = tracker.getMetrics('test-skill');
    expect(metrics.trend).toBe('insufficient-data');
  });

  it('getImprovementCandidates returns low-performing skills', () => {
    const tracker = new SkillMetricsTracker();
    // Low success rate skill
    tracker.record(makeUsageRecord({ skillSlug: 'bad-skill', completionConfidence: 'low' }));
    tracker.record(makeUsageRecord({ skillSlug: 'bad-skill', completionConfidence: 'low' }));
    // High success rate skill
    tracker.record(makeUsageRecord({ skillSlug: 'good-skill', completionConfidence: 'high' }));
    tracker.record(makeUsageRecord({ skillSlug: 'good-skill', completionConfidence: 'high' }));

    const candidates = tracker.getImprovementCandidates(0.5);
    expect(candidates.map((c) => c.slug)).toContain('bad-skill');
    expect(candidates.map((c) => c.slug)).not.toContain('good-skill');
  });

  it('getTopPerformers returns best skills', () => {
    const tracker = new SkillMetricsTracker();
    tracker.record(makeUsageRecord({ skillSlug: 'great', completionConfidence: 'high' }));
    tracker.record(makeUsageRecord({ skillSlug: 'great', completionConfidence: 'high' }));
    tracker.record(makeUsageRecord({ skillSlug: 'meh', completionConfidence: 'low' }));
    tracker.record(makeUsageRecord({ skillSlug: 'meh', completionConfidence: 'low' }));

    const top = tracker.getTopPerformers(1);
    expect(top).toHaveLength(1);
    expect(top[0]?.slug).toBe('great');
  });

  it('returns empty metrics for unknown skill', () => {
    const tracker = new SkillMetricsTracker();
    const metrics = tracker.getMetrics('nonexistent');

    expect(metrics.totalUses).toBe(0);
    expect(metrics.successRate).toBe(0);
    expect(metrics.lastUsedAt).toBeNull();
    expect(metrics.trend).toBe('insufficient-data');
    expect(metrics.topToolsUsed).toEqual([]);
  });
});

// =====================================================================
// Skill Dedup Tests
// =====================================================================

describe('skill deduplication', () => {
  it('skillSimilarity returns 1.0 for identical skills', () => {
    const skill = makeSkill();
    expect(skillSimilarity(skill, { ...skill })).toBeCloseTo(1.0, 1);
  });

  it('skillSimilarity returns 0 for completely different skills', () => {
    const a = makeSkill({
      title: 'Deploy Application',
      triggerPhrases: ['deploy app', 'push to production'],
      steps: ['Build docker image', 'Push to registry'],
      summary: 'Deploys the application to production servers',
    });
    const b = makeSkill({
      title: 'Write Poetry',
      triggerPhrases: ['compose haiku', 'write sonnet'],
      steps: ['Choose topic', 'Select meter'],
      summary: 'Creates poems in various styles and forms',
    });

    const sim = skillSimilarity(a, b);
    expect(sim).toBeLessThan(0.1);
  });

  it('skillSimilarity returns high score for similar skills', () => {
    const a = makeSkill({
      title: 'Deploy to Cloudflare',
      triggerPhrases: ['deploy cloudflare', 'push to cloudflare workers'],
      steps: ['Build project', 'Configure wrangler', 'Deploy workers'],
      summary: 'Deploy application to Cloudflare Workers',
    });
    const b = makeSkill({
      title: 'Deploy to Cloudflare Workers',
      triggerPhrases: ['deploy to cloudflare', 'cloudflare workers deploy'],
      steps: ['Build the project', 'Set up wrangler config', 'Deploy to workers'],
      summary: 'Deploy app to Cloudflare Workers platform',
    });

    const sim = skillSimilarity(a, b);
    expect(sim).toBeGreaterThan(0.5);
  });

  it('findDuplicates identifies pairs above threshold', () => {
    const a = makeSkill({
      slug: 'deploy-cf-1',
      title: 'Deploy to Cloudflare',
      triggerPhrases: ['deploy cloudflare', 'push to cloudflare workers'],
      steps: ['Build project', 'Configure wrangler', 'Deploy workers'],
      summary: 'Deploy application to Cloudflare Workers',
    });
    const b = makeSkill({
      slug: 'deploy-cf-2',
      title: 'Deploy to Cloudflare Workers',
      triggerPhrases: ['deploy to cloudflare', 'cloudflare workers deploy'],
      steps: ['Build the project', 'Set up wrangler config', 'Deploy to workers'],
      summary: 'Deploy app to Cloudflare Workers platform',
    });

    const result = findDuplicates([a, b], 0.4);
    expect(result.duplicates.length).toBeGreaterThanOrEqual(1);
    expect(result.mergeRecommendations.length).toBeGreaterThanOrEqual(1);
  });

  it('findDuplicates returns empty for unique skills', () => {
    const a = makeSkill({
      slug: 'deploy-app',
      title: 'Deploy Application',
      triggerPhrases: ['deploy app'],
      steps: ['Build docker image'],
      summary: 'Deploys the application',
    });
    const b = makeSkill({
      slug: 'write-poetry',
      title: 'Write Poetry',
      triggerPhrases: ['compose haiku'],
      steps: ['Choose topic'],
      summary: 'Creates poems',
    });

    const result = findDuplicates([a, b]);
    expect(result.duplicates).toHaveLength(0);
    expect(result.mergeRecommendations).toHaveLength(0);
  });

  it('mergeSkills combines trigger phrases and steps', () => {
    const primary = makeSkill({
      triggerPhrases: ['deploy app', 'push code'],
      steps: ['Build', 'Test'],
      pitfalls: ['Watch for timeouts'],
    });
    const secondary = makeSkill({
      triggerPhrases: ['deploy app', 'release code'],
      steps: ['Build', 'Deploy'],
      pitfalls: ['Check permissions'],
    });

    const merged = mergeSkills(primary, secondary);
    expect(merged.triggerPhrases).toContain('deploy app');
    expect(merged.triggerPhrases).toContain('push code');
    expect(merged.triggerPhrases).toContain('release code');
    expect(merged.steps).toContain('Build');
    expect(merged.steps).toContain('Test');
    expect(merged.steps).toContain('Deploy');
    expect(merged.pitfalls).toContain('Watch for timeouts');
    expect(merged.pitfalls).toContain('Check permissions');
  });

  it('mergeSkills keeps the primary skill metadata', () => {
    const primary = makeSkill({
      id: 'primary-id',
      slug: 'primary-skill',
      version: 3,
      status: 'published',
    });
    const secondary = makeSkill({
      id: 'secondary-id',
      slug: 'secondary-skill',
      version: 1,
      status: 'draft',
    });

    const merged = mergeSkills(primary, secondary);
    expect(merged.id).toBe('primary-id');
    expect(merged.slug).toBe('primary-skill');
    expect(merged.status).toBe('published');
    expect(merged.version).toBe(4); // primary version + 1
  });
});

// =====================================================================
// Auto-Improver Tests
// =====================================================================

describe('auto-improver', () => {
  it('generateImprovementPlan recommends unpublish for bad skills', () => {
    const skills = [makeSkill({ slug: 'bad-skill', status: 'published' })];
    const metrics = [
      {
        slug: 'bad-skill',
        totalUses: 6,
        successRate: 0.2,
        averageDurationMs: 1000,
        helpfulRate: 0.1,
        lastUsedAt: new Date().toISOString(),
        trend: 'stable' as const,
        topToolsUsed: [],
      },
    ];

    const plan = generateImprovementPlan(skills, metrics);
    const unpublish = plan.actions.find(
      (a) => a.type === 'unpublish' && a.skillSlug === 'bad-skill',
    );
    expect(unpublish).toBeDefined();
    expect(unpublish?.priority).toBe('high');
  });

  it('generateImprovementPlan recommends refine for declining skills', () => {
    const skills = [makeSkill({ slug: 'declining-skill', status: 'published' })];
    const metrics = [
      {
        slug: 'declining-skill',
        totalUses: 5,
        successRate: 0.6,
        averageDurationMs: 1000,
        helpfulRate: 0.5,
        lastUsedAt: new Date().toISOString(),
        trend: 'declining' as const,
        topToolsUsed: [],
      },
    ];

    const plan = generateImprovementPlan(skills, metrics);
    const refine = plan.actions.find(
      (a) => a.type === 'refine' && a.skillSlug === 'declining-skill',
    );
    expect(refine).toBeDefined();
    expect(refine?.priority).toBe('medium');
  });

  it('generateImprovementPlan recommends promote for good drafts', () => {
    const skills = [makeSkill({ slug: 'good-draft', status: 'draft' })];
    const metrics = [
      {
        slug: 'good-draft',
        totalUses: 5,
        successRate: 0.9,
        averageDurationMs: 800,
        helpfulRate: 0.8,
        lastUsedAt: new Date().toISOString(),
        trend: 'stable' as const,
        topToolsUsed: [],
      },
    ];

    const plan = generateImprovementPlan(skills, metrics);
    const promote = plan.actions.find(
      (a) => a.type === 'promote' && a.skillSlug === 'good-draft',
    );
    expect(promote).toBeDefined();
    expect(promote?.priority).toBe('low');
  });

  it('generateImprovementPlan returns empty for all-good skills', () => {
    const skills = [makeSkill({ slug: 'perfect-skill', status: 'published' })];
    const metrics = [
      {
        slug: 'perfect-skill',
        totalUses: 10,
        successRate: 0.95,
        averageDurationMs: 500,
        helpfulRate: 0.9,
        lastUsedAt: new Date().toISOString(),
        trend: 'stable' as const,
        topToolsUsed: [],
      },
    ];

    const plan = generateImprovementPlan(skills, metrics);
    expect(plan.actions).toHaveLength(0);
  });

  it('detectCompletionEnhanced scores higher with tool success', () => {
    const messages = [
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'I have successfully completed the deployment.' },
    ];

    const withTools = detectCompletionEnhanced(messages, [
      { ok: true, toolName: 'deploy.run' },
      { ok: true, toolName: 'deploy.verify' },
    ]);
    const withoutTools = detectCompletionEnhanced(messages);

    expect(withTools.score).toBeGreaterThan(withoutTools.score);
    expect(withTools.signals).toContain('all-tools-succeeded');
  });

  it('detectCompletionEnhanced scores higher with user acknowledgment', () => {
    const withAck = detectCompletionEnhanced([
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'Done. The app is deployed.' },
      { role: 'user', content: 'thanks, looks great!' },
    ]);
    const withoutAck = detectCompletionEnhanced([
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'Done. The app is deployed.' },
    ]);

    expect(withAck.score).toBeGreaterThan(withoutAck.score);
    expect(withAck.signals.some((s) => s.startsWith('user-ack:'))).toBe(true);
  });

  it('detectCompletionEnhanced scores lower with errors and questions', () => {
    const errorResult = detectCompletionEnhanced([
      { role: 'user', content: 'deploy the app' },
      { role: 'assistant', content: 'There was an error during deployment. What should I do?' },
    ]);

    expect(errorResult.score).toBeLessThan(2);
    expect(errorResult.signals).toContain('error-signal');
    expect(errorResult.signals).toContain('ends-with-question');
    expect(errorResult.completed).toBe(false);
  });

  it('detectCompletionEnhanced returns all signals', () => {
    const result = detectCompletionEnhanced(
      [
        { role: 'user', content: 'fix the bug?' },
        { role: 'assistant', content: 'All done. I have successfully completed the fix. Let me know if you need anything else.' },
        { role: 'user', content: 'perfect, thanks!' },
      ],
      [
        { ok: true, toolName: 'code.edit' },
        { ok: true, toolName: 'test.run' },
      ],
    );

    expect(result.signals.length).toBeGreaterThan(0);
    expect(result.completed).toBe(true);
    expect(result.confidence).toBe('high');
    expect(typeof result.score).toBe('number');
    expect(result.reason).toContain('Score');
  });
});

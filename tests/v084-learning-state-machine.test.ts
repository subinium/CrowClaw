/**
 * v0.8.4 (#185) — Learning loop dashboard coverage.
 *
 * The dashboard exposes a four-state pipeline:
 *
 *     captured → reviewed → published
 *                       ↘ rejected
 *
 * The persisted `StoredSkillDraft.status` is only `draft | published`, so
 * the dashboard endpoint derives the richer "stage" from existing fields
 * (status, ratings, createdAt, updatedAt). These tests pin that mapping
 * down so the loop diagram + status pills don't silently drift the day
 * we change unpublishThreshold or the rating contract.
 */
import { describe, expect, it } from 'vitest';
import {
  ALL_LEARNING_STAGES,
  countLearningStages,
  deriveLearningStage,
  summarizeSkillMetrics,
} from '../packages/learning/src/state-machine.js';
import type { StoredSkillDraft } from '../packages/learning/src/index.js';

const baseDraft: StoredSkillDraft = {
  id: 'draft-test',
  slug: 'test-skill',
  title: 'Test Skill',
  summary: 'summary',
  triggerPhrases: ['do the thing'],
  steps: ['step 1'],
  sourceMessages: 4,
  status: 'draft',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',
  markdown: '# Test',
  version: 1,
  ratings: { helpful: 0, unhelpful: 0 },
};

describe('v0.8.4 #185 — learning state machine', () => {
  it('exposes all four stages', () => {
    expect(ALL_LEARNING_STAGES).toEqual(['captured', 'reviewed', 'published', 'rejected']);
  });

  it('returns "captured" for an untouched fresh draft', () => {
    const stage = deriveLearningStage(baseDraft);
    expect(stage).toBe('captured');
  });

  it('returns "reviewed" once the draft has been refined (updatedAt > createdAt)', () => {
    const refined: StoredSkillDraft = {
      ...baseDraft,
      updatedAt: '2025-01-02T00:00:00.000Z',
    };
    expect(deriveLearningStage(refined)).toBe('reviewed');
  });

  it('returns "reviewed" once the draft has any helpful rating', () => {
    const helpful: StoredSkillDraft = {
      ...baseDraft,
      ratings: { helpful: 1, unhelpful: 0 },
    };
    expect(deriveLearningStage(helpful)).toBe('reviewed');
  });

  it('returns "rejected" when unhelpful ratings cross the default threshold', () => {
    const rejected: StoredSkillDraft = {
      ...baseDraft,
      ratings: { helpful: 0, unhelpful: 3 },
    };
    expect(deriveLearningStage(rejected)).toBe('rejected');
  });

  it('respects a custom rejectionThreshold', () => {
    const draft: StoredSkillDraft = {
      ...baseDraft,
      ratings: { helpful: 0, unhelpful: 2 },
    };
    expect(deriveLearningStage(draft, { rejectionThreshold: 2 })).toBe('rejected');
    expect(deriveLearningStage(draft, { rejectionThreshold: 5 })).toBe('reviewed');
  });

  it('returns "published" regardless of ratings when status === published', () => {
    const pub: StoredSkillDraft = {
      ...baseDraft,
      status: 'published',
      ratings: { helpful: 0, unhelpful: 99 },
    };
    expect(deriveLearningStage(pub)).toBe('published');
  });

  it('aggregates stage counts from a mixed list of drafts', () => {
    const drafts: StoredSkillDraft[] = [
      baseDraft, // captured
      { ...baseDraft, id: 'b', updatedAt: '2025-02-01T00:00:00.000Z' }, // reviewed
      { ...baseDraft, id: 'c', status: 'published' }, // published
      { ...baseDraft, id: 'd', ratings: { helpful: 0, unhelpful: 4 } }, // rejected
      { ...baseDraft, id: 'e', ratings: { helpful: 2, unhelpful: 0 } }, // reviewed
    ];
    const counts = countLearningStages(drafts);
    expect(counts).toEqual({ captured: 1, reviewed: 2, published: 1, rejected: 1 });
  });

  it('summarizeSkillMetrics computes successRate from ratings', () => {
    const draft: StoredSkillDraft = {
      ...baseDraft,
      ratings: { helpful: 3, unhelpful: 1 },
      updatedAt: '2025-01-05T00:00:00.000Z',
    };
    const m = summarizeSkillMetrics(draft);
    expect(m.slug).toBe('test-skill');
    expect(m.stage).toBe('reviewed');
    expect(m.totalRatings).toBe(4);
    expect(m.successRate).toBeCloseTo(0.75, 5);
    expect(m.activations).toBe(4);
    expect(m.lastActivityAt).toBe('2025-01-05T00:00:00.000Z');
  });

  it('summarizeSkillMetrics returns null successRate when there are no ratings', () => {
    const m = summarizeSkillMetrics(baseDraft);
    expect(m.successRate).toBeNull();
    expect(m.totalRatings).toBe(0);
  });

  it('summarizeSkillMetrics last activity falls back to createdAt when no refinement', () => {
    const m = summarizeSkillMetrics(baseDraft);
    expect(m.lastActivityAt).toBe(baseDraft.createdAt);
  });

  it('summarizeSkillMetrics produces a published stage for published drafts', () => {
    const draft: StoredSkillDraft = { ...baseDraft, status: 'published' };
    const m = summarizeSkillMetrics(draft);
    expect(m.stage).toBe('published');
  });
});

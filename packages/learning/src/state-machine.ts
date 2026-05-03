/**
 * Skill draft state-machine helper (v0.8.4 #185).
 *
 * The persisted `StoredSkillDraft.status` is `'draft' | 'published'` —
 * deliberately small so the storage contract stays stable. The dashboard
 * however wants a richer four-stage view of the learning loop:
 *
 *     captured → reviewed → published
 *                       ↘ rejected
 *
 * This module derives that "stage" from existing draft fields without
 * mutating the storage type. The mapping is:
 *
 *   - status === 'published'                                   → `published`
 *   - status === 'draft' AND ratings.unhelpful >= rejectionThreshold (default 3)
 *                                                               → `rejected`
 *   - status === 'draft' AND updatedAt > createdAt (the draft has been
 *     refined since first capture, OR has any ratings recorded)
 *                                                               → `reviewed`
 *   - everything else (newly captured, untouched)               → `captured`
 *
 * Aggregating these stages gives the loop-diagram counts the UI renders.
 */
import type { StoredSkillDraft } from './index.js';

export type LearningStage = 'captured' | 'reviewed' | 'published' | 'rejected';

export const ALL_LEARNING_STAGES: readonly LearningStage[] = [
  'captured',
  'reviewed',
  'published',
  'rejected',
];

export interface LearningStageOptions {
  /**
   * Number of unhelpful ratings before a draft is treated as rejected.
   * Defaults to 3, matching `LearningPipelineOptions.unpublishThreshold`.
   */
  rejectionThreshold?: number;
}

/**
 * Derive the four-stage UI status for a single draft.
 */
export function deriveLearningStage(
  draft: Pick<StoredSkillDraft, 'status' | 'createdAt' | 'updatedAt' | 'ratings'>,
  options: LearningStageOptions = {},
): LearningStage {
  const threshold = options.rejectionThreshold ?? 3;
  if (draft.status === 'published') return 'published';

  const unhelpful = draft.ratings?.unhelpful ?? 0;
  if (unhelpful >= threshold) return 'rejected';

  const helpful = draft.ratings?.helpful ?? 0;
  const wasRefined =
    draft.updatedAt && draft.createdAt && draft.updatedAt !== draft.createdAt;

  if (wasRefined || helpful > 0 || unhelpful > 0) return 'reviewed';
  return 'captured';
}

/**
 * Aggregate counts per stage for the loop diagram.
 */
export function countLearningStages(
  drafts: Array<Pick<StoredSkillDraft, 'status' | 'createdAt' | 'updatedAt' | 'ratings'>>,
  options: LearningStageOptions = {},
): Record<LearningStage, number> {
  const counts: Record<LearningStage, number> = {
    captured: 0,
    reviewed: 0,
    published: 0,
    rejected: 0,
  };
  for (const d of drafts) {
    counts[deriveLearningStage(d, options)] += 1;
  }
  return counts;
}

export interface PerSkillMetricsSummary {
  /** Skill slug (or draft slug for unpublished drafts). */
  slug: string;
  /** Stage in the learning loop. */
  stage: LearningStage;
  /** Total ratings observed (helpful + unhelpful). */
  totalRatings: number;
  /** Fraction of ratings marked helpful, or null if no ratings. */
  successRate: number | null;
  /** Last activity timestamp (max of createdAt / updatedAt). */
  lastActivityAt: string;
  /** Recurrence count from sourceMessages — a rough activation proxy. */
  activations: number;
}

/**
 * Build a per-skill summary row for the metrics panel. Falls back to draft-
 * derived signals when an external `SkillMetricsTracker` isn't available.
 */
export function summarizeSkillMetrics(
  draft: StoredSkillDraft,
  options: LearningStageOptions = {},
): PerSkillMetricsSummary {
  const stage = deriveLearningStage(draft, options);
  const helpful = draft.ratings?.helpful ?? 0;
  const unhelpful = draft.ratings?.unhelpful ?? 0;
  const totalRatings = helpful + unhelpful;
  const successRate = totalRatings === 0 ? null : helpful / totalRatings;
  const lastActivityAt =
    draft.updatedAt && draft.createdAt && draft.updatedAt > draft.createdAt
      ? draft.updatedAt
      : draft.createdAt ?? draft.updatedAt ?? new Date(0).toISOString();
  return {
    slug: draft.slug,
    stage,
    totalRatings,
    successRate,
    lastActivityAt,
    activations: draft.sourceMessages ?? 0,
  };
}

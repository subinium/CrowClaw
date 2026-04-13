/**
 * Skill deduplication: detect similar skills and merge them.
 */
import type { StoredSkillDraft } from './index.js';

export interface DedupResult {
  duplicates: Array<{
    skill1: string;
    skill2: string;
    similarity: number;
    reason: string;
  }>;
  mergeRecommendations: Array<{
    keep: string;
    remove: string;
    reason: string;
  }>;
}

const WEIGHTS = {
  title: 0.3,
  triggers: 0.4,
  steps: 0.2,
  summary: 0.1,
} as const;

const DEFAULT_THRESHOLD = 0.7;

/**
 * Tokenize a string into lowercase words, filtering out short ones.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
}

/**
 * Jaccard similarity: |intersection| / |union|.
 * Returns 0 for empty sets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Calculate similarity between two skills.
 * Weighted combination of title, trigger phrase, step, and summary overlap.
 */
export function skillSimilarity(a: StoredSkillDraft, b: StoredSkillDraft): number {
  const titleSim = jaccardSimilarity(tokenize(a.title), tokenize(b.title));

  // Flatten all trigger phrases into token sets
  const triggersA = a.triggerPhrases.flatMap(tokenize);
  const triggersB = b.triggerPhrases.flatMap(tokenize);
  const triggerSim = jaccardSimilarity(triggersA, triggersB);

  // Flatten all steps into token sets
  const stepsA = a.steps.flatMap(tokenize);
  const stepsB = b.steps.flatMap(tokenize);
  const stepSim = jaccardSimilarity(stepsA, stepsB);

  const summarySim = jaccardSimilarity(tokenize(a.summary), tokenize(b.summary));

  return (
    WEIGHTS.title * titleSim +
    WEIGHTS.triggers * triggerSim +
    WEIGHTS.steps * stepSim +
    WEIGHTS.summary * summarySim
  );
}

/**
 * Pick the "better" skill to keep as primary: prefer published, then higher
 * version, then more trigger phrases, then more recently updated.
 */
function pickPrimary(
  a: StoredSkillDraft,
  b: StoredSkillDraft,
): { keep: StoredSkillDraft; remove: StoredSkillDraft } {
  // Prefer published
  if (a.status === 'published' && b.status !== 'published') return { keep: a, remove: b };
  if (b.status === 'published' && a.status !== 'published') return { keep: b, remove: a };

  // Prefer higher version
  const versionA = a.version ?? 1;
  const versionB = b.version ?? 1;
  if (versionA > versionB) return { keep: a, remove: b };
  if (versionB > versionA) return { keep: b, remove: a };

  // Prefer more trigger phrases
  if (a.triggerPhrases.length > b.triggerPhrases.length) return { keep: a, remove: b };
  if (b.triggerPhrases.length > a.triggerPhrases.length) return { keep: b, remove: a };

  // Prefer more recently updated
  if (a.updatedAt >= b.updatedAt) return { keep: a, remove: b };
  return { keep: b, remove: a };
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Find all duplicate pairs above the given similarity threshold.
 */
export function findDuplicates(
  skills: StoredSkillDraft[],
  threshold = DEFAULT_THRESHOLD,
): DedupResult {
  const duplicates: DedupResult['duplicates'] = [];
  const mergeRecommendations: DedupResult['mergeRecommendations'] = [];

  for (let i = 0; i < skills.length; i++) {
    for (let j = i + 1; j < skills.length; j++) {
      const a = skills[i]!;
      const b = skills[j]!;
      const similarity = skillSimilarity(a, b);

      if (similarity >= threshold) {
        duplicates.push({
          skill1: a.slug,
          skill2: b.slug,
          similarity: Math.round(similarity * 1000) / 1000,
          reason: `Similarity ${(similarity * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}%`,
        });

        const { keep, remove } = pickPrimary(a, b);
        mergeRecommendations.push({
          keep: keep.slug,
          remove: remove.slug,
          reason: keep.status === 'published'
            ? 'Keeping published skill'
            : (keep.version ?? 1) > (remove.version ?? 1)
              ? 'Keeping higher version'
              : 'Keeping skill with more content',
        });
      }
    }
  }

  return { duplicates, mergeRecommendations };
}

/**
 * Merge two skills: keep the primary's metadata, absorb secondary's
 * trigger phrases and steps.
 */
export function mergeSkills(
  primary: StoredSkillDraft,
  secondary: StoredSkillDraft,
): StoredSkillDraft {
  const mergedTriggers = unique([...primary.triggerPhrases, ...secondary.triggerPhrases]);
  const mergedSteps = unique([...primary.steps, ...secondary.steps]);
  const mergedPitfalls = unique([...(primary.pitfalls ?? []), ...(secondary.pitfalls ?? [])]);
  const mergedVerification = unique([
    ...(primary.verificationSteps ?? []),
    ...(secondary.verificationSteps ?? []),
  ]);
  const mergedTools = unique([
    ...(primary.requiredTools ?? []),
    ...(secondary.requiredTools ?? []),
  ]);

  // Use longer summary
  const summary =
    secondary.summary.length > primary.summary.length
      ? secondary.summary
      : primary.summary;

  const primaryRatings = primary.ratings ?? { helpful: 0, unhelpful: 0 };
  const secondaryRatings = secondary.ratings ?? { helpful: 0, unhelpful: 0 };

  return {
    ...primary,
    summary,
    triggerPhrases: mergedTriggers,
    steps: mergedSteps,
    pitfalls: mergedPitfalls,
    verificationSteps: mergedVerification,
    requiredTools: mergedTools,
    sourceMessages: primary.sourceMessages + secondary.sourceMessages,
    version: (primary.version ?? 1) + 1,
    ratings: {
      helpful: primaryRatings.helpful + secondaryRatings.helpful,
      unhelpful: primaryRatings.unhelpful + secondaryRatings.unhelpful,
    },
    updatedAt: new Date().toISOString(),
  };
}

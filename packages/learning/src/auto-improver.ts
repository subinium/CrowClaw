/**
 * Rating-driven automatic skill improvement pipeline.
 * Analyzes skill metrics and generates improvement plans.
 */
import type { StoredSkillDraft } from './index.js';
import type { SkillMetrics } from './skill-metrics.js';
import { findDuplicates } from './skill-dedup.js';

export interface ImprovementAction {
  type: 'refine' | 'merge' | 'unpublish' | 'promote';
  skillSlug: string;
  reason: string;
  priority: 'low' | 'medium' | 'high';
}

export interface ImprovementPlan {
  actions: ImprovementAction[];
  generatedAt: string;
}

const UNPUBLISH_RATE_THRESHOLD = 0.3;
const UNPUBLISH_MIN_USES = 5;
const REFINE_MIN_USES = 3;
const PROMOTE_RATE_THRESHOLD = 0.7;
const PROMOTE_MIN_USES = 3;

/**
 * Analyze skills and metrics to generate an improvement plan.
 *
 * Rules:
 * - Unpublish: helpfulRate < 30% and totalUses >= 5
 * - Refine: declining trend and totalUses >= 3
 * - Merge: duplicates found with similarity > 0.7
 * - Promote: draft skills with helpfulRate > 70% and totalUses >= 3
 */
export function generateImprovementPlan(
  skills: StoredSkillDraft[],
  metrics: SkillMetrics[],
): ImprovementPlan {
  const actions: ImprovementAction[] = [];
  const metricsMap = new Map(metrics.map((m) => [m.slug, m]));

  for (const skill of skills) {
    const m = metricsMap.get(skill.slug);
    if (!m) continue;

    // Unpublish: low helpful rate with enough data
    if (
      skill.status === 'published' &&
      m.helpfulRate < UNPUBLISH_RATE_THRESHOLD &&
      m.totalUses >= UNPUBLISH_MIN_USES
    ) {
      actions.push({
        type: 'unpublish',
        skillSlug: skill.slug,
        reason: `Helpful rate ${(m.helpfulRate * 100).toFixed(0)}% is below ${UNPUBLISH_RATE_THRESHOLD * 100}% threshold with ${m.totalUses} uses`,
        priority: 'high',
      });
      continue; // Don't also suggest refine for same skill
    }

    // Refine: declining trend with enough data
    if (m.trend === 'declining' && m.totalUses >= REFINE_MIN_USES) {
      actions.push({
        type: 'refine',
        skillSlug: skill.slug,
        reason: `Declining success trend over ${m.totalUses} uses`,
        priority: 'medium',
      });
    }

    // Promote: good drafts
    if (
      skill.status === 'draft' &&
      m.helpfulRate > PROMOTE_RATE_THRESHOLD &&
      m.totalUses >= PROMOTE_MIN_USES
    ) {
      actions.push({
        type: 'promote',
        skillSlug: skill.slug,
        reason: `Draft with ${(m.helpfulRate * 100).toFixed(0)}% helpful rate across ${m.totalUses} uses`,
        priority: 'low',
      });
    }
  }

  // Merge: check for duplicates
  const dedupResult = findDuplicates(skills);
  for (const rec of dedupResult.mergeRecommendations) {
    actions.push({
      type: 'merge',
      skillSlug: rec.remove,
      reason: `Duplicate of ${rec.keep}: ${rec.reason}`,
      priority: 'medium',
    });
  }

  return {
    actions,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Enhanced completion detection with trajectory context.
 * Extends the basic detectTaskCompletion with additional signals from
 * tool results and message patterns.
 */
export function detectCompletionEnhanced(
  messages: Array<{ role: string; content: string }>,
  toolResults?: Array<{ ok: boolean; toolName: string }>,
): {
  completed: boolean;
  confidence: 'low' | 'medium' | 'high';
  reason: string;
  signals: string[];
  score: number;
} {
  let score = 0;
  const signals: string[] = [];

  const assistantMessages = messages.filter((m) => m.role === 'assistant');
  const userMessages = messages.filter((m) => m.role === 'user');
  const final = assistantMessages.at(-1)?.content.toLowerCase() ?? '';
  const lastUser = userMessages.at(-1)?.content.toLowerCase() ?? '';

  // --- Strong completion signals (+3 each) ---
  const strongPatterns = [
    'task complete',
    'successfully completed',
    "i've finished",
    'all done',
    "here's the result",
    'the changes have been applied',
  ];
  for (const pattern of strongPatterns) {
    if (final.includes(pattern)) {
      score += 3;
      signals.push(`strong-pattern: ${pattern}`);
    }
  }

  // --- Medium signals (+2 each) ---
  const mediumPatterns = ['done', 'completed', 'finished', 'here you go', 'let me know if'];
  for (const pattern of mediumPatterns) {
    if (final.includes(pattern)) {
      score += 2;
      signals.push(`medium-pattern: ${pattern}`);
    }
  }

  // --- Tool success rate (+3 if all succeeded) ---
  if (toolResults && toolResults.length > 0) {
    const allSucceeded = toolResults.every((r) => r.ok);
    const failures = toolResults.filter((r) => !r.ok);
    const successes = toolResults.filter((r) => r.ok);

    if (allSucceeded) {
      score += 3;
      signals.push('all-tools-succeeded');
    }

    // Error recovery: had errors but also had later successes (+2)
    if (failures.length > 0 && successes.length > failures.length) {
      score += 2;
      signals.push('error-recovery');
    }
  }

  // --- Final message length ---
  if (final.length < 20) {
    score -= 1;
    signals.push('very-short-response');
  } else if (final.length >= 50 && final.length <= 500) {
    score += 1;
    signals.push('medium-length-response');
  }

  // --- User acknowledgment patterns (+3) ---
  const ackPatterns = ['thanks', 'thank you', 'great', 'perfect', 'awesome', 'looks good', 'lgtm'];
  for (const pattern of ackPatterns) {
    if (lastUser.includes(pattern)) {
      score += 3;
      signals.push(`user-ack: ${pattern}`);
      break; // Only count once
    }
  }

  // --- Question-answer completeness (+2) ---
  const userQuestions = userMessages.filter(
    (m) => m.content.includes('?'),
  ).length;
  const assistantAnswers = assistantMessages.filter(
    (m) => !m.content.trim().endsWith('?'),
  ).length;
  if (userQuestions > 0 && assistantAnswers >= userQuestions) {
    score += 2;
    signals.push('questions-answered');
  }

  // --- Negative signals ---
  if (final.includes('?') && !final.includes('let me know')) {
    score -= 2;
    signals.push('ends-with-question');
  }
  if (final.includes('error') || final.includes('failed')) {
    score -= 2;
    signals.push('error-signal');
  }
  if (final.includes('working on') || final.includes('in progress')) {
    score -= 2;
    signals.push('in-progress');
  }

  const confidence = score >= 5 ? 'high' : score >= 2 ? 'medium' : 'low';

  return {
    completed: score >= 2,
    confidence,
    reason: `Score ${score}: ${signals.join(', ')}`,
    signals,
    score,
  };
}

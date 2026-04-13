/**
 * Per-skill performance tracking over time.
 * Records usage events and computes aggregate metrics including trend detection.
 */

export interface SkillUsageRecord {
  skillSlug: string;
  sessionId: string;
  usedAt: string;
  completionConfidence: 'low' | 'medium' | 'high';
  durationMs: number;
  toolsUsed: string[];
  userRating?: 'helpful' | 'unhelpful';
}

export interface SkillMetrics {
  slug: string;
  totalUses: number;
  /** Fraction of uses with high or medium completion confidence. */
  successRate: number;
  averageDurationMs: number;
  /** Fraction of rated uses marked helpful. NaN if no ratings. */
  helpfulRate: number;
  lastUsedAt: string | null;
  trend: 'improving' | 'stable' | 'declining' | 'insufficient-data';
  /** Most frequently used tools across all usages. */
  topToolsUsed: string[];
}

const TREND_WINDOW = 5;
const TREND_THRESHOLD = 0.15;

function isSuccess(confidence: 'low' | 'medium' | 'high'): boolean {
  return confidence === 'high' || confidence === 'medium';
}

function computeSuccessRate(records: SkillUsageRecord[]): number {
  if (records.length === 0) return 0;
  const successes = records.filter((r) => isSuccess(r.completionConfidence)).length;
  return successes / records.length;
}

function computeHelpfulRate(records: SkillUsageRecord[]): number {
  const rated = records.filter((r) => r.userRating !== undefined);
  if (rated.length === 0) return 0;
  const helpful = rated.filter((r) => r.userRating === 'helpful').length;
  return helpful / rated.length;
}

function computeAverageDuration(records: SkillUsageRecord[]): number {
  if (records.length === 0) return 0;
  const total = records.reduce((sum, r) => sum + r.durationMs, 0);
  return Math.round(total / records.length);
}

function computeTopTools(records: SkillUsageRecord[], limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const record of records) {
    for (const tool of record.toolsUsed) {
      counts.set(tool, (counts.get(tool) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tool]) => tool);
}

/**
 * Compare success rate of the most recent window vs the previous window.
 * Returns 'insufficient-data' if fewer than TREND_WINDOW * 2 records exist.
 */
function computeTrend(records: SkillUsageRecord[]): SkillMetrics['trend'] {
  if (records.length < TREND_WINDOW * 2) return 'insufficient-data';

  const sorted = [...records].sort(
    (a, b) => new Date(a.usedAt).getTime() - new Date(b.usedAt).getTime(),
  );

  const recentWindow = sorted.slice(-TREND_WINDOW);
  const previousWindow = sorted.slice(-TREND_WINDOW * 2, -TREND_WINDOW);

  const recentRate = computeSuccessRate(recentWindow);
  const previousRate = computeSuccessRate(previousWindow);
  const delta = recentRate - previousRate;

  if (delta > TREND_THRESHOLD) return 'improving';
  if (delta < -TREND_THRESHOLD) return 'declining';
  return 'stable';
}

function buildMetrics(slug: string, records: SkillUsageRecord[]): SkillMetrics {
  if (records.length === 0) {
    return {
      slug,
      totalUses: 0,
      successRate: 0,
      averageDurationMs: 0,
      helpfulRate: 0,
      lastUsedAt: null,
      trend: 'insufficient-data',
      topToolsUsed: [],
    };
  }

  const sorted = [...records].sort(
    (a, b) => new Date(a.usedAt).getTime() - new Date(b.usedAt).getTime(),
  );

  return {
    slug,
    totalUses: records.length,
    successRate: computeSuccessRate(records),
    averageDurationMs: computeAverageDuration(records),
    helpfulRate: computeHelpfulRate(records),
    lastUsedAt: sorted[sorted.length - 1]?.usedAt ?? null,
    trend: computeTrend(records),
    topToolsUsed: computeTopTools(records),
  };
}

const MAX_RECORDS_PER_SKILL = 500;

export class SkillMetricsTracker {
  private records = new Map<string, SkillUsageRecord[]>();

  record(usage: SkillUsageRecord): void {
    const existing = this.records.get(usage.skillSlug) ?? [];
    existing.push(usage);
    if (existing.length > MAX_RECORDS_PER_SKILL) {
      existing.splice(0, existing.length - MAX_RECORDS_PER_SKILL);
    }
    this.records.set(usage.skillSlug, existing);
  }

  getMetrics(slug: string): SkillMetrics {
    const records = this.records.get(slug) ?? [];
    return buildMetrics(slug, records);
  }

  getAllMetrics(): SkillMetrics[] {
    return [...this.records.entries()].map(([slug, records]) =>
      buildMetrics(slug, records),
    );
  }

  /**
   * Identify skills that need improvement: low success rate or declining trend.
   * @param threshold Success rate below which a skill is flagged. Default 0.5.
   */
  getImprovementCandidates(threshold = 0.5): SkillMetrics[] {
    return this.getAllMetrics().filter(
      (m) =>
        m.totalUses > 0 &&
        (m.successRate < threshold || m.trend === 'declining'),
    );
  }

  /**
   * Return top-performing skills sorted by success rate descending.
   * @param limit Maximum number of results. Default 5.
   */
  getTopPerformers(limit = 5): SkillMetrics[] {
    return this.getAllMetrics()
      .filter((m) => m.totalUses > 0)
      .sort((a, b) => b.successRate - a.successRate || b.totalUses - a.totalUses)
      .slice(0, limit);
  }
}

import type { TrajectoryEntry } from './trajectory.js';

export interface TrajectoryScore {
  /** 0-1: Did the task complete without errors? */
  taskCompletion: number;
  /** 0-1: How few iterations were needed relative to the maximum? */
  efficiency: number;
  /** 0-1: Ratio of successful tool calls to total tool calls. */
  toolAccuracy: number;
  /** 0-1: If errors occurred, how well did recovery go? */
  recoveryQuality: number;
  /** Weighted average of all sub-scores. */
  overall: number;
}

const ERROR_INDICATORS = [
  'error',
  'failed',
  'exception',
  'traceback',
  'fatal',
  'panic',
  'unhandled',
  'crash',
];

const PARTIAL_INDICATORS = [
  'partial',
  'incomplete',
  'could not finish',
  'timed out',
  'timeout',
  'not fully',
];

const WEIGHTS = {
  taskCompletion: 0.3,
  efficiency: 0.2,
  toolAccuracy: 0.3,
  recoveryQuality: 0.2,
} as const;

/**
 * Heuristic scoring of a trajectory. No LLM involved -- uses structural
 * signals from the trajectory data to produce a 0-1 score across four axes.
 */
export function scoreTrajectory(
  trajectory: TrajectoryEntry,
  maxIterations = 20,
): TrajectoryScore {
  const taskCompletion = computeTaskCompletion(trajectory);
  const efficiency = computeEfficiency(trajectory, maxIterations);
  const toolAccuracy = computeToolAccuracy(trajectory);
  const recoveryQuality = computeRecoveryQuality(trajectory);

  const overall =
    WEIGHTS.taskCompletion * taskCompletion +
    WEIGHTS.efficiency * efficiency +
    WEIGHTS.toolAccuracy * toolAccuracy +
    WEIGHTS.recoveryQuality * recoveryQuality;

  return {
    taskCompletion,
    efficiency,
    toolAccuracy,
    recoveryQuality,
    overall: Math.round(overall * 1000) / 1000,
  };
}

/**
 * 1.0 if the final response has no error indicators and metadata.ok is true.
 * 0.5 if partial indicators are present.
 * 0.0 if error indicators are found or metadata.ok is false.
 */
function computeTaskCompletion(trajectory: TrajectoryEntry): number {
  if (!trajectory.metadata.ok) return 0;

  const responseLower = trajectory.response.toLowerCase();

  for (const indicator of ERROR_INDICATORS) {
    if (responseLower.includes(indicator)) return 0;
  }

  for (const indicator of PARTIAL_INDICATORS) {
    if (responseLower.includes(indicator)) return 0.5;
  }

  return 1;
}

/**
 * 1 - (actualIterations / maxIterations), clamped to [0, 1].
 * Fewer iterations = more efficient.
 */
function computeEfficiency(
  trajectory: TrajectoryEntry,
  maxIterations: number,
): number {
  if (maxIterations <= 0) return 1;
  const actualIterations = trajectory.turns.length;
  const ratio = actualIterations / maxIterations;
  return Math.max(0, Math.min(1, 1 - ratio));
}

/**
 * successfulToolCalls / totalToolCalls.
 * Returns 1 if no tool calls were made (no tools to get wrong).
 */
function computeToolAccuracy(trajectory: TrajectoryEntry): number {
  const totalCalls = trajectory.toolUsage.reduce((sum, t) => sum + t.count, 0);
  if (totalCalls === 0) return 1;

  const successfulCalls = trajectory.toolUsage.reduce(
    (sum, t) => sum + t.successCount,
    0,
  );
  return successfulCalls / totalCalls;
}

/**
 * If errors occurred during tool calls, check whether subsequent calls succeeded.
 * recoveryQuality = recoveredErrors / totalErrors.
 * Returns 1 if no errors occurred (nothing to recover from).
 *
 * "Recovered" is estimated by: if a tool had failures AND also had successes,
 * those successes after failures count as recoveries.
 */
function computeRecoveryQuality(trajectory: TrajectoryEntry): number {
  const totalFailures = trajectory.toolUsage.reduce(
    (sum, t) => sum + t.failureCount,
    0,
  );

  if (totalFailures === 0) return 1;

  // For each tool with failures, count the successes as recovered attempts
  let recoveredCount = 0;
  for (const tool of trajectory.toolUsage) {
    if (tool.failureCount > 0 && tool.successCount > 0) {
      // Successes on a tool that also had failures indicate recovery
      recoveredCount += Math.min(tool.successCount, tool.failureCount);
    }
  }

  return Math.min(1, recoveredCount / totalFailures);
}

import type { TrajectoryEntry, TrajectoryTurn } from './trajectory.js';
import { scoreTrajectory, type TrajectoryScore } from './trajectory-scorer.js';

/**
 * Export a DPO (Direct Preference Optimization) training pair.
 * Takes a preferred and rejected trajectory and returns their turns
 * formatted for DPO training.
 */
export function exportDPO(
  preferred: TrajectoryEntry,
  rejected: TrajectoryEntry,
): { chosen: TrajectoryTurn[]; rejected: TrajectoryTurn[] } {
  return {
    chosen: preferred.turns,
    rejected: rejected.turns,
  };
}

/**
 * Export trajectories as SFT (Supervised Fine-Tuning) data.
 * Optionally filter by minimum score before exporting.
 * Returns an array of turn sequences, one per qualifying trajectory.
 */
export function exportSFT(
  trajectories: TrajectoryEntry[],
  minScore?: number,
): TrajectoryTurn[][] {
  const filtered =
    minScore !== undefined
      ? filterByScore(trajectories, minScore)
      : trajectories;

  return filtered.map((t) => t.turns);
}

/**
 * Filter trajectories to only those meeting a minimum overall score.
 */
export function filterByScore(
  trajectories: TrajectoryEntry[],
  minScore: number,
): TrajectoryEntry[] {
  return trajectories.filter((t) => {
    const score = scoreTrajectory(t);
    return score.overall >= minScore;
  });
}

/**
 * Rank trajectories by their overall score, highest first.
 * Returns each trajectory paired with its computed score.
 */
export function rankByScore(
  trajectories: TrajectoryEntry[],
): Array<{ trajectory: TrajectoryEntry; score: TrajectoryScore }> {
  const scored = trajectories.map((trajectory) => ({
    trajectory,
    score: scoreTrajectory(trajectory),
  }));

  scored.sort((a, b) => b.score.overall - a.score.overall);

  return scored;
}

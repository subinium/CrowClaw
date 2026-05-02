import type { TrajectoryEntry, TrajectoryTurn } from './trajectory.js';

export type CompressionStrategy = 'tool-results-only' | 'key-turns' | 'summary';

export interface CompressedTrajectory extends TrajectoryEntry {
  compressionStrategy: CompressionStrategy;
  originalTurnCount: number;
  compressedTurnCount: number;
}

/**
 * Compress a trajectory using the specified strategy.
 *
 * - `tool-results-only`: Keep tool call inputs + results, drop LLM reasoning turns.
 * - `key-turns`: Keep user messages, final assistant message, and turns where
 *   the tool strategy changed (different tool from previous tool turn).
 * - `summary`: Produce a single-turn summary by concatenating key outcomes.
 */
export function compressTrajectory(
  trajectory: TrajectoryEntry,
  strategy: CompressionStrategy,
): CompressedTrajectory {
  const originalTurnCount = trajectory.turns.length;

  let compressedTurns: TrajectoryTurn[];

  switch (strategy) {
    case 'tool-results-only':
      compressedTurns = compressToolResultsOnly(trajectory.turns);
      break;
    case 'key-turns':
      compressedTurns = compressKeyTurns(trajectory.turns);
      break;
    case 'summary':
      compressedTurns = compressSummary(trajectory);
      break;
  }

  return {
    ...trajectory,
    turns: compressedTurns,
    compressionStrategy: strategy,
    originalTurnCount,
    compressedTurnCount: compressedTurns.length,
  };
}

/**
 * Keep only turns that have a toolName (tool call inputs and results).
 * Drops pure LLM reasoning turns (assistant messages without tool involvement).
 */
function compressToolResultsOnly(turns: TrajectoryTurn[]): TrajectoryTurn[] {
  return turns.filter((turn) => turn.toolName !== undefined);
}

/**
 * Keep user messages, the final assistant message, and turns where the tool
 * changed from the previous tool turn (indicating a strategy shift).
 */
function compressKeyTurns(turns: TrajectoryTurn[]): TrajectoryTurn[] {
  if (turns.length === 0) return [];

  const kept: TrajectoryTurn[] = [];
  let lastToolName: string | undefined;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    if (!turn) {
      continue;
    }

    // Always keep user messages
    if (turn.role === 'user') {
      kept.push(turn);
      continue;
    }

    // Keep turns where tool strategy changed
    if (turn.toolName !== undefined) {
      if (turn.toolName !== lastToolName) {
        kept.push(turn);
      }
      lastToolName = turn.toolName;
      continue;
    }

    // Keep the final assistant message
    if (i === turns.length - 1 && turn.role === 'assistant') {
      kept.push(turn);
    }
  }

  return kept;
}

/**
 * Produce a single-turn summary by concatenating key outcomes from tool usage
 * and the final response. No LLM involved -- purely mechanical.
 */
function compressSummary(trajectory: TrajectoryEntry): TrajectoryTurn[] {
  const toolSummaries = trajectory.toolUsage.map((t) => {
    const total = t.count;
    const successes = t.successCount;
    const failures = t.failureCount;
    return `${t.toolName}: ${successes}/${total} succeeded${failures > 0 ? `, ${failures} failed` : ''}`;
  });

  const parts: string[] = [];

  if (trajectory.prompt) {
    parts.push(`Task: ${trajectory.prompt}`);
  }

  if (toolSummaries.length > 0) {
    parts.push(`Tools: ${toolSummaries.join('; ')}`);
  }

  parts.push(`Outcome: ${trajectory.metadata.ok ? 'success' : 'failure'}`);

  if (trajectory.response) {
    const truncated =
      trajectory.response.length > 200
        ? trajectory.response.slice(0, 200) + '...'
        : trajectory.response;
    parts.push(`Response: ${truncated}`);
  }

  return [
    {
      role: 'summary',
      content: parts.join('\n'),
      timestamp: new Date().toISOString(),
    },
  ];
}

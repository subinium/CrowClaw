import { describe, it, expect } from 'vitest';
import type { TrajectoryEntry, TrajectoryTurn, TrajectoryToolUsage } from '../packages/learning/src/trajectory.js';
import {
  compressTrajectory,
  type CompressionStrategy,
  type CompressedTrajectory,
} from '../packages/learning/src/trajectory-compressor.js';
import {
  scoreTrajectory,
  type TrajectoryScore,
} from '../packages/learning/src/trajectory-scorer.js';
import {
  exportDPO,
  exportSFT,
  filterByScore,
  rankByScore,
} from '../packages/learning/src/rl-export.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeTrajectory(overrides: Partial<TrajectoryEntry> = {}): TrajectoryEntry {
  return {
    id: 'test-1',
    prompt: 'write a hello world script',
    response: 'Done. The script has been created.',
    turns: [
      { role: 'user', content: 'write a hello world script', timestamp: '2026-01-01T00:00:00Z' },
      { role: 'assistant', content: 'Let me create that for you.', timestamp: '2026-01-01T00:00:01Z' },
      { role: 'assistant', content: 'Writing file...', toolName: 'file.write', timestamp: '2026-01-01T00:00:02Z' },
      { role: 'assistant', content: 'Verifying...', toolName: 'shell.exec', timestamp: '2026-01-01T00:00:03Z' },
      { role: 'assistant', content: 'Done. The script has been created.', timestamp: '2026-01-01T00:00:04Z' },
    ],
    toolUsage: [
      { toolName: 'file.write', count: 1, successCount: 1, failureCount: 0 },
      { toolName: 'shell.exec', count: 1, successCount: 1, failureCount: 0 },
    ],
    metadata: {
      sessionId: 'sess-1',
      durationMs: 4000,
      ok: true,
    },
    ...overrides,
  };
}

function makeFailedTrajectory(): TrajectoryEntry {
  return makeTrajectory({
    id: 'test-failed',
    response: 'Error: could not complete the task',
    metadata: { sessionId: 'sess-2', durationMs: 8000, ok: false, error: 'timeout' },
    toolUsage: [
      { toolName: 'shell.exec', count: 3, successCount: 1, failureCount: 2 },
    ],
  });
}

function makePartialTrajectory(): TrajectoryEntry {
  return makeTrajectory({
    id: 'test-partial',
    response: 'The task is partial and incomplete, but some steps succeeded.',
    metadata: { sessionId: 'sess-3', durationMs: 6000, ok: true },
    toolUsage: [
      { toolName: 'file.write', count: 2, successCount: 2, failureCount: 0 },
      { toolName: 'shell.exec', count: 2, successCount: 1, failureCount: 1 },
    ],
  });
}

function makeRecoveryTrajectory(): TrajectoryEntry {
  return makeTrajectory({
    id: 'test-recovery',
    response: 'Task completed after retrying the failed steps.',
    toolUsage: [
      { toolName: 'shell.exec', count: 4, successCount: 2, failureCount: 2 },
      { toolName: 'file.write', count: 1, successCount: 1, failureCount: 0 },
    ],
    metadata: { sessionId: 'sess-4', durationMs: 10000, ok: true },
  });
}

// ─── Compression Tests ─────────────────────────────────────────────

describe('trajectory-compressor', () => {
  describe('tool-results-only', () => {
    it('keeps only turns with toolName', () => {
      const trajectory = makeTrajectory();
      const result = compressTrajectory(trajectory, 'tool-results-only');

      expect(result.compressionStrategy).toBe('tool-results-only');
      expect(result.originalTurnCount).toBe(5);
      expect(result.compressedTurnCount).toBe(2);
      expect(result.turns.every((t) => t.toolName !== undefined)).toBe(true);
    });

    it('returns empty turns when no tool calls exist', () => {
      const trajectory = makeTrajectory({
        turns: [
          { role: 'user', content: 'hello', timestamp: '2026-01-01T00:00:00Z' },
          { role: 'assistant', content: 'hi', timestamp: '2026-01-01T00:00:01Z' },
        ],
      });
      const result = compressTrajectory(trajectory, 'tool-results-only');

      expect(result.compressedTurnCount).toBe(0);
      expect(result.originalTurnCount).toBe(2);
    });
  });

  describe('key-turns', () => {
    it('keeps user messages, final assistant, and tool-strategy changes', () => {
      const trajectory = makeTrajectory();
      const result = compressTrajectory(trajectory, 'key-turns');

      expect(result.compressionStrategy).toBe('key-turns');
      // user message, file.write (first tool), shell.exec (different tool), final assistant
      expect(result.compressedTurnCount).toBe(4);
      expect(result.turns[0].role).toBe('user');
      expect(result.turns[result.turns.length - 1].role).toBe('assistant');
    });

    it('handles empty turns', () => {
      const trajectory = makeTrajectory({ turns: [] });
      const result = compressTrajectory(trajectory, 'key-turns');

      expect(result.compressedTurnCount).toBe(0);
    });

    it('deduplicates consecutive same-tool turns', () => {
      const trajectory = makeTrajectory({
        turns: [
          { role: 'user', content: 'go', timestamp: '2026-01-01T00:00:00Z' },
          { role: 'assistant', content: 'a', toolName: 'shell.exec', timestamp: '2026-01-01T00:00:01Z' },
          { role: 'assistant', content: 'b', toolName: 'shell.exec', timestamp: '2026-01-01T00:00:02Z' },
          { role: 'assistant', content: 'c', toolName: 'shell.exec', timestamp: '2026-01-01T00:00:03Z' },
          { role: 'assistant', content: 'done', timestamp: '2026-01-01T00:00:04Z' },
        ],
      });
      const result = compressTrajectory(trajectory, 'key-turns');

      // user, first shell.exec (tool intro), final assistant
      expect(result.compressedTurnCount).toBe(3);
    });
  });

  describe('summary', () => {
    it('produces a single summary turn', () => {
      const trajectory = makeTrajectory();
      const result = compressTrajectory(trajectory, 'summary');

      expect(result.compressionStrategy).toBe('summary');
      expect(result.compressedTurnCount).toBe(1);
      expect(result.turns[0].role).toBe('summary');
      expect(result.turns[0].content).toContain('Task:');
      expect(result.turns[0].content).toContain('Tools:');
      expect(result.turns[0].content).toContain('Outcome: success');
    });

    it('shows failure outcome for failed trajectories', () => {
      const trajectory = makeFailedTrajectory();
      const result = compressTrajectory(trajectory, 'summary');

      expect(result.turns[0].content).toContain('Outcome: failure');
    });

    it('truncates long responses in summary', () => {
      const trajectory = makeTrajectory({
        response: 'x'.repeat(300),
      });
      const result = compressTrajectory(trajectory, 'summary');

      expect(result.turns[0].content).toContain('...');
    });
  });

  it('preserves original trajectory fields', () => {
    const trajectory = makeTrajectory();
    const result = compressTrajectory(trajectory, 'tool-results-only');

    expect(result.id).toBe(trajectory.id);
    expect(result.prompt).toBe(trajectory.prompt);
    expect(result.response).toBe(trajectory.response);
    expect(result.toolUsage).toEqual(trajectory.toolUsage);
    expect(result.metadata).toEqual(trajectory.metadata);
  });
});

// ─── Scorer Tests ──────────────────────────────────────────────────

describe('trajectory-scorer', () => {
  it('scores a successful trajectory highly', () => {
    const trajectory = makeTrajectory();
    const score = scoreTrajectory(trajectory);

    expect(score.taskCompletion).toBe(1);
    expect(score.toolAccuracy).toBe(1);
    expect(score.recoveryQuality).toBe(1);
    expect(score.overall).toBeGreaterThan(0.7);
  });

  it('scores a failed trajectory with 0 taskCompletion', () => {
    const trajectory = makeFailedTrajectory();
    const score = scoreTrajectory(trajectory);

    expect(score.taskCompletion).toBe(0);
    expect(score.overall).toBeLessThan(0.5);
  });

  it('scores partial completion at 0.5', () => {
    const trajectory = makePartialTrajectory();
    const score = scoreTrajectory(trajectory);

    expect(score.taskCompletion).toBe(0.5);
  });

  it('computes efficiency based on iterations vs max', () => {
    const trajectory = makeTrajectory(); // 5 turns
    const score = scoreTrajectory(trajectory, 10);

    // efficiency = 1 - (5/10) = 0.5
    expect(score.efficiency).toBe(0.5);
  });

  it('clamps efficiency to 0 when turns exceed max', () => {
    const trajectory = makeTrajectory(); // 5 turns
    const score = scoreTrajectory(trajectory, 3);

    expect(score.efficiency).toBe(0);
  });

  it('computes tool accuracy as success ratio', () => {
    const trajectory = makeTrajectory({
      toolUsage: [
        { toolName: 'shell.exec', count: 4, successCount: 3, failureCount: 1 },
      ],
    });
    const score = scoreTrajectory(trajectory);

    expect(score.toolAccuracy).toBe(0.75);
  });

  it('returns 1 for toolAccuracy when no tools used', () => {
    const trajectory = makeTrajectory({ toolUsage: [] });
    const score = scoreTrajectory(trajectory);

    expect(score.toolAccuracy).toBe(1);
  });

  it('computes recovery quality from recovered errors', () => {
    const trajectory = makeRecoveryTrajectory();
    const score = scoreTrajectory(trajectory);

    // shell.exec: 2 failures, 2 successes -> recovered 2/2 = 1.0
    expect(score.recoveryQuality).toBe(1);
  });

  it('returns 1 for recoveryQuality when no failures', () => {
    const trajectory = makeTrajectory();
    const score = scoreTrajectory(trajectory);

    expect(score.recoveryQuality).toBe(1);
  });

  it('returns 0 for recoveryQuality when all failures unrecovered', () => {
    const trajectory = makeTrajectory({
      toolUsage: [
        { toolName: 'shell.exec', count: 3, successCount: 0, failureCount: 3 },
      ],
    });
    const score = scoreTrajectory(trajectory);

    expect(score.recoveryQuality).toBe(0);
  });

  it('overall is weighted average of sub-scores', () => {
    const trajectory = makeTrajectory();
    const score = scoreTrajectory(trajectory, 20);

    const expected =
      0.3 * score.taskCompletion +
      0.2 * score.efficiency +
      0.3 * score.toolAccuracy +
      0.2 * score.recoveryQuality;

    expect(score.overall).toBeCloseTo(expected, 3);
  });
});

// ─── RL Export Tests ────────────────────────────────────────────────

describe('rl-export', () => {
  describe('exportDPO', () => {
    it('returns chosen and rejected turn sequences', () => {
      const preferred = makeTrajectory({ id: 'good' });
      const rejected = makeFailedTrajectory();

      const result = exportDPO(preferred, rejected);

      expect(result.chosen).toEqual(preferred.turns);
      expect(result.rejected).toEqual(rejected.turns);
    });

    it('handles trajectories with empty turns', () => {
      const preferred = makeTrajectory({ turns: [] });
      const rejected = makeTrajectory({ turns: [] });

      const result = exportDPO(preferred, rejected);

      expect(result.chosen).toEqual([]);
      expect(result.rejected).toEqual([]);
    });
  });

  describe('exportSFT', () => {
    it('returns turn sequences for all trajectories without minScore', () => {
      const trajectories = [makeTrajectory(), makeFailedTrajectory()];
      const result = exportSFT(trajectories);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual(trajectories[0].turns);
      expect(result[1]).toEqual(trajectories[1].turns);
    });

    it('filters by minScore when provided', () => {
      const good = makeTrajectory();
      const bad = makeFailedTrajectory();
      const result = exportSFT([good, bad], 0.7);

      // Only the good trajectory should pass the filter
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual(good.turns);
    });

    it('returns empty when no trajectories meet minScore', () => {
      const bad = makeFailedTrajectory();
      const result = exportSFT([bad], 0.99);

      expect(result).toHaveLength(0);
    });
  });

  describe('filterByScore', () => {
    it('filters trajectories by minimum overall score', () => {
      const good = makeTrajectory();
      const bad = makeFailedTrajectory();

      const result = filterByScore([good, bad], 0.5);

      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('test-1');
    });

    it('returns all when threshold is 0', () => {
      const trajectories = [makeTrajectory(), makeFailedTrajectory()];
      const result = filterByScore(trajectories, 0);

      expect(result).toHaveLength(2);
    });

    it('returns empty for unreachable threshold', () => {
      const trajectories = [makeTrajectory()];
      const result = filterByScore(trajectories, 1.1);

      expect(result).toHaveLength(0);
    });
  });

  describe('rankByScore', () => {
    it('ranks trajectories by overall score descending', () => {
      const good = makeTrajectory();
      const bad = makeFailedTrajectory();
      const partial = makePartialTrajectory();

      const result = rankByScore([bad, partial, good]);

      expect(result[0].trajectory.id).toBe('test-1'); // good
      expect(result[result.length - 1].trajectory.id).toBe('test-failed'); // bad
      expect(result[0].score.overall).toBeGreaterThanOrEqual(result[1].score.overall);
      expect(result[1].score.overall).toBeGreaterThanOrEqual(result[2].score.overall);
    });

    it('includes score for each trajectory', () => {
      const trajectories = [makeTrajectory()];
      const result = rankByScore(trajectories);

      expect(result[0].score).toHaveProperty('taskCompletion');
      expect(result[0].score).toHaveProperty('efficiency');
      expect(result[0].score).toHaveProperty('toolAccuracy');
      expect(result[0].score).toHaveProperty('recoveryQuality');
      expect(result[0].score).toHaveProperty('overall');
    });

    it('handles empty input', () => {
      const result = rankByScore([]);
      expect(result).toHaveLength(0);
    });
  });
});

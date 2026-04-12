import { describe, it, expect, vi } from 'vitest';
import type { ConversationMessage } from '@crowclaw/core';
import {
  parseJsonlPrompts,
  runBatch,
  type AgentRunFn,
  type BatchPrompt,
  type BatchRunResult,
} from '../packages/learning/src/batch-runner.js';
import {
  resultToTrajectory,
  batchToTrajectories,
  exportTrajectoryJsonl,
  exportShareGpt,
  trajectoryStats,
  type TrajectoryEntry,
} from '../packages/learning/src/trajectory.js';

// ─── Helpers ────────────────────────────────────────────────────────

function makeMessages(prompt: string, response: string): ConversationMessage[] {
  return [
    { role: 'user', content: prompt, createdAt: '2026-01-01T00:00:00Z' },
    { role: 'assistant', content: response, createdAt: '2026-01-01T00:00:01Z' },
  ];
}

function makeMockAgent(response = 'OK'): AgentRunFn {
  return vi.fn(async (input) => ({
    finalResponse: response,
    toolResults: [
      { toolName: 'shell', ok: true, output: 'done' },
    ],
    session: { messages: makeMessages(input.userMessage, response) },
  })) as unknown as AgentRunFn;
}

function makeFailingAgent(): AgentRunFn {
  return vi.fn(async () => {
    throw new Error('agent crashed');
  }) as unknown as AgentRunFn;
}

function makeBatchResult(overrides: Partial<BatchRunResult> = {}): BatchRunResult {
  return {
    promptId: 'p1',
    sessionId: 'sess-1',
    ok: true,
    response: 'hello',
    toolCalls: [
      { toolName: 'shell', ok: true, output: 'done' },
      { toolName: 'shell', ok: false, output: 'err' },
      { toolName: 'read', ok: true, output: 'file contents' },
    ],
    messages: makeMessages('hi', 'hello'),
    durationMs: 100,
    metadata: { tag: 'test' },
    ...overrides,
  };
}

// ─── parseJsonlPrompts ──────────────────────────────────────────────

describe('parseJsonlPrompts', () => {
  it('parses valid JSONL', () => {
    const jsonl = [
      JSON.stringify({ id: 'a', prompt: 'hello' }),
      JSON.stringify({ id: 'b', prompt: 'world', metadata: { key: 1 } }),
    ].join('\n');

    const result = parseJsonlPrompts(jsonl);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ id: 'a', prompt: 'hello' });
    expect(result[1]).toMatchObject({ id: 'b', prompt: 'world', metadata: { key: 1 } });
  });

  it('handles missing fields gracefully', () => {
    const jsonl = [
      JSON.stringify({ text: 'fallback text' }),      // no id, no prompt — uses text
      JSON.stringify({ message: 'msg fallback' }),     // uses message
      JSON.stringify({ id: 'empty' }),                 // no prompt/text/message — filtered out
      '',                                               // blank line — filtered out
      JSON.stringify({ id: 'x', prompt: 'ok', systemPrompt: 'sys' }),
    ].join('\n');

    const result = parseJsonlPrompts(jsonl);
    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ id: 'prompt-0', prompt: 'fallback text' });
    expect(result[1]).toMatchObject({ id: 'prompt-1', prompt: 'msg fallback' });
    expect(result[2]).toMatchObject({ id: 'x', prompt: 'ok', systemPrompt: 'sys' });
  });
});

// ─── runBatch ───────────────────────────────────────────────────────

describe('runBatch', () => {
  it('executes all prompts and returns summary', async () => {
    const prompts: BatchPrompt[] = [
      { id: 'p1', prompt: 'hello' },
      { id: 'p2', prompt: 'world' },
    ];
    const agent = makeMockAgent('response');

    const summary = await runBatch(prompts, agent, { runName: 'test-run' });

    expect(summary.runName).toBe('test-run');
    expect(summary.total).toBe(2);
    expect(summary.succeeded).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.skipped).toBe(0);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]!.ok).toBe(true);
    expect(summary.results[0]!.response).toBe('response');
    expect(summary.avgDurationMs).toBeGreaterThanOrEqual(0);
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it('resumes from a specific prompt ID and skips earlier ones', async () => {
    const prompts: BatchPrompt[] = [
      { id: 'p1', prompt: 'a' },
      { id: 'p2', prompt: 'b' },
      { id: 'p3', prompt: 'c' },
    ];
    const agent = makeMockAgent();

    const summary = await runBatch(prompts, agent, {
      runName: 'resume-run',
      resumeFromId: 'p2',
    });

    expect(summary.skipped).toBe(1);
    expect(summary.succeeded).toBe(2);
    expect(summary.results).toHaveLength(2);
    expect(summary.results[0]!.promptId).toBe('p2');
    expect(summary.results[1]!.promptId).toBe('p3');
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it('handles agent errors gracefully', async () => {
    const prompts: BatchPrompt[] = [
      { id: 'p1', prompt: 'fail me' },
    ];
    const agent = makeFailingAgent();

    const summary = await runBatch(prompts, agent, { runName: 'error-run' });

    expect(summary.total).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.failed).toBe(1);
    expect(summary.results[0]!.ok).toBe(false);
    expect(summary.results[0]!.error).toBe('agent crashed');
    expect(summary.results[0]!.response).toBe('');
    expect(summary.results[0]!.toolCalls).toHaveLength(0);
  });

  it('reports progress via callback', async () => {
    const prompts: BatchPrompt[] = [
      { id: 'p1', prompt: 'hello' },
    ];
    const agent = makeMockAgent();
    const progress: Array<{ status: string; currentId: string }> = [];

    await runBatch(prompts, agent, {
      runName: 'progress-run',
      onProgress: (p) => progress.push({ status: p.status, currentId: p.currentId }),
    });

    expect(progress).toHaveLength(2);
    expect(progress[0]).toMatchObject({ status: 'running', currentId: 'p1' });
    expect(progress[1]).toMatchObject({ status: 'completed', currentId: 'p1' });
  });
});

// ─── resultToTrajectory ─────────────────────────────────────────────

describe('resultToTrajectory', () => {
  it('converts a batch result to a trajectory entry', () => {
    const result = makeBatchResult();
    const trajectory = resultToTrajectory(result);

    expect(trajectory.id).toBe('p1');
    expect(trajectory.prompt).toBe('hi');
    expect(trajectory.response).toBe('hello');
    expect(trajectory.turns).toHaveLength(2);
    expect(trajectory.turns[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(trajectory.turns[1]).toMatchObject({ role: 'assistant', content: 'hello' });

    // Tool usage aggregation
    expect(trajectory.toolUsage).toHaveLength(2);
    const shellUsage = trajectory.toolUsage.find(t => t.toolName === 'shell');
    expect(shellUsage).toMatchObject({ count: 2, successCount: 1, failureCount: 1 });
    const readUsage = trajectory.toolUsage.find(t => t.toolName === 'read');
    expect(readUsage).toMatchObject({ count: 1, successCount: 1, failureCount: 0 });

    expect(trajectory.metadata.sessionId).toBe('sess-1');
    expect(trajectory.metadata.durationMs).toBe(100);
    expect(trajectory.metadata.ok).toBe(true);
    expect(trajectory.metadata.promptMetadata).toEqual({ tag: 'test' });
  });
});

// ─── exportTrajectoryJsonl ──────────────────────────────────────────

describe('exportTrajectoryJsonl', () => {
  it('produces valid JSONL output', () => {
    const result = makeBatchResult();
    const entries = [resultToTrajectory(result)];
    const jsonl = exportTrajectoryJsonl(entries);

    const lines = jsonl.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.id).toBe('p1');
    expect(parsed.prompt).toBe('hi');
    expect(parsed.response).toBe('hello');
    expect(parsed.turns).toBeDefined();
    expect(parsed.metadata).toBeDefined();
  });

  it('respects maxContentLength truncation', () => {
    const result = makeBatchResult({ response: 'a'.repeat(500) });
    const entries = [resultToTrajectory(result)];
    const jsonl = exportTrajectoryJsonl(entries, {
      format: 'jsonl',
      maxContentLength: 10,
    });

    const parsed = JSON.parse(jsonl) as Record<string, unknown>;
    expect((parsed.response as string).length).toBeLessThan(500);
    expect((parsed.response as string)).toContain('... [truncated]');
  });

  it('excludes tool messages when includeToolMessages is false', () => {
    const result = makeBatchResult();
    const entries = [resultToTrajectory(result)];
    const jsonl = exportTrajectoryJsonl(entries, {
      format: 'jsonl',
      includeToolMessages: false,
    });

    const parsed = JSON.parse(jsonl) as Record<string, unknown>;
    expect(parsed.turns).toBeUndefined();
    expect(parsed.toolUsage).toBeUndefined();
  });

  it('excludes metadata when includeMetadata is false', () => {
    const result = makeBatchResult();
    const entries = [resultToTrajectory(result)];
    const jsonl = exportTrajectoryJsonl(entries, {
      format: 'jsonl',
      includeMetadata: false,
    });

    const parsed = JSON.parse(jsonl) as Record<string, unknown>;
    expect(parsed.metadata).toBeUndefined();
  });
});

// ─── exportShareGpt ─────────────────────────────────────────────────

describe('exportShareGpt', () => {
  it('produces ShareGPT format', () => {
    const result = makeBatchResult();
    const entries = [resultToTrajectory(result)];
    const output = exportShareGpt(entries);

    const lines = output.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as {
      conversations: Array<{ from: string; value: string }>;
      id: string;
    };
    expect(parsed.id).toBe('p1');
    expect(parsed.conversations).toHaveLength(2);
    expect(parsed.conversations[0]).toMatchObject({ from: 'human', value: 'hi' });
    expect(parsed.conversations[1]).toMatchObject({ from: 'gpt', value: 'hello' });
  });
});

// ─── trajectoryStats ────────────────────────────────────────────────

describe('trajectoryStats', () => {
  it('calculates correct stats', () => {
    const results = [
      makeBatchResult({ promptId: 'p1', durationMs: 100 }),
      makeBatchResult({ promptId: 'p2', durationMs: 200, ok: false, error: 'err' }),
    ];
    const entries = results.map(resultToTrajectory);
    const stats = trajectoryStats(entries);

    expect(stats.totalEntries).toBe(2);
    expect(stats.succeeded).toBe(1);
    expect(stats.failed).toBe(1);
    expect(stats.avgDurationMs).toBe(150);
    expect(stats.uniqueToolsUsed).toEqual(['read', 'shell']);
    expect(stats.totalToolCalls).toBe(6); // 3 per result x 2 results
    expect(stats.avgTurnsPerEntry).toBe(2); // 2 messages per result
  });

  it('returns zeros for empty input', () => {
    const stats = trajectoryStats([]);
    expect(stats.totalEntries).toBe(0);
    expect(stats.avgDurationMs).toBe(0);
    expect(stats.totalToolCalls).toBe(0);
    expect(stats.avgTurnsPerEntry).toBe(0);
  });
});

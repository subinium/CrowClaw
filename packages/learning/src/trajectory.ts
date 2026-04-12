import type { ConversationMessage } from '@crowclaw/core';
import type { BatchRunResult, BatchRunSummary } from './batch-runner.js';

export interface TrajectoryEntry {
  id: string;
  prompt: string;
  response: string;
  turns: TrajectoryTurn[];
  toolUsage: TrajectoryToolUsage[];
  metadata: {
    sessionId: string;
    durationMs: number;
    ok: boolean;
    error?: string;
    promptMetadata?: Record<string, unknown>;
  };
}

export interface TrajectoryTurn {
  role: string;
  content: string;
  toolName?: string;
  timestamp: string;
}

export interface TrajectoryToolUsage {
  toolName: string;
  count: number;
  successCount: number;
  failureCount: number;
}

export interface TrajectoryExportOptions {
  format: 'jsonl' | 'sharegpt';
  includeToolMessages?: boolean;   // Default: true
  includeMetadata?: boolean;       // Default: true
  maxContentLength?: number;       // Truncate long outputs (default: no limit)
}

/** Convert batch results to trajectory entries */
export function batchToTrajectories(summary: BatchRunSummary): TrajectoryEntry[] {
  return summary.results.map(resultToTrajectory);
}

/** Convert a single batch result to trajectory */
export function resultToTrajectory(result: BatchRunResult): TrajectoryEntry {
  const userMsg = result.messages.find(m => m.role === 'user');
  const toolUsageMap = new Map<string, { count: number; success: number; fail: number }>();

  for (const tc of result.toolCalls) {
    const existing = toolUsageMap.get(tc.toolName) ?? { count: 0, success: 0, fail: 0 };
    existing.count++;
    if (tc.ok) existing.success++;
    else existing.fail++;
    toolUsageMap.set(tc.toolName, existing);
  }

  return {
    id: result.promptId,
    prompt: userMsg?.content ?? '',
    response: result.response,
    turns: result.messages.map(m => ({
      role: m.role,
      content: m.content,
      toolName: m.name,
      timestamp: m.createdAt,
    })),
    toolUsage: [...toolUsageMap.entries()].map(([name, stats]) => ({
      toolName: name,
      count: stats.count,
      successCount: stats.success,
      failureCount: stats.fail,
    })),
    metadata: {
      sessionId: result.sessionId,
      durationMs: result.durationMs,
      ok: result.ok,
      error: result.error,
      promptMetadata: result.metadata,
    },
  };
}

/** Export trajectories to JSONL */
export function exportTrajectoryJsonl(
  entries: TrajectoryEntry[],
  options: TrajectoryExportOptions = { format: 'jsonl' },
): string {
  return entries
    .map(entry => {
      const output: Record<string, unknown> = {
        id: entry.id,
        prompt: entry.prompt,
        response: truncate(entry.response, options.maxContentLength),
      };

      if (options.includeToolMessages !== false) {
        output.turns = entry.turns.map(t => ({
          ...t,
          content: truncate(t.content, options.maxContentLength),
        }));
        output.toolUsage = entry.toolUsage;
      }

      if (options.includeMetadata !== false) {
        output.metadata = entry.metadata;
      }

      return JSON.stringify(output);
    })
    .join('\n');
}

/** Export in ShareGPT format */
export function exportShareGpt(entries: TrajectoryEntry[]): string {
  return entries
    .map(entry => {
      const conversations = entry.turns
        .filter(t => t.role === 'user' || t.role === 'assistant')
        .map(t => ({
          from: t.role === 'user' ? 'human' : 'gpt',
          value: t.content,
        }));

      return JSON.stringify({ conversations, id: entry.id });
    })
    .join('\n');
}

/** Run stats from trajectory entries */
export function trajectoryStats(entries: TrajectoryEntry[]): {
  totalEntries: number;
  succeeded: number;
  failed: number;
  avgDurationMs: number;
  uniqueToolsUsed: string[];
  totalToolCalls: number;
  avgTurnsPerEntry: number;
} {
  const totalDuration = entries.reduce((s, e) => s + e.metadata.durationMs, 0);
  const toolNames = new Set<string>();
  let totalToolCalls = 0;
  let totalTurns = 0;

  for (const entry of entries) {
    totalTurns += entry.turns.length;
    for (const t of entry.toolUsage) {
      toolNames.add(t.toolName);
      totalToolCalls += t.count;
    }
  }

  return {
    totalEntries: entries.length,
    succeeded: entries.filter(e => e.metadata.ok).length,
    failed: entries.filter(e => !e.metadata.ok).length,
    avgDurationMs: entries.length > 0 ? Math.round(totalDuration / entries.length) : 0,
    uniqueToolsUsed: [...toolNames].sort(),
    totalToolCalls,
    avgTurnsPerEntry: entries.length > 0 ? Math.round(totalTurns / entries.length) : 0,
  };
}

function truncate(text: string, maxLen?: number): string {
  if (!maxLen || text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '... [truncated]';
}

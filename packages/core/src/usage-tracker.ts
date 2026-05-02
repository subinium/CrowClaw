// ---------------------------------------------------------------------------
// DetailedUsageTracker — per-call usage tracking with cost estimation
// ---------------------------------------------------------------------------

import { getTelemetryHooks } from './telemetry.js';

export interface UsageEntry {
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedTokens: number;
  costUsd: number;
  latencyMs: number;
}

export interface UsageSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUsd: number;
  avgLatencyMs: number;
  entries: UsageEntry[];
  byModel: Record<string, { tokens: number; cost: number; calls: number }>;
}

// Pricing sourced from the model metadata catalog in @crowclaw/providers.
// Duplicated here to avoid a circular dependency between core and providers.
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 2.5, output: 10 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'gpt-4-turbo': { input: 10, output: 30 },
  'gpt-3.5-turbo': { input: 0.5, output: 1.5 },
  'o1': { input: 15, output: 60 },
  'o1-mini': { input: 3, output: 12 },
  'o1-pro': { input: 150, output: 600 },
  'o3': { input: 10, output: 40 },
  'o3-mini': { input: 1.1, output: 4.4 },
  'o4-mini': { input: 1.1, output: 4.4 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-haiku-3-5': { input: 0.8, output: 4 },
  'claude-3-5-sonnet': { input: 3, output: 15 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },
  'claude-3-opus': { input: 15, output: 75 },
  'claude-3-sonnet': { input: 3, output: 15 },
  'claude-3-haiku': { input: 0.25, output: 1.25 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4 },
  'gemini-1.5-pro': { input: 1.25, output: 5 },
  'gemini-1.5-flash': { input: 0.075, output: 0.3 },
  'deepseek-v3': { input: 0.27, output: 1.1 },
  'deepseek-r1': { input: 0.55, output: 2.19 },
  'deepseek-coder': { input: 0.14, output: 0.28 },
  'mistral-large': { input: 2, output: 6 },
  'mistral-small': { input: 0.1, output: 0.3 },
  'mistral-medium': { input: 2.7, output: 8.1 },
  'codestral': { input: 0.3, output: 0.9 },
};

const DEFAULT_PRICING = { input: 3, output: 15 };

export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
  return (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;
}

export class DetailedUsageTracker {
  private entries: UsageEntry[] = [];

  record(entry: Omit<UsageEntry, 'timestamp'>): void {
    const activeSpan = getTelemetryHooks()?.getActiveSpan?.();
    activeSpan?.setAttribute('llm.token_count.prompt', entry.inputTokens);
    activeSpan?.setAttribute('llm.token_count.completion', entry.outputTokens);
    activeSpan?.setAttribute('gen_ai.usage.cost', entry.costUsd);
    activeSpan?.setAttribute('gen_ai.response.model', entry.model);
    activeSpan?.setAttribute('gen_ai.system', entry.provider);

    this.entries.push({
      ...entry,
      timestamp: new Date().toISOString(),
    });
  }

  getSummary(): UsageSummary {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalLatencyMs = 0;
    const byModel: Record<string, { tokens: number; cost: number; calls: number }> = {};

    for (const entry of this.entries) {
      totalInputTokens += entry.inputTokens;
      totalOutputTokens += entry.outputTokens;
      totalTokens += entry.totalTokens;
      totalCostUsd += entry.costUsd;
      totalLatencyMs += entry.latencyMs;

      const existing = byModel[entry.model];
      if (existing) {
        existing.tokens += entry.totalTokens;
        existing.cost += entry.costUsd;
        existing.calls += 1;
      } else {
        byModel[entry.model] = {
          tokens: entry.totalTokens,
          cost: entry.costUsd,
          calls: 1,
        };
      }
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCostUsd,
      avgLatencyMs: this.entries.length > 0 ? totalLatencyMs / this.entries.length : 0,
      entries: [...this.entries],
      byModel,
    };
  }

  getSessionCost(): number {
    let total = 0;
    for (const entry of this.entries) {
      total += entry.costUsd;
    }
    return total;
  }

  reset(): void {
    this.entries = [];
  }
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface UsageRecord {
  sessionId: string;
  model: string;
  provider: string;
  usage: TokenUsage;
  estimatedCost: number; // USD
  timestamp: string;
  toolCalls: number;
  latencyMs: number;
}

export interface SessionUsageSummary {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCost: number;
  requestCount: number;
  averageLatencyMs: number;
  modelBreakdown: Record<string, { tokens: number; cost: number; requests: number }>;
  toolCallCount: number;
  firstRequestAt: string;
  lastRequestAt: string;
}

interface ModelPricing {
  input: number; // USD per 1M tokens
  output: number; // USD per 1M tokens
}

const MODEL_PRICING: Record<string, ModelPricing> = {
  'gpt-4.1': { input: 2, output: 8 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4 },
  'gpt-4o': { input: 5, output: 15 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-3.5': { input: 0.8, output: 4 },
  'gemini-2.5-pro': { input: 1.25, output: 10 },
  'gemini-2.5-flash': { input: 0.15, output: 0.6 },
};

const DEFAULT_PRICING: ModelPricing = { input: 3, output: 15 };

export class UsageTracker {
  private records: UsageRecord[] = [];

  record(entry: UsageRecord): void {
    this.records.push(entry);
  }

  getRecords(): readonly UsageRecord[] {
    return this.records;
  }

  getSessionSummary(sessionId: string): SessionUsageSummary {
    const sessionRecords = this.records.filter(r => r.sessionId === sessionId);

    if (sessionRecords.length === 0) {
      return {
        sessionId,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalTokens: 0,
        totalCost: 0,
        requestCount: 0,
        averageLatencyMs: 0,
        modelBreakdown: {},
        toolCallCount: 0,
        firstRequestAt: '',
        lastRequestAt: '',
      };
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCost = 0;
    let totalLatency = 0;
    let toolCallCount = 0;
    const modelBreakdown: Record<string, { tokens: number; cost: number; requests: number }> = {};

    for (const record of sessionRecords) {
      totalInputTokens += record.usage.inputTokens;
      totalOutputTokens += record.usage.outputTokens;
      totalCost += record.estimatedCost;
      totalLatency += record.latencyMs;
      toolCallCount += record.toolCalls;

      const existing = modelBreakdown[record.model];
      if (existing) {
        existing.tokens += record.usage.totalTokens;
        existing.cost += record.estimatedCost;
        existing.requests += 1;
      } else {
        modelBreakdown[record.model] = {
          tokens: record.usage.totalTokens,
          cost: record.estimatedCost,
          requests: 1,
        };
      }
    }

    const timestamps = sessionRecords.map(r => r.timestamp).sort();
    const firstRequestAt = timestamps[0] ?? '';
    const lastRequestAt = timestamps[timestamps.length - 1] ?? firstRequestAt;

    return {
      sessionId,
      totalInputTokens,
      totalOutputTokens,
      totalTokens: totalInputTokens + totalOutputTokens,
      totalCost,
      requestCount: sessionRecords.length,
      averageLatencyMs: totalLatency / sessionRecords.length,
      modelBreakdown,
      toolCallCount,
      firstRequestAt,
      lastRequestAt,
    };
  }

  getAllSessions(): SessionUsageSummary[] {
    const sessionIds = [...new Set(this.records.map(r => r.sessionId))];
    return sessionIds.map(id => this.getSessionSummary(id));
  }

  getGlobalSummary(): {
    totalCost: number;
    totalTokens: number;
    totalRequests: number;
    sessionCount: number;
    topModels: Array<{ model: string; cost: number; requests: number }>;
  } {
    const sessions = this.getAllSessions();
    const modelAgg: Record<string, { cost: number; requests: number }> = {};

    let totalCost = 0;
    let totalTokens = 0;
    let totalRequests = 0;

    for (const session of sessions) {
      totalCost += session.totalCost;
      totalTokens += session.totalTokens;
      totalRequests += session.requestCount;

      for (const [model, data] of Object.entries(session.modelBreakdown)) {
        const existing = modelAgg[model];
        if (existing) {
          existing.cost += data.cost;
          existing.requests += data.requests;
        } else {
          modelAgg[model] = { cost: data.cost, requests: data.requests };
        }
      }
    }

    const topModels = Object.entries(modelAgg)
      .map(([model, data]) => ({ model, ...data }))
      .sort((a, b) => b.cost - a.cost);

    return {
      totalCost,
      totalTokens,
      totalRequests,
      sessionCount: sessions.length,
      topModels,
    };
  }

  static estimateCost(model: string, usage: TokenUsage): number {
    const price = MODEL_PRICING[model] ?? DEFAULT_PRICING;
    return (usage.inputTokens * price.input + usage.outputTokens * price.output) / 1_000_000;
  }

  exportJson(): string {
    return JSON.stringify(
      { records: this.records, generated: new Date().toISOString() },
      null,
      2,
    );
  }

  clear(): void {
    this.records = [];
  }
}

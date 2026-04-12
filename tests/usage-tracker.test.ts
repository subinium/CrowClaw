import { describe, it, expect } from 'vitest';
import { DetailedUsageTracker, type UsageEntry } from '@crowclaw/core';

describe('DetailedUsageTracker', () => {
  it('records entries and returns them in getSummary', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      costUsd: 0.001,
      latencyMs: 200,
    });

    const summary = tracker.getSummary();
    expect(summary.entries).toHaveLength(1);
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.totalOutputTokens).toBe(50);
    expect(summary.totalTokens).toBe(150);
    expect(summary.totalCostUsd).toBe(0.001);
    expect(summary.avgLatencyMs).toBe(200);
  });

  it('aggregates multiple entries correctly', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      costUsd: 0.001,
      latencyMs: 200,
    });
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cachedTokens: 0,
      costUsd: 0.002,
      latencyMs: 400,
    });

    const summary = tracker.getSummary();
    expect(summary.entries).toHaveLength(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalTokens).toBe(450);
    expect(summary.totalCostUsd).toBe(0.003);
    expect(summary.avgLatencyMs).toBe(300);
  });

  it('computes byModel aggregation correctly', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      costUsd: 0.001,
      latencyMs: 100,
    });
    tracker.record({
      model: 'claude-opus-4',
      provider: 'anthropic',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cachedTokens: 20,
      costUsd: 0.01,
      latencyMs: 300,
    });
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 50,
      outputTokens: 25,
      totalTokens: 75,
      cachedTokens: 0,
      costUsd: 0.0005,
      latencyMs: 50,
    });

    const summary = tracker.getSummary();
    expect(summary.byModel['gpt-4o']).toEqual({
      tokens: 225,
      cost: 0.0015,
      calls: 2,
    });
    expect(summary.byModel['claude-opus-4']).toEqual({
      tokens: 300,
      cost: 0.01,
      calls: 1,
    });
  });

  it('getSessionCost returns total cost', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      costUsd: 0.005,
      latencyMs: 100,
    });
    tracker.record({
      model: 'claude-opus-4',
      provider: 'anthropic',
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
      cachedTokens: 0,
      costUsd: 0.015,
      latencyMs: 200,
    });

    expect(tracker.getSessionCost()).toBe(0.02);
  });

  it('reset clears all entries', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      cachedTokens: 0,
      costUsd: 0.001,
      latencyMs: 100,
    });

    expect(tracker.getSummary().entries).toHaveLength(1);
    tracker.reset();

    const summary = tracker.getSummary();
    expect(summary.entries).toHaveLength(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
    expect(summary.byModel).toEqual({});
    expect(tracker.getSessionCost()).toBe(0);
  });

  it('adds timestamp automatically on record', () => {
    const tracker = new DetailedUsageTracker();
    const before = new Date().toISOString();
    tracker.record({
      model: 'gpt-4o',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      costUsd: 0.0001,
      latencyMs: 50,
    });
    const after = new Date().toISOString();

    const entry = tracker.getSummary().entries[0];
    expect(entry.timestamp).toBeDefined();
    expect(entry.timestamp >= before).toBe(true);
    expect(entry.timestamp <= after).toBe(true);
  });

  it('returns empty summary when no entries recorded', () => {
    const tracker = new DetailedUsageTracker();
    const summary = tracker.getSummary();

    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalTokens).toBe(0);
    expect(summary.totalCostUsd).toBe(0);
    expect(summary.avgLatencyMs).toBe(0);
    expect(summary.entries).toHaveLength(0);
    expect(summary.byModel).toEqual({});
  });

  it('cost estimation uses known model pricing', () => {
    const tracker = new DetailedUsageTracker();

    // Claude Opus 4: input $15/M, output $75/M
    // 1000 input tokens = 1000 * 15 / 1_000_000 = 0.015
    // 500 output tokens = 500 * 75 / 1_000_000 = 0.0375
    // Total = 0.0525
    tracker.record({
      model: 'claude-opus-4',
      provider: 'anthropic',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedTokens: 0,
      costUsd: 0.0525,
      latencyMs: 500,
    });

    expect(tracker.getSessionCost()).toBeCloseTo(0.0525, 4);
  });
});

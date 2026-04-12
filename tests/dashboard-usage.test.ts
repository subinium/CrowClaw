import { describe, expect, it } from 'vitest';
import { DASHBOARD_HTML } from '../packages/web/src/index.js';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import { DetailedUsageTracker } from '../packages/core/src/usage-tracker.js';
import { builtInCliSlashCommands, runCliInputLine, renderCliHelp } from '../packages/cli/src/index.js';

describe('Dashboard Usage panel', () => {
  it('contains the Usage nav item in the sidebar', () => {
    expect(DASHBOARD_HTML).toContain('data-v="usage"');
    expect(DASHBOARD_HTML).toContain('>Usage<');
  });

  it('contains the Usage panel view container', () => {
    expect(DASHBOARD_HTML).toContain('id="v-usage"');
  });

  it('contains the Usage summary cards container', () => {
    expect(DASHBOARD_HTML).toContain('id="uCards"');
  });

  it('contains the per-model breakdown container', () => {
    expect(DASHBOARD_HTML).toContain('id="uModel"');
  });

  it('contains the recent entries container', () => {
    expect(DASHBOARD_HTML).toContain('id="uEntries"');
  });

  it('contains the lUsage JS function', () => {
    expect(DASHBOARD_HTML).toContain('function lUsage()');
  });

  it('contains the uReset JS function', () => {
    expect(DASHBOARD_HTML).toContain('function uReset()');
  });

  it('loads usage data from /api/usage', () => {
    expect(DASHBOARD_HTML).toContain("'/api/usage'");
  });
});

describe('/api/usage endpoint', () => {
  it('GET /api/usage returns proper JSON shape with empty tracker', async () => {
    const tracker = new DetailedUsageTracker();
    const runtime = createNodeRuntime({ usageTracker: tracker });
    const response = await runtime.fetch(new Request('http://localhost/api/usage'));
    const data = await response.json() as Record<string, unknown>;

    expect(data).toHaveProperty('totalInputTokens', 0);
    expect(data).toHaveProperty('totalOutputTokens', 0);
    expect(data).toHaveProperty('totalTokens', 0);
    expect(data).toHaveProperty('totalCostUsd', 0);
    expect(data).toHaveProperty('avgLatencyMs', 0);
    expect(data).toHaveProperty('entries');
    expect(data).toHaveProperty('byModel');
    expect(Array.isArray(data.entries)).toBe(true);
  });

  it('GET /api/usage reflects recorded entries', async () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4.1',
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedTokens: 0,
      costUsd: 0.006,
      latencyMs: 300,
    });
    tracker.record({
      model: 'claude-opus-4',
      provider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 800,
      totalTokens: 2800,
      cachedTokens: 0,
      costUsd: 0.09,
      latencyMs: 500,
    });

    const runtime = createNodeRuntime({ usageTracker: tracker });
    const response = await runtime.fetch(new Request('http://localhost/api/usage'));
    const data = await response.json() as {
      totalInputTokens: number;
      totalOutputTokens: number;
      totalTokens: number;
      totalCostUsd: number;
      avgLatencyMs: number;
      entries: Array<{ model: string }>;
      byModel: Record<string, { calls: number; tokens: number; cost: number }>;
    };

    expect(data.totalInputTokens).toBe(3000);
    expect(data.totalOutputTokens).toBe(1300);
    expect(data.totalTokens).toBe(4300);
    expect(data.totalCostUsd).toBeCloseTo(0.096);
    expect(data.avgLatencyMs).toBe(400);
    expect(data.entries).toHaveLength(2);
    expect(data.byModel['gpt-4.1']).toEqual({ calls: 1, tokens: 1500, cost: 0.006 });
    expect(data.byModel['claude-opus-4']).toEqual({ calls: 1, tokens: 2800, cost: 0.09 });
  });

  it('POST /api/usage/reset clears the tracker', async () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4.1',
      provider: 'openai',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      cachedTokens: 0,
      costUsd: 0.006,
      latencyMs: 300,
    });

    const runtime = createNodeRuntime({ usageTracker: tracker });

    const resetResponse = await runtime.fetch(new Request('http://localhost/api/usage/reset', { method: 'POST' }));
    const resetData = await resetResponse.json() as { ok: boolean };
    expect(resetData.ok).toBe(true);

    const afterResponse = await runtime.fetch(new Request('http://localhost/api/usage'));
    const afterData = await afterResponse.json() as { totalTokens: number; entries: Array<unknown> };
    expect(afterData.totalTokens).toBe(0);
    expect(afterData.entries).toHaveLength(0);
  });
});

describe('CLI /usage command', () => {
  it('is listed in builtInCliSlashCommands', () => {
    expect(builtInCliSlashCommands).toContain('/usage');
  });

  it('appears in help text', () => {
    const help = renderCliHelp();
    expect(help).toContain('/usage');
  });

  it('formats usage output correctly', async () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4.1',
      provider: 'openai',
      inputTokens: 8000,
      outputTokens: 4345,
      totalTokens: 12345,
      cachedTokens: 0,
      costUsd: 0.0234,
      latencyMs: 450,
    });
    tracker.record({
      model: 'claude-opus-4',
      provider: 'anthropic',
      inputTokens: 2000,
      outputTokens: 500,
      totalTokens: 2500,
      cachedTokens: 0,
      costUsd: 0.0034,
      latencyMs: 350,
    });

    const runtime = createNodeRuntime({ usageTracker: tracker });
    const result = await runCliInputLine('/usage', { sessionId: 'test-session' }, { runtime });

    expect(result.output).toContain('Session Usage:');
    expect(result.output).toContain('Total tokens:');
    expect(result.output).toContain('Total cost:');
    expect(result.output).toContain('Avg latency:');
    expect(result.output).toContain('API calls: 2');
    expect(result.output).toContain('By Model:');
    expect(result.output).toContain('gpt-4.1');
    expect(result.output).toContain('claude-opus-4');
  });
});

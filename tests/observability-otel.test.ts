import { describe, expect, it, beforeEach } from 'vitest';
import { DetailedUsageTracker } from '@crowclaw/core';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import {
  getRuntimeTelemetryMetrics,
  observeRuntimeTelemetryEvent,
  renderPrometheusMetrics,
  resetRuntimeTelemetryMetrics,
} from '../packages/runtime-node/src/otel.js';

describe('runtime OpenTelemetry metrics', () => {
  beforeEach(() => {
    resetRuntimeTelemetryMetrics();
  });

  it('records bounded GenAI and tool counters from runtime events', () => {
    observeRuntimeTelemetryEvent({ type: 'chat:message', data: { sessionId: 's1' } });
    observeRuntimeTelemetryEvent({ type: 'chat:complete', data: { sessionId: 's1' } });
    observeRuntimeTelemetryEvent({ type: 'tool:complete', data: { callId: 'c1', ok: false } });
    observeRuntimeTelemetryEvent({ type: 'gateway:error', data: { reason: 'endpoint-policy:disallowed-path' } });

    expect(getRuntimeTelemetryMetrics()).toMatchObject({
      genAiRequests: 1,
      genAiCompletions: 1,
      toolCalls: 1,
      toolErrors: 1,
      gatewayPolicyRefusals: 1,
    });
  });

  it('renders Prometheus text without requiring an OpenTelemetry dependency', () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4.1',
      provider: 'openai',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      cachedTokens: 0,
      costUsd: 0.0001,
      latencyMs: 25,
    });

    const text = renderPrometheusMetrics(tracker.getSummary());
    expect(text).toContain('# TYPE crowclaw_genai_requests_total counter');
    expect(text).toContain('crowclaw_genai_input_tokens_total 10');
    expect(text).toContain('crowclaw_genai_output_tokens_total 5');
    expect(text).toContain('crowclaw_usage_entries 1');
  });

  it('serves /metrics as Prometheus text', async () => {
    const tracker = new DetailedUsageTracker();
    tracker.record({
      model: 'gpt-4.1',
      provider: 'openai',
      inputTokens: 3,
      outputTokens: 2,
      totalTokens: 5,
      cachedTokens: 0,
      costUsd: 0,
      latencyMs: 1,
    });
    const runtime = createNodeRuntime({ usageTracker: tracker, schedulerStorePath: null, configStorePath: null });

    const response = await runtime.fetch(new Request('http://localhost/metrics'));
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('crowclaw_genai_tokens_total 5');
    await runtime.shutdown();
  });
});

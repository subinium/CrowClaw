import { describe, expect, it, beforeEach } from 'vitest';
import { DetailedUsageTracker } from '@crowclaw/core';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';
import {
  ensureGenAiSemconvOptIn,
  GEN_AI_SEMCONV_OPT_IN,
  getRuntimeTelemetryMetrics,
  isPrometheusMetricsEnabled,
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

  it('keeps Prometheus metrics disabled until explicitly gated on', async () => {
    expect(isPrometheusMetricsEnabled({}, {})).toBe(false);
    expect(isPrometheusMetricsEnabled({ prometheusMetrics: true }, {})).toBe(true);
    expect(isPrometheusMetricsEnabled({}, { CROWCLAW_PROMETHEUS_METRICS: 'true' })).toBe(true);
  });

  it('serves /api/metrics as Prometheus text when enabled', async () => {
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
    const runtime = createNodeRuntime({
      usageTracker: tracker,
      schedulerStorePath: null,
      configStorePath: null,
      prometheusMetrics: true,
    });

    const response = await runtime.fetch(new Request('http://localhost/api/metrics'));
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(await response.text()).toContain('crowclaw_genai_tokens_total 5');
    await runtime.shutdown();
  });

  it('returns 404 for /api/metrics when the metrics gate is off', async () => {
    const previous = process.env.CROWCLAW_PROMETHEUS_METRICS;
    delete process.env.CROWCLAW_PROMETHEUS_METRICS;
    const runtime = createNodeRuntime({ schedulerStorePath: null, configStorePath: null });

    try {
      const response = await runtime.fetch(new Request('http://localhost/api/metrics'));

      expect(response.status).toBe(404);
    } finally {
      await runtime.shutdown();
      if (previous === undefined) {
        delete process.env.CROWCLAW_PROMETHEUS_METRICS;
      } else {
        process.env.CROWCLAW_PROMETHEUS_METRICS = previous;
      }
    }
  });

  it('opts into latest experimental GenAI semantic conventions without clobbering existing values', () => {
    const env: Record<string, string | undefined> = { OTEL_SEMCONV_STABILITY_OPT_IN: 'http' };

    ensureGenAiSemconvOptIn(env);
    ensureGenAiSemconvOptIn(env);

    expect(env.OTEL_SEMCONV_STABILITY_OPT_IN).toBe(`http,${GEN_AI_SEMCONV_OPT_IN}`);
  });
});

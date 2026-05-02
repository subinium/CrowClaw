import { setTelemetryHooks, type TelemetrySpan, type UsageSummary } from '@crowclaw/core';

type OtelApi = {
  trace?: {
    getTracer(name: string): {
      startSpan(name: string): TelemetrySpan;
    };
    getActiveSpan?(): TelemetrySpan | undefined;
  };
};

let installed = false;

export interface RuntimeTelemetryMetrics {
  genAiRequests: number;
  genAiCompletions: number;
  genAiErrors: number;
  gatewayPolicyRefusals: number;
  toolCalls: number;
  toolErrors: number;
}

export interface RuntimeTelemetryEvent {
  type: string;
  data?: Record<string, unknown>;
}

const metrics: RuntimeTelemetryMetrics = {
  genAiRequests: 0,
  genAiCompletions: 0,
  genAiErrors: 0,
  gatewayPolicyRefusals: 0,
  toolCalls: 0,
  toolErrors: 0,
};

export function resetRuntimeTelemetryMetrics(): void {
  metrics.genAiRequests = 0;
  metrics.genAiCompletions = 0;
  metrics.genAiErrors = 0;
  metrics.gatewayPolicyRefusals = 0;
  metrics.toolCalls = 0;
  metrics.toolErrors = 0;
}

export function observeRuntimeTelemetryEvent(event: RuntimeTelemetryEvent): void {
  switch (event.type) {
    case 'chat:message':
    case 'chat:stream':
      metrics.genAiRequests += 1;
      break;
    case 'chat:complete':
      metrics.genAiCompletions += 1;
      break;
    case 'chat:error':
      metrics.genAiErrors += 1;
      break;
    case 'gateway:error':
      if (typeof event.data?.reason === 'string' && event.data.reason.startsWith('endpoint-policy:')) {
        metrics.gatewayPolicyRefusals += 1;
      }
      break;
    case 'tool:complete':
      metrics.toolCalls += 1;
      if (event.data?.ok === false) metrics.toolErrors += 1;
      break;
  }
}

export function getRuntimeTelemetryMetrics(): RuntimeTelemetryMetrics {
  return { ...metrics };
}

function prometheusLine(name: string, help: string, type: 'counter' | 'gauge', value: number): string {
  return [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} ${type}`,
    `${name} ${Number.isFinite(value) ? value : 0}`,
  ].join('\n');
}

export function renderPrometheusMetrics(usageSummary?: UsageSummary): string {
  const usage = usageSummary ?? {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalTokens: 0,
    totalCostUsd: 0,
    avgLatencyMs: 0,
    entries: [],
    byModel: {},
  };
  return [
    prometheusLine('crowclaw_genai_requests_total', 'Total GenAI chat requests observed by the runtime.', 'counter', metrics.genAiRequests),
    prometheusLine('crowclaw_genai_completions_total', 'Total GenAI chat completions observed by the runtime.', 'counter', metrics.genAiCompletions),
    prometheusLine('crowclaw_genai_errors_total', 'Total GenAI chat errors observed by the runtime.', 'counter', metrics.genAiErrors),
    prometheusLine('crowclaw_genai_input_tokens_total', 'Total GenAI input tokens recorded by the usage tracker.', 'counter', usage.totalInputTokens),
    prometheusLine('crowclaw_genai_output_tokens_total', 'Total GenAI output tokens recorded by the usage tracker.', 'counter', usage.totalOutputTokens),
    prometheusLine('crowclaw_genai_tokens_total', 'Total GenAI tokens recorded by the usage tracker.', 'counter', usage.totalTokens),
    prometheusLine('crowclaw_genai_cost_usd_total', 'Total estimated GenAI cost recorded by the usage tracker.', 'counter', usage.totalCostUsd),
    prometheusLine('crowclaw_tool_calls_total', 'Total tool calls observed by the runtime.', 'counter', metrics.toolCalls),
    prometheusLine('crowclaw_tool_errors_total', 'Total failed tool calls observed by the runtime.', 'counter', metrics.toolErrors),
    prometheusLine('crowclaw_gateway_policy_refusals_total', 'Total gateway endpoint policy refusals observed by the runtime.', 'counter', metrics.gatewayPolicyRefusals),
    prometheusLine('crowclaw_usage_entries', 'Current number of usage entries retained by the runtime usage tracker.', 'gauge', usage.entries.length),
  ].join('\n') + '\n';
}

export async function installOpenTelemetryBridge(): Promise<boolean> {
  if (installed) return true;
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<OtelApi>;
    const api = await dynamicImport('@opentelemetry/api');
    const trace = api.trace;
    if (!trace) return false;
    const tracer = trace.getTracer('crowclaw');
    setTelemetryHooks({
      startSpan(name, attributes) {
        const span = tracer.startSpan(name);
        for (const [key, value] of Object.entries(attributes ?? {})) {
          span.setAttribute(key, value);
        }
        return span;
      },
      getActiveSpan() {
        return trace.getActiveSpan?.() ?? null;
      },
    });
    installed = true;
    return true;
  } catch {
    return false;
  }
}

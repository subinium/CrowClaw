import type { Plugin, PluginContext, PluginHookPayloads, PluginHookName, PreToolCallVeto } from '@crowclaw/core';

export interface MetricTapRecord {
  toolName: string;
  ok: boolean;
  durationMs: number;
  sessionId: string;
}

function metricKey(payload: { toolName: string; sessionId: string; agentId: string }): string {
  return `${payload.sessionId}:${payload.agentId}:${payload.toolName}`;
}

export class MetricTapPlugin implements Plugin {
  readonly name = 'metric-tap';
  private readonly startedAt = new Map<string, number>();
  private readonly records: MetricTapRecord[] = [];

  preToolCall(
    payload: { toolName: string; sessionId: string; agentId: string },
    _context: PluginContext,
  ): PreToolCallVeto {
    this.startedAt.set(metricKey(payload), Date.now());
    return { veto: false };
  }

  on<K extends PluginHookName>(hook: K, payload: PluginHookPayloads[K], context: PluginContext): void {
    if (hook !== 'tool:result' && hook !== 'tool:error') return;

    const result = (payload as PluginHookPayloads['tool:result']).result;
    const key = metricKey({
      toolName: result.toolName,
      sessionId: context.sessionId,
      agentId: context.agentId,
    });
    const started = this.startedAt.get(key) ?? Date.now();
    this.startedAt.delete(key);
    this.records.push({
      toolName: result.toolName,
      ok: result.ok,
      durationMs: Math.max(0, Date.now() - started),
      sessionId: context.sessionId,
    });
  }

  snapshot(): MetricTapRecord[] {
    return [...this.records];
  }

  renderPrometheus(): string {
    const totals = new Map<string, { count: number; errors: number; totalMs: number }>();
    for (const record of this.records) {
      const current = totals.get(record.toolName) ?? { count: 0, errors: 0, totalMs: 0 };
      current.count += 1;
      current.errors += record.ok ? 0 : 1;
      current.totalMs += record.durationMs;
      totals.set(record.toolName, current);
    }

    const lines: string[] = [
      '# HELP crowclaw_plugin_tool_calls_total Tool calls observed by the metric-tap plugin.',
      '# TYPE crowclaw_plugin_tool_calls_total counter',
    ];
    for (const [toolName, total] of totals) {
      lines.push(`crowclaw_plugin_tool_calls_total{tool="${toolName}"} ${total.count}`);
      lines.push(`crowclaw_plugin_tool_errors_total{tool="${toolName}"} ${total.errors}`);
      lines.push(`crowclaw_plugin_tool_duration_ms_total{tool="${toolName}"} ${total.totalMs}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export function createMetricTapPlugin(): MetricTapPlugin {
  return new MetricTapPlugin();
}

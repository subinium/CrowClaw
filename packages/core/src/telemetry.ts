export interface TelemetrySpan {
  setAttribute(name: string, value: string | number | boolean): void;
  spanContext?(): { traceId?: string; spanId?: string };
  end(): void;
}

export interface TelemetryHooks {
  startSpan(name: string, attributes?: Record<string, string | number | boolean>): TelemetrySpan | null;
  getActiveSpan?(): TelemetrySpan | null;
}

let hooks: TelemetryHooks | null = null;

export function setTelemetryHooks(next: TelemetryHooks | null): void {
  hooks = next;
}

export function getTelemetryHooks(): TelemetryHooks | null {
  return hooks;
}

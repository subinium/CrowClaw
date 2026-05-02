import { setTelemetryHooks, type TelemetrySpan } from '@crowclaw/core';

type OtelApi = {
  trace?: {
    getTracer(name: string): {
      startSpan(name: string): TelemetrySpan;
    };
    getActiveSpan?(): TelemetrySpan | undefined;
  };
};

let installed = false;

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

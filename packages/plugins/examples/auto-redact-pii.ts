import { redactPII, type Plugin, type PluginContext, type ToolResultTransform } from '@crowclaw/core';

export class AutoRedactPiiPlugin implements Plugin {
  readonly name = 'auto-redact-pii';

  transformToolResult(
    payload: { result: { output: string; metadata?: Record<string, unknown> } },
    _context: PluginContext,
  ): ToolResultTransform | void {
    const redacted = redactPII(payload.result.output);
    if (redacted.redactedCount === 0) return undefined;

    return {
      output: redacted.text,
      metadata: {
        ...(payload.result.metadata ?? {}),
        piiRedactedCount: redacted.redactedCount,
        piiRedactedTypes: redacted.redactedTypes,
      },
    };
  }
}

export function createAutoRedactPiiPlugin(): Plugin {
  return new AutoRedactPiiPlugin();
}

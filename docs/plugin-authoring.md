# Plugin Authoring

CrowClaw plugins implement the `Plugin` contract from `@crowclaw/core`. A plugin can observe lifecycle events with `on`, veto a tool call with `preToolCall`, or transform a tool result with `transformToolResult`.

## Reference Plugins

The repository includes copyable examples under `packages/plugins/examples`.

### Block Destructive Shell Commands

`block-rm-rf-everything.ts` demonstrates a conservative organization policy plugin. It watches shell tools such as `terminal.exec` and refuses broad destructive patterns like `rm -rf /`, while leaving unrelated tools untouched.

Use this shape when a deployment needs a stricter local policy than the core hardline blocklist.

### Redact PII

`auto-redact-pii.ts` demonstrates `transformToolResult`. It runs tool output through `redactPII` and adds metadata about how many values were redacted.

Core redaction already runs before plugin transforms in normal agent execution. This example is useful as a defense-in-depth template and for authors who build custom tool pipelines.

### Metric Tap

`metric-tap.ts` combines `preToolCall` with post-result observer hooks. It starts a timer before the tool call, records success/error counts on `tool:result` or `tool:error`, and can render Prometheus-style counters.

Use this pattern when a plugin needs lightweight observability without changing tool results.

## Minimal Shape

```ts
import type { Plugin } from '@crowclaw/core';

export const plugin: Plugin = {
  name: 'my-plugin',
  preToolCall(payload) {
    if (payload.toolName === 'terminal.exec') {
      return { veto: true, reason: 'terminal execution disabled by policy' };
    }
    return { veto: false };
  },
};
```

Plugins should fail open for observation-only work and return explicit vetoes only for policy decisions the author intends to enforce.

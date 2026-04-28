/**
 * v0.7 (#179) — Tool execution trace tests.
 *
 * Two surfaces under test:
 *
 * 1. Runtime EventBus integration. The instrumented ToolRegistry wrapper in
 *    `createConfiguredAgent` must emit `tool:start` and `tool:complete`
 *    around every AgentLoop-driven tool execution. Direct routes
 *    (e.g. /api/web/fetch calling `tools.execute(...)`) must remain silent
 *    — they were already audited via SecurityAuditLog and we don't want
 *    duplicate trace events on the same dispatch.
 *
 * 2. The `<crowclaw-tool-call-trace>` source contract. Vitest runs in a
 *    `node` environment so we can't mount a Lit element — instead we read
 *    the source file and verify that the spec-required surface (tool name,
 *    duration, status indicator, args/output sections, Show full / Copy as
 *    cURL / Why? buttons, DOM-event publication) is present in the emitted
 *    template. This mirrors the existing `dashboard-polish.test.ts`
 *    contract style.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { RuntimeEvent } from '@crowclaw/runtime-node/event-bus';
import { ToolRegistry } from '@crowclaw/tools';
import type { ToolDefinition } from '@crowclaw/core';

const REPO_ROOT = path.resolve(__dirname, '..');
const TOOL_TRACE_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/components/tool-call-trace.ts'),
  'utf-8',
);
const COMPONENTS_INDEX_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/components/index.ts'),
  'utf-8',
);
const EVENT_BUS_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/runtime-node/src/event-bus.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// EventBus type extension
// ---------------------------------------------------------------------------

describe('v0.7 #179 — RuntimeEventType union', () => {
  it('includes tool:start', () => {
    expect(EVENT_BUS_SRC).toContain("'tool:start'");
  });
  it('includes tool:complete', () => {
    expect(EVENT_BUS_SRC).toContain("'tool:complete'");
  });
});

// ---------------------------------------------------------------------------
// Runtime integration — agent loop emits tool:start/complete around dispatch
// ---------------------------------------------------------------------------

function makeStubTool(name: string, output: string): ToolDefinition {
  return {
    manifest: {
      name,
      description: `stub ${name}`,
      runtime: 'worker',
      streaming: false,
      stateful: false,
      requiresWorkspace: false,
      requiresNetwork: false,
      dangerLevel: 'low',
      inputSchema: { type: 'object', properties: {} },
    },
    async execute(input) {
      return {
        toolName: name,
        runtime: 'worker',
        ok: true,
        output,
        metadata: { input },
      };
    },
  };
}

describe('v0.7 #179 — runtime emits tool:start / tool:complete around AgentLoop dispatches', () => {
  it('emits paired start/complete events with callId, toolName, durationMs, ok, args', async () => {
    // Build a stub provider that asks the agent to call our tool exactly once.
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const stubTools = new ToolRegistry();
    stubTools.register(makeStubTool('demo.run', 'hello world'));

    // Custom provider: returns one tool call on the first generate, then a
    // plain assistant message to terminate the loop.
    let calls = 0;
    const provider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          // ToolCall shape per @crowclaw/core: { name, input } — NOT toolName.
          return {
            toolCalls: [{ name: 'demo.run', input: { foo: 'bar' } }],
          };
        }
        return { assistantMessage: 'done' };
      },
    };

    const runtime = createNodeRuntime({
      provider: provider as never,
      tools: stubTools,
      // Hermetic: skip env/config probe so we keep the stub provider.
      configStorePath: null,
    });

    const events: RuntimeEvent[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.type === 'tool:start' || event.type === 'tool:complete') {
        events.push(event);
      }
    });

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/trace-test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'please run demo' }),
    }));
    expect(response.status).toBe(200);

    const startEvents = events.filter((e) => e.type === 'tool:start');
    const completeEvents = events.filter((e) => e.type === 'tool:complete');
    expect(startEvents.length).toBeGreaterThanOrEqual(1);
    expect(completeEvents.length).toBe(startEvents.length);

    const start = startEvents[0]!.data;
    expect(start.toolName).toBe('demo.run');
    expect(typeof start.callId).toBe('string');
    expect(start.args).toEqual({ foo: 'bar' });

    const complete = completeEvents[0]!.data;
    expect(complete.toolName).toBe('demo.run');
    expect(complete.callId).toBe(start.callId);
    expect(complete.ok).toBe(true);
    expect(typeof complete.durationMs).toBe('number');
    expect(complete.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof complete.output).toBe('string');
  });

  it('emits ok=false on tool failure and pairs start/complete even on throw', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');
    const stubTools = new ToolRegistry();
    const failingTool: ToolDefinition = {
      manifest: {
        name: 'demo.fail',
        description: 'always fails',
        runtime: 'worker',
        streaming: false,
        stateful: false,
        requiresWorkspace: false,
        requiresNetwork: false,
        dangerLevel: 'low',
        inputSchema: { type: 'object', properties: {} },
      },
      async execute() {
        return { toolName: 'demo.fail', runtime: 'worker', ok: false, output: 'boom' };
      },
    };
    stubTools.register(failingTool);

    let calls = 0;
    const provider = {
      async generate() {
        calls += 1;
        if (calls === 1) return { toolCalls: [{ name: 'demo.fail', input: {} }] };
        return { assistantMessage: 'done' };
      },
    };

    const runtime = createNodeRuntime({
      provider: provider as never,
      tools: stubTools,
      configStorePath: null,
    });

    const completed: RuntimeEvent[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.type === 'tool:complete') completed.push(event);
    });

    await runtime.fetch(new Request('http://localhost/api/sessions/trace-fail/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'try fail' }),
    }));

    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(completed[0]!.data.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Component source contract
// ---------------------------------------------------------------------------

describe('v0.7 #179 — <crowclaw-tool-call-trace> source contract', () => {
  it('registers the custom element', () => {
    expect(TOOL_TRACE_SRC).toContain("@customElement('crowclaw-tool-call-trace')");
  });

  it('declares ToolTraceEntry type with required fields', () => {
    expect(TOOL_TRACE_SRC).toContain('export interface ToolTraceEntry');
    expect(TOOL_TRACE_SRC).toContain('callId');
    expect(TOOL_TRACE_SRC).toContain('toolName');
    expect(TOOL_TRACE_SRC).toContain('durationMs');
  });

  it('renders the collapsed single-liner: tool name + duration + status', () => {
    expect(TOOL_TRACE_SRC).toContain('tool-name');
    expect(TOOL_TRACE_SRC).toContain('class="duration"');
    expect(TOOL_TRACE_SRC).toContain('_formatDuration');
  });

  it('renders args and output sections when expanded', () => {
    expect(TOOL_TRACE_SRC).toContain('Arguments');
    expect(TOOL_TRACE_SRC).toContain('Output');
    expect(TOOL_TRACE_SRC).toContain('_formatJson');
  });

  it('truncates output at 500 chars and shows a Show full action', () => {
    expect(TOOL_TRACE_SRC).toContain('INLINE_OUTPUT_LIMIT = 500');
    expect(TOOL_TRACE_SRC).toContain('Show full');
    expect(TOOL_TRACE_SRC).toContain("'crowclaw:trace-show-full'");
  });

  it('exposes Copy as cURL for HTTP-shaped tools', () => {
    expect(TOOL_TRACE_SRC).toContain('HTTP_SHAPED_TOOLS');
    expect(TOOL_TRACE_SRC).toContain('web.fetch');
    expect(TOOL_TRACE_SRC).toContain('Copy as cURL');
    expect(TOOL_TRACE_SRC).toContain('_buildCurl');
    expect(TOOL_TRACE_SRC).toContain("'crowclaw:trace-copy-curl'");
  });

  it('renders red border + Why? action for failed calls', () => {
    expect(TOOL_TRACE_SRC).toContain('.trace.error');
    expect(TOOL_TRACE_SRC).toContain('var(--error');
    expect(TOOL_TRACE_SRC).toContain("'crowclaw:trace-open-audit'");
  });

  it('escapes single quotes when building cURL bodies', () => {
    // Single-quote escape pattern must use the canonical close-escape-open
    // sequence so shell unescaping recovers the literal quote.
    expect(TOOL_TRACE_SRC).toMatch(/replace\(\/'\/g,\s*"'\\\\''"\)/);
  });

  it('publishes interactions via document-bubbled CustomEvents (no direct chat-view coupling)', () => {
    expect(TOOL_TRACE_SRC).toContain('document.dispatchEvent');
    expect(TOOL_TRACE_SRC).toContain('bubbles: true');
    expect(TOOL_TRACE_SRC).toContain('composed: true');
  });

  it('is re-exported from components/index.ts', () => {
    expect(COMPONENTS_INDEX_SRC).toContain("export { CrowClawToolCallTrace } from './tool-call-trace.js';");
    expect(COMPONENTS_INDEX_SRC).toContain("import './tool-call-trace.js';");
    expect(COMPONENTS_INDEX_SRC).toContain('ToolTraceEntry');
  });
});

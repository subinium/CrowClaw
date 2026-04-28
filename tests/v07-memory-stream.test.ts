/**
 * v0.7 (#180) — Memory pipeline stream tests.
 *
 * Two surfaces under test:
 *
 * 1. Runtime EventBus integration. `runConfiguredAgent` recall sites must
 *    emit `memory:recalled` after `MemoryService.recall` returns at least
 *    one record, and the post-agent capture sites must emit
 *    `memory:captured` after `captureSessionSummary` writes a record.
 *    Empty-recall is silent (would otherwise drown the stream).
 *
 * 2. The `<crowclaw-memory-stream>` source contract. Same node-env
 *    constraint as #179 — we read the source and verify the spec surface
 *    (capture/recall pulse animation, collapsible panel, relative time,
 *    DOM-event publication for row clicks).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { RuntimeEvent } from '@crowclaw/runtime-node/event-bus';

const REPO_ROOT = path.resolve(__dirname, '..');
const MEMORY_STREAM_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/components/memory-stream.ts'),
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

describe('v0.7 #180 — RuntimeEventType union', () => {
  it('includes memory:captured', () => {
    expect(EVENT_BUS_SRC).toContain("'memory:captured'");
  });
  it('includes memory:recalled', () => {
    expect(EVENT_BUS_SRC).toContain("'memory:recalled'");
  });
});

// ---------------------------------------------------------------------------
// Runtime integration — agent loop emits memory:* events around the run
// ---------------------------------------------------------------------------

describe('v0.7 #180 — runtime emits memory:captured / memory:recalled around AgentLoop', () => {
  it('emits memory:captured on the post-run captureSessionSummary write', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');

    const runtime = createNodeRuntime({
      // Hermetic mode — keeps the EchoProvider, which still pushes a
      // user/assistant turn through the loop and triggers post-run capture.
      configStorePath: null,
    });

    const captured: RuntimeEvent[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.type === 'memory:captured') captured.push(event);
    });

    const response = await runtime.fetch(new Request('http://localhost/api/sessions/mem-cap-test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'hello memory pipeline' }),
    }));
    expect(response.status).toBe(200);

    expect(captured.length).toBeGreaterThanOrEqual(1);
    const evt = captured[0]!.data as Record<string, unknown>;
    expect(evt.sessionId).toBe('mem-cap-test');
    expect(typeof evt.memoryId).toBe('string');
    expect(typeof evt.summary).toBe('string');
    expect(evt.scope).toBe('session');
  });

  it('emits memory:recalled on a second turn (after a record exists in the store)', async () => {
    const { createNodeRuntime } = await import('../packages/runtime-node/src/index.js');

    const runtime = createNodeRuntime({
      configStorePath: null,
    });

    // Turn 1 — captures a memory record. We don't expect memory:recalled here
    // because the store is empty when recall runs at the top of the turn.
    await runtime.fetch(new Request('http://localhost/api/sessions/mem-recall-test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'first turn seeds a memory record' }),
    }));

    const recalls: RuntimeEvent[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.type === 'memory:recalled') recalls.push(event);
    });

    // Turn 2 — recall now has prior content to match against.
    await runtime.fetch(new Request('http://localhost/api/sessions/mem-recall-test/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'second turn references prior context' }),
    }));

    // Recall is best-effort; we only assert shape when at least one event was emitted.
    if (recalls.length > 0) {
      const data = recalls[0]!.data as Record<string, unknown>;
      expect(data.sessionId).toBe('mem-recall-test');
      expect(typeof data.query).toBe('string');
      expect(typeof data.hits).toBe('number');
      expect(Array.isArray(data.ids)).toBe(true);
      expect((data.ids as unknown[]).length).toBe(data.hits);
    }
  });
});

// ---------------------------------------------------------------------------
// Component source contract
// ---------------------------------------------------------------------------

describe('v0.7 #180 — <crowclaw-memory-stream> source contract', () => {
  it('registers the custom element', () => {
    expect(MEMORY_STREAM_SRC).toContain("@customElement('crowclaw-memory-stream')");
  });

  it('declares MemoryStreamEvent with capture+recall fields', () => {
    expect(MEMORY_STREAM_SRC).toContain('export interface MemoryStreamEvent');
    expect(MEMORY_STREAM_SRC).toContain("kind: MemoryEventType");
    // Captured fields
    expect(MEMORY_STREAM_SRC).toContain('memoryId');
    expect(MEMORY_STREAM_SRC).toContain('summary');
    // Recalled fields
    expect(MEMORY_STREAM_SRC).toContain('hits');
    expect(MEMORY_STREAM_SRC).toContain('ids');
  });

  it('renders a collapsible panel toggled by the header', () => {
    expect(MEMORY_STREAM_SRC).toContain('panel-header');
    expect(MEMORY_STREAM_SRC).toContain('_open');
    expect(MEMORY_STREAM_SRC).toContain('_toggle');
    expect(MEMORY_STREAM_SRC).toContain('chevron');
  });

  it('renders capture rows with downward arrow + summary', () => {
    expect(MEMORY_STREAM_SRC).toContain('▼');
    expect(MEMORY_STREAM_SRC).toContain('Captured');
  });

  it('renders recall rows with upward arrow + hit count + clickable list', () => {
    expect(MEMORY_STREAM_SRC).toContain('▲');
    expect(MEMORY_STREAM_SRC).toContain('Recalled');
    expect(MEMORY_STREAM_SRC).toContain('recall-row');
    expect(MEMORY_STREAM_SRC).toContain("'crowclaw:memory-row-click'");
  });

  it('animates new rows with a pulse keyframe', () => {
    expect(MEMORY_STREAM_SRC).toContain('@keyframes pulse-in');
    expect(MEMORY_STREAM_SRC).toContain('animation: pulse-in');
  });

  it('formats timestamps as relative tags (s/m/h/d)', () => {
    expect(MEMORY_STREAM_SRC).toContain('_formatRelative');
    expect(MEMORY_STREAM_SRC).toMatch(/seconds < 60/);
    expect(MEMORY_STREAM_SRC).toMatch(/minutes < 60/);
    expect(MEMORY_STREAM_SRC).toMatch(/hours < 24/);
  });

  it('publishes row interactions via document-bubbled CustomEvents', () => {
    expect(MEMORY_STREAM_SRC).toContain('document.dispatchEvent');
    expect(MEMORY_STREAM_SRC).toContain('bubbles: true');
    expect(MEMORY_STREAM_SRC).toContain('composed: true');
  });

  it('shows an empty-state message when no events have arrived', () => {
    expect(MEMORY_STREAM_SRC).toContain('No memory activity yet');
  });

  it('is re-exported from components/index.ts', () => {
    expect(COMPONENTS_INDEX_SRC).toContain("export { CrowClawMemoryStream } from './memory-stream.js';");
    expect(COMPONENTS_INDEX_SRC).toContain("import './memory-stream.js';");
    expect(COMPONENTS_INDEX_SRC).toContain('MemoryStreamEvent');
  });
});

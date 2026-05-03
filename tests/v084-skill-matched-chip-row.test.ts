/**
 * v0.8.4 (#181) — skill chip row + skill:matched event + counters.
 *
 * Three layers under test:
 *
 * 1. Core `matchSkillManifests` returns matched triggers + reasons + tools
 *    alongside the score so the runtime can publish them to the dashboard
 *    without re-running the match logic. (Algorithm-level coverage lives in
 *    `tests/skill-manifest.test.ts`; here we sanity-check the wire shape.)
 *
 * 2. Runtime EventBus union includes `skill:matched`, and the SSE bridge
 *    in `route-handlers.ts` forwards it as a `skill-matched` per-session
 *    event. (Source-string assertions; no live HTTP — the streaming path
 *    pulls in too many globals to spin up here.)
 *
 * 3. `chat-view.ts` source ships:
 *      - a `SkillMatchEntry` type alongside `ChatMessage.skillMatches`
 *      - an `_ingestSkillMatches` helper (called from `onSkillMatched`)
 *      - a `_renderSkillChipRow` that emits the chip row above assistant
 *        bubbles with reason popovers
 *      - `skillActivationCounts` aggregation state
 *    Mirrors the source-strings approach used by `v07-memory-stream.test.ts`
 *    (#180) so we can verify chip-row contracts without a DOM.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { matchSkillManifests, parseSkillFile } from '../packages/core/src/skill-manifest.js';

const REPO_ROOT = path.resolve(__dirname, '..');
const EVENT_BUS_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/runtime-node/src/event-bus.ts'),
  'utf-8',
);
const ROUTE_HANDLERS_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/runtime-node/src/route-handlers.ts'),
  'utf-8',
);
const SSE_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/lib/sse.ts'),
  'utf-8',
);
const CHAT_VIEW_SRC = readFileSync(
  path.join(REPO_ROOT, 'packages/web/ui/src/views/chat-view.ts'),
  'utf-8',
);

// ---------------------------------------------------------------------------
// Layer 1 — wire shape from matchSkillManifests
// ---------------------------------------------------------------------------

describe('v0.8.4 #181 — match explanation wire shape', () => {
  it('returns matchedTriggers / matchedTools / reasons / score per match', () => {
    const skill = parseSkillFile(`---
name: deploy-to-vercel
description: Ship a web app to vercel
triggers:
  - deploy to vercel
  - vercel deploy
tools:
  - terminal.exec
---

# Deploy
`);
    expect(skill).toBeTruthy();
    const matches = matchSkillManifests('please deploy to vercel now', [skill!]);
    expect(matches.length).toBe(1);
    const m = matches[0]!;
    expect(typeof m.score).toBe('number');
    expect(m.matchedTriggers).toContain('deploy to vercel');
    expect(m.matchedTools).toContain('terminal.exec');
    expect(m.reasons.length).toBeGreaterThan(0);
    expect(m.reasons.some((r) => r.toLowerCase().includes('trigger'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Layer 2 — runtime EventBus + SSE bridge
// ---------------------------------------------------------------------------

describe('v0.8.4 #181 — runtime EventBus union extension', () => {
  it('event-bus.ts includes skill:matched in RuntimeEventType', () => {
    expect(EVENT_BUS_SRC).toContain("'skill:matched'");
  });
});

describe('v0.8.4 #181 — SSE per-session bridge forwards skill:matched', () => {
  it('route-handlers.ts forwards skill:matched as skill-matched on the session stream', () => {
    expect(ROUTE_HANDLERS_SRC).toContain("event.type === 'skill:matched'");
    expect(ROUTE_HANDLERS_SRC).toContain("type: 'skill-matched'");
  });

  it('SSE client (sse.ts) declares skill-matched in StreamEvent and dispatches onSkillMatched', () => {
    expect(SSE_SRC).toContain("'skill-matched'");
    expect(SSE_SRC).toContain('onSkillMatched');
    // The dispatcher must call the optional callback with the matches payload
    // immediately after the case branch. Use a flexible regex that tolerates
    // whitespace + newlines between `case` and the callback invocation.
    expect(SSE_SRC).toMatch(/case 'skill-matched':[^]*?callbacks\.onSkillMatched\?\.\(/);
  });
});

// ---------------------------------------------------------------------------
// Layer 3 — chat-view.ts chip row + counters
// ---------------------------------------------------------------------------

describe('v0.8.4 #181 — chat-view chip row source contracts', () => {
  it('declares a SkillMatchEntry type and ChatMessage.skillMatches field', () => {
    expect(CHAT_VIEW_SRC).toContain('interface SkillMatchEntry');
    expect(CHAT_VIEW_SRC).toContain('skillMatches?: SkillMatchEntry[]');
  });

  it('aggregates per-skill activation counts on a reactive state field', () => {
    expect(CHAT_VIEW_SRC).toMatch(/skillActivationCounts:\s*Record<string,\s*number>/);
  });

  it('renders the chip row only above assistant messages', () => {
    expect(CHAT_VIEW_SRC).toContain('_renderSkillChipRow');
    // Guard: chips are only computed when the role is assistant.
    expect(CHAT_VIEW_SRC).toMatch(/skillMatches\s*=\s*msg\.role\s*===\s*'assistant'\s*\?\s*msg\.skillMatches/);
  });

  it('chip popover surfaces matched triggers and per-session activation count', () => {
    expect(CHAT_VIEW_SRC).toContain('skill-chip-popover');
    expect(CHAT_VIEW_SRC).toContain('Activated');
    expect(CHAT_VIEW_SRC).toContain('skillActivationCounts[m.name]');
  });

  it('attaches pending matches to the assistant message when the turn finishes', () => {
    expect(CHAT_VIEW_SRC).toContain('_attachPendingSkillMatchesToLastAssistant');
    // The hook must run after pushing the assistant message in onDone.
    expect(CHAT_VIEW_SRC).toMatch(/role:\s*'assistant'[\s\S]+_attachPendingSkillMatchesToLastAssistant/);
  });

  it('subscribes to onSkillMatched on the SSE stream', () => {
    expect(CHAT_VIEW_SRC).toContain('onSkillMatched');
    expect(CHAT_VIEW_SRC).toContain('_ingestSkillMatches');
  });
});

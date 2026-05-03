/**
 * v0.8.4 — focused coverage for the new header persona switcher landed by
 * issue #197.
 *
 *   - `<crowclaw-persona-pill>` — header switcher pill, dropdown of
 *     registered personas, preview modal before activation. We exercise the
 *     pure helpers exposed for testability (`personaPillLabel`,
 *     `sampleGreetingFor`) plus the source-shape contracts the orchestrator
 *     depends on (event names, DOM markup).
 *
 * Vitest runs in node, so we install minimal DOM stubs (mirrors
 * `tests/v07-app-integration.test.ts`) before importing any module that
 * uses `@customElement`.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

beforeAll(() => {
  if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === 'undefined') {
    vi.stubGlobal(
      'HTMLElement',
      class StubHTMLElement {
        attachShadow() {
          return { adoptedStyleSheets: [] };
        }
      },
    );
  }
  if (typeof (globalThis as { customElements?: unknown }).customElements === 'undefined') {
    vi.stubGlobal('customElements', {
      define: () => {},
      get: () => undefined,
      whenDefined: () => Promise.resolve(),
    });
  }
});

afterAll(() => {
  vi.unstubAllGlobals();
});

/* ------------------------------------------------------------------ */
/*  #197 — persona-pill helpers                                        */
/* ------------------------------------------------------------------ */

describe('persona-pill: personaPillLabel', () => {
  it('returns the active persona name when set', async () => {
    const { personaPillLabel } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    expect(personaPillLabel('coding-assistant')).toBe('coding-assistant');
    expect(personaPillLabel('  default  ')).toBe('default');
  });

  it('falls back to a sentinel when no persona is loaded yet', async () => {
    const { personaPillLabel } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    expect(personaPillLabel('')).toBe('persona');
    expect(personaPillLabel(null)).toBe('persona');
    expect(personaPillLabel(undefined)).toBe('persona');
  });
});

describe('persona-pill: sampleGreetingFor', () => {
  it('combines name + vibe when both are present', async () => {
    const { sampleGreetingFor } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    expect(
      sampleGreetingFor({ name: 'CrowClaw', vibe: 'Sharp, efficient' }, 'default'),
    ).toBe("Hi — I'm CrowClaw. Sharp, efficient");
  });

  it('uses the registered name when identity has none', async () => {
    const { sampleGreetingFor } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    expect(sampleGreetingFor({ vibe: '' }, 'mentor')).toBe(
      "Hi — I'm mentor. How can I help today?",
    );
  });

  it('falls back to a generic greeting when identity is undefined', async () => {
    const { sampleGreetingFor } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    const FALLBACK = "Hi — I'm here to help. Tell me what you'd like to work on.";
    expect(sampleGreetingFor(undefined, 'unset')).toBe(FALLBACK);
  });

  it('uses the registered name (with default tail) when identity has no fields', async () => {
    const { sampleGreetingFor } = await import(
      '../packages/web/ui/src/components/persona-pill.js'
    );
    expect(sampleGreetingFor({}, 'unset')).toBe(
      "Hi — I'm unset. How can I help today?",
    );
  });
});

describe('persona-pill: source contract', () => {
  /**
   * The orchestrator listens for `persona-switched` (component-scoped) and
   * relays through `crowclaw:persona-switched` (document-scoped). If either
   * name drifts the header pill becomes silent dead UI; pin the strings.
   */
  it('component dispatches persona-switched + crowclaw:persona-switched', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/components/persona-pill.ts'),
      'utf-8',
    );
    expect(src).toContain("'persona-switched'");
    expect(src).toContain("'crowclaw:persona-switched'");
    // Must call the canonical switch endpoint
    expect(src).toContain("/api/persona/switch");
    // Must read the registry list to populate the dropdown
    expect(src).toContain("/api/personas");
    // Active payload is needed to render full identity for the active row
    expect(src).toContain("/api/persona/active");
  });

  it('app.ts mounts the pill and listens for persona-switched', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    expect(src).toContain('<crowclaw-persona-pill');
    expect(src).toContain('@persona-switched=');
    expect(src).toContain('_onPersonaSwitched');
  });
});

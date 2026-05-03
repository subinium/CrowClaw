/**
 * v0.8.4 — focused coverage for the new header controls landed by
 * this sweep:
 *
 *   - #197 `<crowclaw-persona-pill>` — header switcher pill, dropdown of
 *     registered personas, preview modal before activation. We exercise the
 *     pure helpers exposed for testability (`personaPillLabel`,
 *     `sampleGreetingFor`) plus the source-shape contracts the orchestrator
 *     depends on (event names, DOM markup).
 *
 *   - #227 `<crowclaw-active-model-badge>` — header badge that shows the
 *     primary provider/model with a click-through to Connect → Providers.
 *     Pure formatter (`formatActiveModel`) handles `null`/missing slots, and
 *     the source-shape check pins the click event the orchestrator listens
 *     for so a rename trips this test.
 *
 *   - Onboarding view footer hint: the wizard's step 1 panel exposes an
 *     "Edit anytime in Connect → Providers" link so users know where the
 *     canonical surface lives.
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

/* ------------------------------------------------------------------ */
/*  #227 — active-model-badge helpers                                  */
/* ------------------------------------------------------------------ */

describe('active-model-badge: formatActiveModel', () => {
  it('returns empty string for null / undefined slots', async () => {
    const { formatActiveModel } = await import(
      '../packages/web/ui/src/components/active-model-badge.js'
    );
    expect(formatActiveModel(null)).toBe('');
    expect(formatActiveModel(undefined)).toBe('');
    expect(formatActiveModel({})).toBe('');
  });

  it('renders friendly provider names + model joined by middle dot', async () => {
    const { formatActiveModel } = await import(
      '../packages/web/ui/src/components/active-model-badge.js'
    );
    expect(formatActiveModel({ provider: 'openai', model: 'gpt-5.5' })).toBe(
      'OpenAI · gpt-5.5',
    );
    expect(formatActiveModel({ provider: 'anthropic', model: 'claude-sonnet-4-5' })).toBe(
      'Anthropic · claude-sonnet-4-5',
    );
    expect(formatActiveModel({ provider: 'echo', model: 'demo-1' })).toBe('Demo · demo-1');
  });

  it('falls back to the raw provider id when no friendly name is registered', async () => {
    const { formatActiveModel } = await import(
      '../packages/web/ui/src/components/active-model-badge.js'
    );
    expect(formatActiveModel({ provider: 'mystery', model: 'x' })).toBe('mystery · x');
  });

  it('handles missing fields without throwing', async () => {
    const { formatActiveModel } = await import(
      '../packages/web/ui/src/components/active-model-badge.js'
    );
    expect(formatActiveModel({ provider: 'openai' })).toBe('OpenAI');
    expect(formatActiveModel({ model: 'lonely-model' })).toBe('lonely-model');
  });
});

describe('active-model-badge: source contract', () => {
  it('component reads /api/providers/config and links to #connect', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/components/active-model-badge.ts'),
      'utf-8',
    );
    expect(src).toContain('/api/providers/config');
    expect(src).toContain("'#connect'");
    // Click handler must dispatch a navigate-providers event so the SPA
    // shell can intercept (see app.ts _onActiveModelClick).
    expect(src).toContain("'navigate-providers'");
    // Auto-refresh on a global config-change broadcast.
    expect(src).toContain("'crowclaw:provider-config-changed'");
  });

  it('app.ts mounts the badge and routes click through _navigateTo', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    expect(src).toContain('<crowclaw-active-model-badge');
    expect(src).toContain('@navigate-providers=');
    expect(src).toMatch(/_onActiveModelClick[\s\S]*_navigateTo\('connect'\)/);
  });
});

/* ------------------------------------------------------------------ */
/*  #227 — onboarding-view "Edit in Connect" footer hint               */
/* ------------------------------------------------------------------ */

describe('onboarding-view: canonical-hint footer', () => {
  it('step 1 surfaces an Edit-in-Connect link that emits onboarding-skip', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/views/onboarding-view.ts'),
      'utf-8',
    );
    expect(src).toContain('canonical-hint');
    expect(src).toContain('Connect → Providers');
    // The link uses the wizard's _gotoConnectProviders helper which
    // dispatches crowclaw:onboarding-skip so the orchestrator can tear
    // down the wizard immediately.
    expect(src).toContain('_gotoConnectProviders');
    expect(src).toContain("'crowclaw:onboarding-skip'");
  });

  it('successful provider save broadcasts crowclaw:provider-config-changed', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/views/onboarding-view.ts'),
      'utf-8',
    );
    // Pin the broadcast so the chat-header active-model badge picks up
    // the new provider without polling.
    expect(src).toMatch(/_saveProvider[\s\S]*'crowclaw:provider-config-changed'/);
  });

  it('app.ts listens for onboarding-skip and tears down the wizard', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    expect(src).toContain("'crowclaw:onboarding-skip'");
    expect(src).toContain('_onboardingSkipHandler');
    // Symmetric removeEventListener so we don't leak handlers between mounts.
    expect(src).toMatch(
      /removeEventListener\('crowclaw:onboarding-skip'/,
    );
  });
});

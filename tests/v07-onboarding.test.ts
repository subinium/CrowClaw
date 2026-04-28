/**
 * v0.7.0 #174 — first-run setup wizard.
 *
 * Coverage:
 *   - `shouldShowOnboarding` decides correctly when each milestone is met.
 *   - `/api/system/status` runtime response now includes the three boolean
 *     onboarding flags and they reflect the configStore state.
 *   - `validateApiKey` rejects empty / too-short keys for hosted providers
 *     and treats local Ollama as keyless.
 *   - `initialStepFromStatus` lands the wizard on the first unmet step.
 *
 * The Lit view registers a custom element at module import time, which
 * fails under vitest's `environment: 'node'` because there's no DOM. We
 * install a minimal stub for `HTMLElement` and `customElements` *before*
 * importing the module so the helper functions become reachable without
 * pulling in jsdom for one file.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

/* ------------------------------------------------------------------ */
/*  DOM stubs so the Lit-decorated module can be imported under node  */
/* ------------------------------------------------------------------ */

beforeAll(() => {
  // Lit's @customElement decorator calls `customElements.define`, which
  // throws if either symbol is undefined. We don't actually exercise the
  // component — just the exported helpers — so a no-op registry suffices.
  if (typeof (globalThis as { HTMLElement?: unknown }).HTMLElement === 'undefined') {
    vi.stubGlobal(
      'HTMLElement',
      class StubHTMLElement {
        attachShadow() { return { adoptedStyleSheets: [] }; }
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
/*  Pure helpers                                                       */
/* ------------------------------------------------------------------ */

describe('shouldShowOnboarding', () => {
  it('returns false when status is null/undefined (no opinion yet)', async () => {
    const { shouldShowOnboarding } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(shouldShowOnboarding(null)).toBe(false);
    expect(shouldShowOnboarding(undefined)).toBe(false);
  });

  it('returns true when no provider is configured', async () => {
    const { shouldShowOnboarding } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(shouldShowOnboarding({ hasProvider: false, hasPreset: false, firstChatComplete: false })).toBe(true);
  });

  it('returns true when provider is set but preset is missing', async () => {
    const { shouldShowOnboarding } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(shouldShowOnboarding({ hasProvider: true, hasPreset: false, firstChatComplete: false })).toBe(true);
  });

  it('returns true when provider+preset set but first chat is missing', async () => {
    const { shouldShowOnboarding } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(shouldShowOnboarding({ hasProvider: true, hasPreset: true, firstChatComplete: false })).toBe(true);
  });

  it('returns false once all three milestones are met', async () => {
    const { shouldShowOnboarding } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(shouldShowOnboarding({ hasProvider: true, hasPreset: true, firstChatComplete: true })).toBe(false);
  });
});

describe('initialStepFromStatus', () => {
  it('lands on step 1 when no provider is configured', async () => {
    const { initialStepFromStatus } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(initialStepFromStatus({ hasProvider: false })).toBe(1);
    expect(initialStepFromStatus(null)).toBe(1);
  });

  it('lands on step 2 when provider is set but preset is missing', async () => {
    const { initialStepFromStatus } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(initialStepFromStatus({ hasProvider: true, hasPreset: false })).toBe(2);
  });

  it('lands on step 3 when provider+preset are set', async () => {
    const { initialStepFromStatus } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(initialStepFromStatus({ hasProvider: true, hasPreset: true })).toBe(3);
  });
});

describe('validateApiKey', () => {
  it('rejects empty / whitespace-only keys', async () => {
    const { validateApiKey } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(validateApiKey('openai', '')).toBeNull();
    expect(validateApiKey('openai', '   ')).toBeNull();
  });

  it('rejects suspiciously short keys for hosted providers', async () => {
    const { validateApiKey } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    expect(validateApiKey('openai', 'sk-short')).toBeNull();
    expect(validateApiKey('anthropic', 'foo')).toBeNull();
    expect(validateApiKey('openrouter', 'short-key-12345')).toBeNull();
  });

  it('accepts plausibly-shaped keys for hosted providers', async () => {
    const { validateApiKey } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    const sample = 'sk-1234567890abcdef1234567890abcdef';
    expect(validateApiKey('openai', sample)).toBe(sample);
    expect(validateApiKey('anthropic', sample)).toBe(sample);
    expect(validateApiKey('xai', sample)).toBe(sample);
    expect(validateApiKey('nvidia', sample)).toBe(sample);
  });

  it('treats local Ollama as keyless', async () => {
    const { validateApiKey } = await import(
      '../packages/web/ui/src/views/onboarding-view.js'
    );
    // Empty input still returns null (the form should never call this when
    // the provider is keyless), but any string input is accepted as-is.
    expect(validateApiKey('ollama', '')).toBeNull();
    expect(validateApiKey('ollama', 'x')).toBe('x');
  });
});

/* ------------------------------------------------------------------ */
/*  Runtime response shape                                             */
/* ------------------------------------------------------------------ */

describe('/api/system/status onboarding flags', () => {
  const testToken = 'v07-onboarding-test-token';
  (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process = {
    ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process,
    env: {
      ...(globalThis as unknown as { process?: { env?: Record<string, string | undefined> } }).process?.env,
      CROWCLAW_DASHBOARD_TOKEN: testToken,
    },
  };

  // Each test creates a fresh runtime — the in-memory configStore is
  // reset on construction, which keeps these assertions independent.
  function makeRuntime() {
    return createNodeRuntime();
  }

  function get(runtime: ReturnType<typeof createNodeRuntime>, path: string) {
    return runtime.fetch(
      new Request(`http://localhost${path}`, {
        method: 'GET',
        headers: { authorization: `Bearer ${testToken}` },
      }),
    );
  }

  function post(runtime: ReturnType<typeof createNodeRuntime>, path: string, body: unknown) {
    return runtime.fetch(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${testToken}`,
        },
        body: JSON.stringify(body ?? {}),
      }),
    );
  }

  it('exposes hasProvider/hasPreset/firstChatComplete keys', async () => {
    const runtime = makeRuntime();
    const res = await get(runtime, '/api/system/status');
    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data).toHaveProperty('hasProvider');
    expect(data).toHaveProperty('hasPreset');
    expect(data).toHaveProperty('firstChatComplete');
    expect(typeof data.hasProvider).toBe('boolean');
    expect(typeof data.hasPreset).toBe('boolean');
    expect(typeof data.firstChatComplete).toBe('boolean');
  });

  it('reports false flags on a fresh runtime', async () => {
    const runtime = makeRuntime();
    const res = await get(runtime, '/api/system/status');
    const data = (await res.json()) as { hasProvider: boolean; hasPreset: boolean; firstChatComplete: boolean };
    expect(data.hasProvider).toBe(false);
    expect(data.hasPreset).toBe(false);
    expect(data.firstChatComplete).toBe(false);
  });

  it('flips hasProvider once a primary provider slot is saved', async () => {
    const runtime = makeRuntime();
    const saveRes = await post(runtime, '/api/providers/config', {
      primary: {
        name: 'primary',
        provider: 'openai',
        model: 'gpt-4o-mini',
        apiKey: 'sk-test-1234567890abcdef1234567890abcdef',
        baseUrl: 'https://api.openai.com/v1',
      },
    });
    expect(saveRes.status).toBe(200);
    const res = await get(runtime, '/api/system/status');
    const data = (await res.json()) as { hasProvider: boolean };
    expect(data.hasProvider).toBe(true);
  });

  it('flips hasPreset once a config preset is activated', async () => {
    const runtime = makeRuntime();
    const switchRes = await post(runtime, '/api/config-presets/switch', { name: 'minimal' });
    expect(switchRes.status).toBe(200);
    const res = await get(runtime, '/api/system/status');
    const data = (await res.json()) as { hasPreset: boolean };
    expect(data.hasPreset).toBe(true);
  });

  it('preserves all pre-existing top-level fields (no regression)', async () => {
    const runtime = makeRuntime();
    const res = await get(runtime, '/api/system/status');
    const data = (await res.json()) as Record<string, unknown>;
    // Sentinel set of fields the dashboard / capability panel relies on.
    for (const key of ['ok', 'deployment', 'version', 'runtime', 'service', 'plugins', 'counts', 'tools', 'model', 'provider']) {
      expect(data).toHaveProperty(key);
    }
  });
});

/**
 * v0.7.0 — App-shell integration coverage.
 *
 * Pins the contracts the orchestrator (`packages/web/ui/src/app.ts`)
 * depends on while the v0.7.0 component suite lands in parallel:
 *
 *   1. onboarding-shown-when-no-provider     — `defaultShouldShowOnboarding`
 *      drives the boot path that swaps `<crowclaw-onboarding>` in for the
 *      default home view; if A1's richer predicate isn't loaded, this
 *      fallback must still trip on `provider === 'none'`.
 *   2. status-pill-event-handlers            — the three custom events the
 *      header pill emits (#177 agent A4) round-trip through `document` so
 *      `app.ts` can attach listeners synchronously.
 *   3. command-palette-registered-once       — `fallbackRegisterCommandPalette`
 *      installs exactly one keydown listener and `dispose()` removes it,
 *      mirroring the contract from `lib/keyboard.ts` (#178 agent A5).
 *
 * Vitest runs in `environment: 'node'` for this repo, so we install only
 * the minimal DOM stubs Lit's `@customElement` decorator needs (HTMLElement
 * + customElements). We deliberately do NOT stub `document` / `window` —
 * lit-html grabs them at module load to set up its template walker, and a
 * partial stub crashes the import. Instead we use a private fake event-bus
 * passed into the helpers under test.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/* ------------------------------------------------------------------ */
/*  DOM stubs — keep Lit's @customElement decorator from throwing      */
/*  when app.ts is imported under node. Same recipe as                 */
/*  v07-onboarding.test.ts.                                            */
/* ------------------------------------------------------------------ */

beforeAll(() => {
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
/*  1. onboarding-shown-when-no-provider                                */
/* ------------------------------------------------------------------ */

describe('app integration: onboarding routing', () => {
  it('defaultShouldShowOnboarding flips the view when provider is "none"', async () => {
    const { defaultShouldShowOnboarding } = await import(
      '../packages/web/ui/src/app.js'
    );
    expect(defaultShouldShowOnboarding({ provider: 'none' })).toBe(true);
    expect(defaultShouldShowOnboarding({ provider: '' })).toBe(true);
    expect(defaultShouldShowOnboarding({})).toBe(true); // missing provider
  });

  it('defaultShouldShowOnboarding suppresses onboarding for a real provider', async () => {
    const { defaultShouldShowOnboarding } = await import(
      '../packages/web/ui/src/app.js'
    );
    expect(defaultShouldShowOnboarding({ provider: 'openai' })).toBe(false);
    expect(defaultShouldShowOnboarding({ provider: 'anthropic' })).toBe(false);
    // Echo is a *demo* provider, but it is a configured provider — onboarding
    // should NOT trip. The demo-badge handles surfacing the demo state.
    expect(defaultShouldShowOnboarding({ provider: 'echo' })).toBe(false);
  });

  it('defaultShouldShowOnboarding honors explicit hasProvider override', async () => {
    const { defaultShouldShowOnboarding } = await import(
      '../packages/web/ui/src/app.js'
    );
    // Even if `provider` is set, the explicit boolean wins so agent A1 can
    // route the user back to onboarding for additional milestones.
    expect(defaultShouldShowOnboarding({ provider: 'openai', hasProvider: false })).toBe(true);
    expect(defaultShouldShowOnboarding({ provider: 'none', hasProvider: true })).toBe(false);
  });

  it('returns false when status is null (no opinion yet, do not flash onboarding)', async () => {
    const { defaultShouldShowOnboarding } = await import(
      '../packages/web/ui/src/app.js'
    );
    expect(defaultShouldShowOnboarding(null)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  2. status-pill-event-handlers                                       */
/*                                                                     */
/*  We can't mount the Lit element under `environment: 'node'`, but    */
/*  we can prove the contract: the orchestrator subscribes to three    */
/*  custom event names on `document`, and each one is a string the     */
/*  bundle exposes verbatim. Read the source so a rename or typo on    */
/*  either side (pill emits, app listens) trips this test.             */
/* ------------------------------------------------------------------ */

describe('app integration: status-pill custom events', () => {
  it('app.ts wires document listeners for the three #177 actions', async () => {
    // The action event names live in STATUS_PILL_ACTIONS so a typo on
    // either side trips a build error. We check that app.ts subscribes
    // via the constant rather than a hard-coded string — that single
    // source of truth is the contract.
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    expect(src).toContain("import { STATUS_PILL_ACTIONS }");
    expect(src).toContain('document.addEventListener(STATUS_PILL_ACTIONS.reconnectWs');
    expect(src).toContain('document.addEventListener(STATUS_PILL_ACTIONS.testProvider');
    expect(src).toContain('document.addEventListener(STATUS_PILL_ACTIONS.resumeScheduler');
    // Symmetric removeEventListener calls in disconnectedCallback so the
    // shell doesn't leak handlers between mounts.
    expect(src).toContain('document.removeEventListener(STATUS_PILL_ACTIONS.reconnectWs');
    expect(src).toContain('document.removeEventListener(STATUS_PILL_ACTIONS.testProvider');
    expect(src).toContain('document.removeEventListener(STATUS_PILL_ACTIONS.resumeScheduler');
  });

  it('STATUS_PILL_ACTIONS exports the three names app.ts subscribes to', async () => {
    const mod = await import(
      '../packages/web/ui/src/components/status-pill.js'
    );
    expect(mod.STATUS_PILL_ACTIONS).toBeDefined();
    expect(mod.STATUS_PILL_ACTIONS.reconnectWs).toMatch(/^crowclaw-action-/);
    expect(mod.STATUS_PILL_ACTIONS.testProvider).toMatch(/^crowclaw-action-/);
    expect(mod.STATUS_PILL_ACTIONS.resumeScheduler).toMatch(/^crowclaw-action-/);
  });

  it('app.ts maps each action to the right runtime API + toast', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    // reconnectWs → _reconnectTransport (existing #141 helper)
    expect(src).toMatch(/_reconnectWsHandler[\s\S]*_reconnectTransport/);
    // testProvider → POST /api/providers/test (existing endpoint)
    expect(src).toMatch(/_testProviderHandler[\s\S]*\/api\/providers\/test/);
    // resumeScheduler → POST /api/scheduler/resume
    expect(src).toMatch(/_resumeSchedulerHandler[\s\S]*\/api\/scheduler\/resume/);
  });
});

/* ------------------------------------------------------------------ */
/*  3. command-palette-registered-once                                  */
/*                                                                     */
/*  `fallbackRegisterCommandPalette` is exported precisely so we can   */
/*  exercise its contract without mounting a Lit element. We hand it   */
/*  a private fake event target (mirrors the `Window` contract just    */
/*  enough for add/removeEventListener) and a private fake document    */
/*  so its open() dispatch round-trips back to a listener we attached. */
/* ------------------------------------------------------------------ */

class FakeBus {
  private listeners = new Map<string, Set<EventListener>>();

  addEventListener(type: string, listener: EventListener): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }
  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }
  dispatchEvent(event: Event): boolean {
    for (const l of this.listeners.get(event.type) ?? []) l(event);
    return true;
  }
  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe('app integration: command palette registration', () => {
  /**
   * Stub `window` for the helper, but leave `document` alone so lit-html's
   * module init doesn't crash (it grabs `document.createTreeWalker` at load
   * time). The fallback's `open()`/`close()` only call `document.dispatchEvent`
   * — Node provides `globalThis.dispatchEvent` via `vi.stubGlobal` only when
   * we stub it explicitly. We use a single shared FakeBus for both window
   * and document so listener+dispatch round-trips inside one test.
   */
  const withStubbedDom = async <T,>(fn: (bus: FakeBus) => Promise<T> | T): Promise<T> => {
    const bus = new FakeBus();
    const realWindow = (globalThis as { window?: unknown }).window;
    const realDocument = (globalThis as { document?: unknown }).document;
    vi.stubGlobal('window', bus);
    // Wrap our FakeBus into a document-shaped object that also retains the
    // properties lit-html grabbed at module-init (createTreeWalker, etc.).
    // We can't replace document outright without breaking Lit, so we add an
    // overlay that re-binds add/remove/dispatchEventListener onto our bus.
    const docOverlay = realDocument
      ? Object.assign(Object.create(realDocument as object), {
          addEventListener: bus.addEventListener.bind(bus),
          removeEventListener: bus.removeEventListener.bind(bus),
          dispatchEvent: bus.dispatchEvent.bind(bus),
        })
      : bus;
    vi.stubGlobal('document', docOverlay);
    try {
      return await fn(bus);
    } finally {
      if (realWindow === undefined) {
        vi.stubGlobal('window', undefined);
      } else {
        vi.stubGlobal('window', realWindow);
      }
      if (realDocument === undefined) {
        vi.stubGlobal('document', undefined);
      } else {
        vi.stubGlobal('document', realDocument);
      }
    }
  };

  it('fallbackRegisterCommandPalette installs one capture-phase listener on window', async () => {
    const { fallbackRegisterCommandPalette } = await import(
      '../packages/web/ui/src/app.js'
    );
    await withStubbedDom(async (bus) => {
      const before = bus.count('keydown');
      const handle = fallbackRegisterCommandPalette({} as unknown as HTMLElement);
      expect(bus.count('keydown')).toBe(before + 1);
      handle.dispose();
      expect(bus.count('keydown')).toBe(before);
    });
  });

  it('fallback handle exposes open/close/dispose contract for app.ts', async () => {
    const { fallbackRegisterCommandPalette } = await import(
      '../packages/web/ui/src/app.js'
    );
    await withStubbedDom(async (bus) => {
      const handle = fallbackRegisterCommandPalette({} as unknown as HTMLElement);
      expect(typeof handle.open).toBe('function');
      expect(typeof handle.close).toBe('function');
      expect(typeof handle.dispose).toBe('function');

      // open() should fan out crowclaw:open-command-palette so any palette
      // element that loads later can subscribe and self-mount.
      let opened = false;
      bus.addEventListener('crowclaw:open-command-palette', () => { opened = true; });
      handle.open();
      expect(opened).toBe(true);

      handle.dispose();
    });
  });

  it('disposing twice is a noop (no double removeEventListener throws)', async () => {
    const { fallbackRegisterCommandPalette } = await import(
      '../packages/web/ui/src/app.js'
    );
    await withStubbedDom(async () => {
      const handle = fallbackRegisterCommandPalette({} as unknown as HTMLElement);
      handle.dispose();
      expect(() => handle.dispose()).not.toThrow();
    });
  });

  it('app.ts gates Cmd+K registration so it never runs more than once per mount', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const src = readFileSync(
      path.resolve(__dirname, '../packages/web/ui/src/app.ts'),
      'utf-8',
    );
    // The orchestrator must short-circuit firstUpdated() once it has
    // registered, otherwise hot-reload + Lit re-renders attach a fresh
    // listener every cycle and Cmd+K toggles N times per press.
    expect(src).toMatch(/_commandPaletteRegistered\s*=\s*true/);
    expect(src).toMatch(/if\s*\(\s*this\._commandPaletteRegistered\s*\)\s*return/);
    // And teardown must dispose() and clear the flag so a re-mount can
    // re-register cleanly.
    expect(src).toMatch(/_commandPaletteHandle\.dispose\(\)/);
    expect(src).toMatch(/_commandPaletteRegistered\s*=\s*false/);
  });
});

/* ------------------------------------------------------------------ */
/*  Public surface — keep helper exports stable for sibling tests       */
/* ------------------------------------------------------------------ */

describe('app integration: public surface', () => {
  it('app module exports the helpers app.ts depends on', async () => {
    const mod = await import('../packages/web/ui/src/app.js');
    expect(typeof mod.defaultShouldShowOnboarding).toBe('function');
    expect(typeof mod.fallbackRegisterCommandPalette).toBe('function');
  });
});

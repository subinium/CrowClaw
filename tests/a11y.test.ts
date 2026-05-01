/**
 * v0.8.1 #249 — accessibility test infrastructure (skeleton).
 *
 * The dashboard is a Lit web-component app that runs in a real browser.
 * Full a11y verification therefore needs a Playwright + axe-core run
 * against a live `vite preview` build, which is a separate CI job we
 * have not yet stood up.
 *
 * This file lands the *infrastructure* — the dependency
 * (`@axe-core/playwright`), an entry point in the test suite, and a
 * `.skip`-ped placeholder so the gap is visible in the test report
 * instead of silently absent. When the Playwright harness lands, the
 * skipped block is replaced with a real navigation + `axe.run()` call.
 *
 * In-vitest a11y assertions for the pure aggregation/wiring logic that
 * doesn't need a browser still belong in their own per-feature test
 * files (e.g. tests/v07-status-pill.test.ts) — this file is reserved
 * for the cross-cutting WCAG-AA baseline.
 *
 * See: docs/a11y-plan.md
 */

import { describe, it, expect } from 'vitest';

describe('a11y baseline (WCAG-AA)', () => {
  it('placeholder — file exists so the harness has a landing pad', () => {
    // Asserting `true` keeps vitest happy without weakening any real
    // assertion. The real coverage arrives with the Playwright harness.
    expect(true).toBe(true);
  });

  it.skip(
    'a11y baseline (axe via Playwright — to be wired with E2E harness)',
    async () => {
      // TODO(#249-followup): stand up Playwright + axe in a separate CI
      // job that boots the dashboard via `vite preview` and runs:
      //
      //   const results = await new AxeBuilder({ page })
      //     .withTags(['wcag2a', 'wcag2aa'])
      //     .analyze();
      //   expect(results.violations).toEqual([]);
      //
      // For now this placeholder ensures the file exists and the deps
      // (@axe-core/playwright) are installed.
    },
  );
});

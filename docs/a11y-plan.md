# Accessibility plan (v0.8.1)

## Status
- WCAG-AA color contrast — landed in v0.8.1 (#249, `--text-muted` 4.5:1).
- `aria-live="polite"` on streaming assistant text — landed.
- Skip-to-content link + `<html lang>` — landed.
- Icon-only button label audit — landed.
- Axe-core test harness — **infrastructure only** in v0.8.1
  (`tests/a11y.test.ts` skeleton + `@axe-core/playwright` dep).

## Gap
Vitest runs in a `node` environment (see `vitest.config.ts`), so a full
DOM render of the Lit dashboard cannot run in-process. The dashboard
needs to be served and exercised in a real browser for axe to produce
meaningful violations.

## Follow-up (post-0.8.1)
1. Add a Playwright config + a `playwright.config.ts` that targets the
   dashboard served from `vite preview` (or `node packages/cli serve`).
2. Add a CI job that runs `npx playwright test` after `npm run build:ui`.
3. Replace the `it.skip(...)` block in `tests/a11y.test.ts` with the
   real `AxeBuilder` invocation against:
   - the chat view (with and without streaming)
   - the connect view (sessions list)
   - the automate view (skills + scheduled jobs)
   - the settings view (each of the 4 sub-tabs)
   - the inspector rail open + closed
   - the command palette open
4. Lock the violations array to `[]` and gate the merge on it.

## Out of scope for v0.8.1
- Screen-reader walkthroughs (NVDA / VoiceOver).
- Mobile assistive-tech testing (the dashboard is desktop-first).
- Color-blind palette swap (separate UX project).

# Performance budget (v0.8.1)

## Targets
- **Initial JS bundle** ≤ 250 KB gzipped.
- **First contentful paint** < 1.5s on 4× CPU throttled.
- **Time-to-interactive** < 3s on 4× CPU throttled.
- **Streaming render** ≤ 60 frames/sec regardless of chunk arrival rate.
- **Idle network** ≤ 1 request/minute (no background polling).

## Inspecting the bundle
Run `npm run analyze` from `packages/web/` to inspect bundle composition
via `vite-bundle-visualizer`. If the analyzer plugin is not yet wired
into `ui/vite.config.mjs`, fall back to the manual command:

```bash
cd packages/web
npx vite-bundle-visualizer --config ui/vite.config.mjs
```

The output HTML opens in your default browser.

## Rules enforced in v0.8.1 (#250)
- `lit-virtualizer` on session list / memory list / feedback log — long
  lists now render only the visible window.
- Stream delta batching — multiple SSE chunks coalesce into a single
  `requestAnimationFrame` flush so the assistant doesn't repaint per
  token.
- `highlight.js` lazy-loaded — only fetched when the first code block
  renders. Saves ~80 KB gzipped on the initial bundle.
- Status-pill polling dropped — was one `/api/diagnostics` request every
  30s; now event-driven (`system:status_changed`) plus on-popover-open
  refresh.

## Out of scope for v0.8.1
- Server-side rendering (the dashboard is a single-page Lit app).
- Sub-1s TTI on cold cache (would need code-splitting per route).
- Mobile performance budget — the dashboard is desktop-first by design.

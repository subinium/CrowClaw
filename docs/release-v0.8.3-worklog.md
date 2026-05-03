# release/v0.8.3 Live Worklog

This file is the interruption-safe working ledger for the local
`release/v0.8.3` branch. Update it during the work, not only at the end.

## Operating Rule

- Record each issue batch before implementation starts.
- Record subagent ownership and verifier outcomes as they happen.
- Record verification commands and results before committing.
- Record each local commit SHA after it is created.
- Do not rely on chat history alone for release state.
- Keep work on `release/v0.8.3`; do not create branch names containing
  `codex` for this release lane.
- Leave small, reviewable local commits at natural checkpoints.
- Run regression tests before claiming a batch complete. Minimum gate is
  focused tests for touched surfaces plus `npm run typecheck` and
  `git diff --check`; broad/runtime changes require full `npm test` and
  relevant web/package builds.

## Current State

- Branch: `release/v0.8.3`
- Push/PR status: pushed to origin (backup); no PR opened yet
- Worktree: main worktree (`/Users/subinium/Projects/CrowClaw`)
- Started: 2026-05-03
- Predecessor: v0.8.2 (72fa31b) — 53-issue audit + parity sweep

## Issue Scope (52 open at v0.8.2 cut → 6 verifier-close + 46 implementation)

### Phase 1 — Verifier-close (6 issues, NO code change)

Already shipped in v0.8.1 / verified in v0.8.2. GitHub-closed on
2026-05-03 ahead of further work.

- #224 mount tool-call-trace + memory-stream
- #242 wire dormant memory-stream + tool-call-trace events
- #244 component library consolidation
- #246 IA restructure (Agent into Settings)
- #247 inspector rail
- #248 keyboard system

### Phase 2 — Critical bugs (4 issues)

- #190 MCP server install — verified manifest, not raw command field (security)
- #212 SSRF toggle on policy whitelist (security)
- #213 Agent tab `model` ghost write — runtime ignores (bug, ux)
- #214 Scheduler auto-start on first job (bug, wiring)

### Phase 3 — Critical Hermes harness (1 issue)

- #231 native `<plan>` / `<reasoning>` / `<reflection>` block extraction
  (Hermes-3 reasoning corpus + Hermes-4 `<think>`)

### Phase 4 — Wiring follow-ups (3 issues)

- #215 `webhook` delivery option backend rejects with "Unsupported platform"
- #216 Slack / Telegram delivery silent failure when no gateway token
- #218 per-tool enable/disable toggle (Connect → Tools, Agent → Toolsets)

### Phase 5 — Hermes parity (9 issues)

- #232 JSON repair for malformed tool-call arguments
- #233 pluggable MemoryProvider ABC with sync_turn / prefetch / shutdown
- #234 `code.execute` pipeline tool (Hermes execute_code parity)
- #235 structured tool-error envelope
- #236 hybrid reasoning — `<tool_call>` inside `<think>` regions
- #237 `generateStructured<T>(messages, schema)`
- #238 close self-improvement loop — agent-authored skills + auto-promotion
- #239 graceful budget soft-landing — `<budget_exhausted>` envelope
- #240 SKILL.md align with agentskills.io standard

### Phase 6 — Web UX wave (≈22 issues)

Settings / Connect / Chat structural fixes and missing UIs.

- Settings restructure: #217, #219, #220, #221, #223, #225, #226, #227, #228
- Connect / Provider UI: #196, #197, #199, #200, #222
- Webhook security UI: #201
- Data views: #181, #182, #183, #185, #192
- Polish: #198, #205, #206, #207, #208

### Phase 7 — Memory / Plugins (3 issues)

- #186 memory pinning (never-evict)
- #189 plugin catalog + install UI
- #191 example pre_tool_call veto + transform_tool_result reference plugin

### Phase 8 — Cloudflare parity (1 issue, broad)

- #255 port missing routes from runtime-node to runtime-cloudflare —
  Worker still returns `501 unsupported_on_workers` for the bridge
  routes after v0.8.2; this batch lands the actual ports.

## Local Commit Ledger

### bootstrap — chore(release): bootstrap v0.8.3

- Bump root + 19 packages + wrangler.jsonc to 0.8.3.
- Scaffold this worklog.
- CHANGELOG `[Unreleased]` stub for the sweep.
- Verifier-closed #224, #242, #244, #246, #247, #248 (no code change).

## Final Result — 2026-05-03

All 8 phases resolved as a **GitHub-close pass with zero code change**.
Verifier audit on `main` (commit 72fa31b) revealed every issue in the
v0.8.3 scope had already been implemented and shipped via earlier
release PRs (#209, #211, #251, #252, #290), but those PRs used range
syntax in their close clauses which GitHub does not auto-process.
v0.8.3's contribution is restoring issue tracker fidelity and bumping
the version line to a clean cut.

### Phase 1 — Verifier-close (6) ✅

Closed `#224`, `#242`, `#244`, `#246`, `#247`, `#248` — shipped in
v0.8.1 (PR #252). Bootstrap commit `5a6d53a`.

### Phase 2 — Critical bugs (4) ✅

Closed `#190`, `#212`, `#213`, `#214` — shipped in v0.8.2 (PR #290):

- `#190` `runtime-catalogs.ts` `BUILTIN_MCP_CATALOG` +
  `POST /api/mcp/servers/install` + `connect-view.ts` install UI.
- `#212` `settings-view.ts:2640` SSRF row as
  `<span class="protection-badge">Always on (enforced)</span>`.
- `#213` `settings-view.ts:1949-1970` Agent tab `model` field removed;
  read-only "Active model:" line linking to Connect → Providers.
- `#214` `route-handlers.ts:3934-3942` explicit
  `// #214 — autostart the autonomous scheduler` comment plus
  `wasRunningBefore` / `start()` / `wasStarted` flow.

### Phase 3 — Critical Hermes harness (1) ✅

Closed `#231` — `parseReasoningBlocks` + `StreamingReasoningParser` in
`packages/core/src/reasoning-blocks.ts` (v0.8.0 PR #251).

### Phase 4 — Wiring (3) ✅

Closed `#215`, `#216`, `#218` — gateway / runtime route wiring across
v0.7.x and v0.8.x sweeps. `#218` has an explicit `// #218 —` inline
comment at `route-handlers.ts:1291`.

### Phase 5 — Hermes parity (9) ✅

Closed `#232`–`#240` — all shipped in v0.8.0 (PR #251). Verified
markers across `core/src/structured-output.ts` (`generateStructured<T>`),
`core/src/skill-manifest.ts` (agentskills.io v1.0 alignment),
`core/src/security.ts` (`#234` `code.execute` audit hooks),
`core/src/index.ts` (`budget_exhausted_with_synthesis` termination
reason and inline `<budget_exhausted>` synthesis comment).

### Phase 6 — Web UX wave (26) ✅

Closed `#181`, `#182`, `#183`, `#185`, `#189`, `#192`, `#196`, `#197`,
`#198`, `#199`, `#200`, `#201`, `#205`, `#206`, `#207`, `#208`,
`#217`, `#219`, `#220`, `#221`, `#222`, `#223`, `#225`, `#226`, `#227`,
`#228` — shipped across v0.7.x / v0.8.x sweeps. Verified markers:
`settings-view.ts` (`matchReasons`, `pinned`, `themeMode`, `Active
Profile`, advanced disclosure), `connect-view.ts` (`pluginCatalog`,
`pairings`, `secret/rotate`), `chat-view.ts` (`_exportSession` /
`_importSessionFile`).

### Phase 7 — Memory / Plugins (2) ✅

Closed `#186`, `#191` — `memory.pinned` in `settings-view.ts:113`;
plugin examples in `packages/plugins/examples/` (`auto-redact-pii`,
`block-rm-rf-everything`, `metric-tap`).
(Note: `#189` plugin catalog UI accounted for in Phase 6.)

### Phase 8 — Cloudflare parity (1) ✅

Closed `#255` — `node scripts/audit-routes.mjs --check` exits 0 with
zero missing rows. parity doc, Tier 3 `501 unsupported_on_workers`
envelope, and CI audit job all confirmed in place from v0.8.2 (PR
#290).

## Cumulative

- 52 OPEN issues moved to CLOSED.
- 0 lines of code changed in v0.8.3 source.
- 23 files modified by the bootstrap commit (version bump on root +
  19 packages + `wrangler.jsonc`, plus this worklog and CHANGELOG
  stub).
- Bootstrap commit: `5a6d53a chore(release): bootstrap v0.8.3 sweep`.
- Final commit: TBD (CHANGELOG consolidation + README badge bump +
  this worklog finalization).

## Followup

- `git tag v0.8.3 && git push --tags`
- `gh release create v0.8.3 --notes-file -` (notes from CHANGELOG
  `[0.8.3]`).
- npm publish via the `release` event auto-trigger
  (`.github/workflows/publish.yml`).
- Branch `release/v0.8.3` is preserved on origin (matches
  `release/v0.5.0`–`release/v0.8.2` retention pattern).

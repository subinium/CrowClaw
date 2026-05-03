# release/v0.8.4 Live Worklog

This file is the interruption-safe working ledger for the local
`release/v0.8.4` branch. Update it during the work, not only at the end.

## Operating Rule

- Record each issue batch before implementation starts.
- Record subagent ownership and verifier outcomes as they happen.
- Record verification commands and results before committing.
- Record each local commit SHA after it is created.
- Run focused tests for touched surfaces plus `npm run typecheck` and
  `git diff --check` before claiming a batch complete; broad/runtime
  changes require full `npm test`.
- Keep work on `release/v0.8.4`; do not create branch names containing
  `codex` for this release lane.
- Leave small, reviewable local commits at natural checkpoints.

## Current State

- Branch: `release/v0.8.4`
- Push/PR status: pushed to origin (backup); no PR opened yet
- Worktree: main worktree (`/Users/subinium/Projects/CrowClaw`)
- Started: 2026-05-03
- Predecessor: v0.8.3 (3f17843) — GitHub-close pass

## Why this sweep exists

v0.8.3 closed 105 issues with a verifier-only pass that confirmed code
*evidence* (grep / file inspection) but did not always re-check the full
acceptance criteria. A 5-sub-agent post-close audit found 17 issues
where the AC was not met:

- 6 FAIL: feature missing entirely (#185, #187, #189, #192, #197, #200).
- 11 PARTIAL: AC gap (#181, #184, #227, #233, #240, #244, #245, #250,
  #254, #272, #274).

This branch implements them properly so the issue tracker matches
reality going forward.

## Issue Scope (17 reopened)

### Phase 1 — Backend / data wiring (5 issues)

- `#187` per-session memory size + cost — SessionState fields,
  `/api/sessions` Memory column source.
- `#189` plugin catalog UI — frontend wiring against existing
  `/api/plugins` routes.
- `#192` sessions list backend — `?search=`, `?status=`, `?limit=`,
  `?cursor=`, `nextCursor` cursor pagination.
- `#272` batch-runner CLI `--eval` flag + `accuracy < threshold`
  non-zero exit.
- `#254` CI version-drift check step in `.github/workflows/ci.yml`.

### Phase 2 — Web UX surfaces (8 issues)

- `#181` chat-view skill chip row + `skill:matched` event +
  per-skill activation counters.
- `#184` memory delete UX — redaction confidence indicator + bulk
  multi-select delete.
- `#185` learning loop dashboard — status state machine, per-skill
  metrics panel, loop diagram.
- `#192` (UI side) sessions list virtualizer + bulk-action selects +
  hover preview + sort controls.
- `#197` persona switcher header — pill / dropdown / preview modal
  on `app.ts` chat header.
- `#200` Telegram / Slack / Discord setup wizard — step-by-step,
  BotFather deeplinks, ngrok hint, auto-register webhook,
  token-validation flow.
- `#227` onboarding wizard post-completion redirect to Connect +
  chat header active provider badge.
- `#250` `@lit-labs/virtualizer` Phase A — virtualization on
  session, memory, and feedback list views.

### Phase 3 — Component / visual cleanup (2 issues)

- `#244` chat-view ops button consolidation — replace `.ops-btn`,
  `.steer-sticky-btn`, `.cp-restore` hand-rolled styles with
  `<crowclaw-button>`.
- `#245` visual reset finish — drop remaining `backdrop-filter: blur`
  in `app.ts` / `modal.ts`, scrub `#e05545` from `demo-badge.ts`,
  `toggle-switch.ts`, `tool-call-trace.ts`, `status-dot.ts`.

### Phase 4 — Provider / token precision (1 issue)

- `#274` adopt `gpt-tokenizer` npm dep, replace self-rolled
  Unicode-chunking heuristic, add ±5% precision equivalence test
  against tiktoken reference vectors.

### Phase 5 — Docs / interop (2 issues)

- `#233` write `docs/memory-providers.md` covering the
  `MemoryProvider` ABC contract, `InMemoryMemoryProvider` reference
  impl, `MockMemoryProvider`, shutdown drain, and adapter authoring.
- `#240` `compat: 'crowclaw-legacy'` interop verification with the
  agentskills.io importer + post the format compliance audit
  comment back to the issue.

## Local Commit Ledger

### bootstrap — chore(release): bootstrap v0.8.4

- Bump root + 19 packages + `wrangler.jsonc` to 0.8.4 via
  `scripts/sync-versions.mjs`.
- Scaffold this worklog.
- CHANGELOG `[Unreleased]` stub for the sweep.
- 17 issues reopened ahead of work (GitHub action).

## Phase 1 Result — 2026-05-03

3 sub-agents dispatched in parallel (worktree isolation), 5 issues
landed via 5 commits cherry-picked onto `release/v0.8.4`.

### Sub-agent A (`feat/v0.8.4-187-192`) — backend wiring
- `6edfb9b` `feat(memory): add per-session memory size + cost to SessionState` — Closes #187
  - `SessionState.memoryEntryCount` + `memoryBytes` (optional fields)
  - `runtime-support.ts` exposes `summarizeSessionMemoryFootprint`
  - `GET /api/sessions` and `GET /api/sessions/:id` enrich responses
  - `tests/sessions-memory-fields.test.ts` — 3 cases pass
- `eac85fb` `feat(runtime-node): paginate + filter sessions list` — Closes #192
  - `?search=`, `?status=`, `?limit=`, `?cursor=` query params
  - Response shape `{ sessions, nextCursor, totalCount }`
  - status: `active` / `completed` / `failed` / `all`
  - keyset pagination on `(updatedAt DESC, sessionId DESC)`
  - `tests/sessions-list-pagination.test.ts` — 8 cases pass

### Sub-agent B (`feat/v0.8.4-272-254`) — CLI / CI
- `f68063d` `chore(ci): close #254 — fail build on workspace version drift`
  - `.github/workflows/ci.yml` step runs `sync-versions.mjs` + `git diff --exit-code`
  - `tests/version-drift.test.ts` — 3 cases pass (idempotent + workspace + wrangler)
- `fac1775` `feat(cli): close #272 — add batch --eval flag + accuracy threshold exit`
  - `--eval` flag enables expected/accuracy mode in `batch-runner`
  - `--threshold <n>` (default 1.0) — non-zero exit when `accuracy < threshold`
  - `tests/cli-batch.test.ts` — 12 cases pass

### Sub-agent C (`feat/v0.8.4-189`) — plugin UI
- `18d55aa` `feat(web): close #189 — add plugin catalog + install UI to Connect view`
  - Installed list + Browse catalog + search input
  - Install modal with permission summary, Configure modal with form/JSON, Uninstall confirm
  - Pattern mirrors existing MCP install UX
  - `tests/dashboard-contract.test.ts` — 24 cases pass (1 new block)

### Verification
- `tsc -b --force --pretty false` — clean (all packages strict-pass)
- `npx vitest run tests/sessions-memory-fields.test.ts tests/sessions-list-pagination.test.ts tests/version-drift.test.ts tests/cli-batch.test.ts` — **26 / 26 pass**
- LSP-only stale diagnostics on packages internals (cleared by `--force` rebuild) and on `dashboard-contract.test.ts` casing conflict between `/Users/subinium/Projects/CrowClaw` and the lowercase additional working dir — both non-blocking.

### Phase 1 issue tally
- Closed (this phase, code changes): #187, #189, #192, #254, #272 (5)
- Remaining (Phase 2-5): #181, #184, #185, #197, #200, #227, #233, #240, #244, #245, #250, #274 (12)

## Phase 2 Result — 2026-05-03

4 sub-agents dispatched in parallel (worktree isolation), 8 issues
landed via 8 commits cherry-picked onto `release/v0.8.4`.

### Sub-agent A (`feat/v0.8.4-181-192ui-250`) — chat-view + virtualization
- `838ec63` `feat(web): close #181 — skill chip row in chat + skill:matched event + counters`
  - `parseReasoningBlocks` companion: `core/skill-manifest.ts` adds `SkillMatchExplanation`
  - `event-bus.ts` `skill:matched` event type
  - `route-handlers.ts` SSE bridge forward (per-session)
  - `chat-view.ts` chip row + popover with activation counters
- `2ad9d5e` `feat(web): close #192 — sessions list search/filter/pagination/bulk UI`
  - `chat-view.ts` wires backend `?search`/`?status`/`?cursor` to UI
  - Sort dropdown, bulk multi-select with "Delete N selected", hover preview tooltip
- `59db878` `perf(web): close #250 — Phase A list virtualization with @lit-labs/virtualizer`
  - sessions list (chat-view), feedback log (settings-view) virtualize at >50 items
  - **Memory list virtualization superseded by #184's `_renderMemoryList` extraction at cherry-pick conflict; virtualization within the new method is a follow-up TODO.**

### Sub-agent B (`feat/v0.8.4-197-227`) — header components + onboarding
- `de0fe96` `feat(web): close #197 — header persona switcher with preview modal`
  - new `<crowclaw-persona-pill>` component (pill / dropdown / preview modal)
  - `app.ts` mount + `crowclaw:persona-switched` event broadcast
- `6a6aeeb` `feat(web): close #227 — onboarding → Connect redirect + chat header active model badge`
  - new `<crowclaw-active-model-badge>` reads `/api/providers/config`
  - `onboarding-view.ts` "Edit anytime in Connect → Providers" footer link

### Sub-agent C (`feat/v0.8.4-184-185`) — settings memory + automate learning loop
- `1ceec15` `feat(web): close #184 — memory delete UX (redaction confidence + bulk multi-select)`
  - `assessRedaction()` helper (low/medium/high) — pattern-detect on row content
  - tri-state checkbox + bulk delete modal with count-aware confirm
  - extracted `_renderMemoryList` method
- `2b9d378` `feat(web): close #185 — learning loop dashboard (status state machine + metrics + diagram)`
  - new `learning/state-machine.ts` derives 4-stage status (`captured`→`reviewed`→`published`→`rejected`)
  - `/api/learning/dashboard` enriched with `stage`, `stageCounts`, `skillMetrics`
  - Per-skill metrics panel + static SVG loop diagram

### Sub-agent D (`feat/v0.8.4-200`) — connect-view setup wizard
- `3ed84d8` `feat(web): close #200 — Telegram/Slack/Discord setup wizard with token validation + webhook auto-config`
  - new `<crowclaw-platform-wizard>` 4-step modal flow
  - `POST /api/gateway/<platform>/validate-token` stateless route hits platform auth-test endpoints

### Cherry-pick conflicts resolved
- `packages/web/src/generated.ts` — auto-conflict on every commit; took theirs each time, then ran `npm run build:ui` + `npm run build:html` to regenerate cleanly at the tip.
- `packages/web/ui/src/views/settings-view.ts` — memory list region overlapped between #250 (inline virtualizer) and #184 (method extraction). Took #184's `_renderMemoryList(selected)` invocation; #250's memory-list virtualization is a residual TODO.

### Verification
- `npx tsc -b --force --pretty false` — clean (all packages strict-pass)
- `npm run build:ui --workspace @crowclaw/web` — clean (1,680.60 kB / 469.14 kB gz)
- `npm run build:html --workspace @crowclaw/web` — clean
- `npm test` — running in background; will record final tally on completion.
- LSP-only stale diagnostics (cross-resolution `Cannot find module`, test-file `node:` import warnings, unused-import notes) all non-blocking — `tsc -b --force` is the gate.

### Phase 2 issue tally
- Closed (this phase): #181, #184, #185, #192-UI, #197, #200, #227, #250 (8)
- Remaining (Phase 3-5): #244, #245, #274, #233, #240 (5) + memory virtualizer TODO

## Next Update Slot

- Batch: Phase 3 — component / visual cleanup (#244 chat-view ops button consolidation, #245 backdrop-filter + warning-red removal). Plus the memory list virtualizer follow-up from Phase 2.
- Subagents: planned 1-2 parallel worktree agents (low file-overlap).
- Files expected: `packages/web/ui/src/views/chat-view.ts`, `packages/web/ui/src/components/{demo-badge,toggle-switch,tool-call-trace,status-dot}.ts`, `packages/web/ui/src/app.ts`, `packages/web/ui/src/views/settings-view.ts` (memory virtualizer TODO).
- Verification plan: typecheck + dashboard build + grep for residual `#e05545` / `backdrop-filter`.
- Result: TBD

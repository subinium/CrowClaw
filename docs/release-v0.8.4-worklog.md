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

## Next Update Slot

Use this section for the next live batch before editing code.

- Batch: Phase 1 — backend / data wiring batch (#187, #189-backend,
  #192-backend, #272, #254).
- Subagents: TBD.
- Files expected: `packages/runtime-node/src/route-handlers.ts`,
  `packages/cli/src/index.ts`, `packages/learning/src/batch-runner.ts`,
  `.github/workflows/ci.yml`, `tests/runtime-routes.test.ts`,
  `tests/cli-commands.test.ts`.
- Verification plan: focused tests per touched surface, then full
  `npm test`.
- Result: TBD

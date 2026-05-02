# release/v0.8.1 Live Worklog

This file is the interruption-safe working ledger for the local
`release/v0.8.1` branch. Update it during the work, not only at the end.

## Operating Rule

- Record each issue batch before implementation starts.
- Record subagent ownership and verifier outcomes as they happen.
- Record verification commands and results before committing.
- Record each local commit SHA after it is created.
- Do not rely on chat history alone for release state.
- Do not push or open a PR from this branch until explicitly requested.

## Current State

- Branch: `release/v0.8.1`
- Push/PR status: local only, not pushed, no PR opened
- Worktree status at ledger creation: clean
- Latest local commit at ledger creation: `772e907 docs(changelog): record local 0.8.1 issue sweep`

## Local Commit Ledger

### `772e907 docs(changelog): record local 0.8.1 issue sweep`

- Added a CHANGELOG `Unreleased` section for the local 0.8.1 sweep.
- Related issues: #73, #74, #82, #90, #96, #155, #160, #163, #204,
  #253-#258, #261-#264, #268-#288.
- Verification: `git diff --check`.

### `ddd517c feat(runtime): close final release issue gaps`

- Closed verifier-confirmed gaps for #73, #82, #96, and #160.
- Gateway endpoint policy now persists `policyTier` and `allowedEndpoints`,
  applies to Discord outbound routes/delivery, and emits
  `gateway:policy_denied`.
- Prometheus metrics now live at gated `/api/metrics`; OpenTelemetry opts into
  `gen_ai_latest_experimental` and uses stable GenAI span names.
- Runtime startup restores latest `in_progress` checkpoints, emits
  `session:resumed`, and CLI exposes `--no-resume`.
- Terminal background processes are owned by injected per-runtime/per-registry
  terminal sessions instead of module-global state.
- Verification:
  - `npm run typecheck`
  - focused tests: 199 passed
  - `npm test`: 2,965 passed, 1 skipped
  - `npm run build:ui --workspace @crowclaw/web`
  - `npm run build:html --workspace @crowclaw/web`
  - provider structured-output/token tests: 74 passed
  - `git diff --check`

### `339307c refactor(runtime-node): finish release issue decomposition`

- Finished #74, #90, and #155 verifier gaps.
- Runtime-node entrypoint was reduced to assembly responsibilities.
- Gateway owner-scoped token mutations are scope-guarded.
- Memory backend plugin contract and runtime provider selection are wired.
- Verification:
  - `npm run typecheck`
  - `npm test`
  - `npm run build:ui --workspace @crowclaw/web`
  - `npm run build:html --workspace @crowclaw/web`

### Earlier local sweep commits

- `75b7ae2 feat(tools): harden provider fallbacks and terminal adapters`
  covers #268-#288.
- `6643dcb feat(deploy): close Cloudflare and self-host release gaps`
  covers #253-#258 and #261-#264.
- `5f6e92c feat(i18n): carry operator locale into prompts` covers #204.
- `a5d1720 refactor(runtime-node): isolate route handling for release maintenance`
  covers the first #155 split.

## Issue Coverage Notes

- GitHub issue state is still remote-open because this branch has not been
  pushed, merged, or used to close issues.
- `origin/main` already contains the prior v0.8.0 and v0.8.1 sweep commits for
  #230-#250, but those issues may still appear open remotely.
- #259 and #260 are implemented in provider code and verified locally by
  `tests/openai-provider.test.ts`, `tests/provider-mode.test.ts`, and
  `tests/token-counting.test.ts`; their issue numbers are not in the latest
  local commit trailers because the implementation already existed.

## Next Update Slot

Use this section for the next live batch before editing code:

- Batch:
- Subagents:
- Files expected:
- Verification plan:
- Result:
- Commit:

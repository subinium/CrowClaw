# release/v0.8.2 Live Worklog

> Branch was renamed from `release/v0.8.1` to `release/v0.8.2` on
> 2026-05-03 for release publication. The ledger entries below preserve
> the working branch name (`release/v0.8.1`) used during the sweep — the
> rename is bookkeeping, not a content change.

This file is the interruption-safe working ledger for the local
`release/v0.8.2` (originally `release/v0.8.1`) branch. Update it during
the work, not only at the end.

## Operating Rule

- Record each issue batch before implementation starts.
- Record subagent ownership and verifier outcomes as they happen.
- Record verification commands and results before committing.
- Record each local commit SHA after it is created.
- Do not rely on chat history alone for release state.
- Do not push or open a PR from this branch until explicitly requested.
- Keep work on `release/v0.8.1`; do not create branch names containing
  `codex` for this release lane.
- Leave small, reviewable local commits at natural checkpoints:
  after each verified issue batch, after release-note/worklog updates, and
  before any large handoff or context break.
- Run regression tests before claiming a batch complete. Minimum gate is
  focused tests for touched surfaces plus `npm run typecheck` and
  `git diff --check`; broad/runtime changes require full `npm test` and
  relevant web/package builds.
- Manage conflicts proactively: check `git status --short` before editing,
  avoid overlapping file ownership across subagents, inspect shared-file
  diffs before staging, and never revert unrelated user or agent work.

## Current State

- Branch: `release/v0.8.1`
- Push/PR status: local only, not pushed, no PR opened
- Worktree status at ledger creation: clean
- Latest local commit at ledger creation: `772e907 docs(changelog): record local 0.8.1 issue sweep`

## Local Commit Ledger

### `f5ae7e0 feat(dashboard): finish release polish gaps`

- Closed dashboard verifier gaps #243, #245, #249, and #250.
- Removed eager highlight.js CDN assets from the dashboard shell and generated
  HTML.
- Removed legacy `--glass-*` dashboard tokens from UI source and generated
  HTML.
- Added toast live-region/reduced-motion accessibility coverage.
- Added bounded incremental chat history rendering.
- Verification:
  - `npm run build:ui --workspace @crowclaw/web`
  - `npm run build:html --workspace @crowclaw/web`
  - `npm test -- tests/dashboard-polish.test.ts tests/a11y.test.ts`
  - `npm test`: 238 files, 2,982 tests
  - targeted `rg` checks for legacy glass/highlight.js tokens
  - `git diff --check`

### `1b098d6 feat(runtime): complete remaining release contracts`

- Closed #184, #187, #188, #202, #203, #255, #267, #281, #282, and #287.
- Memory management now has redaction warnings, typed delete confirmation,
  size/token metadata, and session cost summaries.
- Skills preview is wired through `/api/skills/preview` and `skill.preview`.
- Embedded MCP/ACP servers now use live runtime session/tool registries.
- Cloudflare route parity audit now follows refactored route handlers, records
  explicit Worker unsupported routes, has zero `missing` rows, and runs in CI.
- Secret loading now supports SOPS CLI references in addition to env, file,
  systemd, and 1Password sources.
- Local memory search now has deterministic semantic-style sparse ranking.
- Delegate depth is typed, validated, and propagated without `__delegateDepth`.
- Codex/OpenAI ChatGPT provider docs/defaults/tests match `gpt-5.5` and
  `requireStream` structured-output behavior.
- Verification:
  - `npm run build -- --pretty false`
  - `npm run typecheck`
  - focused unresolved-gap tests: 12 files, 132 tests
  - `npm test`: 238 files, 2,982 tests
  - `node scripts/audit-routes.mjs --check`
  - `git diff --check`

### `858e08f Track unresolved release verifier gaps`

- Recorded final verifier outcomes for the low-number, #181-#228, #230-#250,
  and #253-#288 audit lanes.
- Defined the active unresolved-gap implementation batch and file ownership
  split for parallel work.
- Verification: `git diff -- docs/release-v0.8.1-worklog.md`.

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

- Batch: remote-open issue coverage audit after local implementation sweep
  on 2026-05-03.
- Subagents: pending; split by issue ranges/surfaces so unresolved items can
  be patched without file ownership conflicts.
- Files expected: initially read-only audit; update this worklog before any
  implementation patch.
- Verification plan: compare `gh issue list --state open` against local code,
  tests, `origin/main` release sweep commits, and `release/v0.8.1` local
  commits; produce a concrete unresolved issue list with file evidence.
- Result:
  - Low-number verifier PASS: #73, #74, #82, #90, #96, #155, #160, #163.
    Focused verifier tests reported 159 passing tests. Residual risks:
    `runtime-node/src/index.ts` is 628 lines, and `TerminalSession` is a
    factory/type rather than a class, but both issue goals are functionally
    satisfied.
  - #230-#250 verifier PARTIAL. PASS: #230, #231, #232, #233, #234, #235,
    #236, #237, #238, #239, #240, #241, #242, #244, #246, #247, #248.
    UNRESOLVED: #243, #245, #249, #250.
    Patch areas: dashboard highlight.js loading/generated HTML, visual reset
    glass tokens/styles, accessibility live-region/reduced-motion/test
    coverage, and chat/perf virtualization or equivalent bounded rendering.
  - #181-#228 verifier PARTIAL. PASS: #181, #182, #183, #185, #186,
    #189-#201, #204-#228. UNRESOLVED: #184, #187, #188, #202, #203.
    Patch areas: memory entry preview/edit/delete warnings, per-session
    memory size/cost metadata, skill execution preview UX, embedded MCP
    session store wiring, and embedded ACP live tool registry wiring.
  - #253-#288 verifier PARTIAL. PASS: #253, #254, #255, #256, #257,
    #258, #259, #260, #261, #262, #263, #264, #265, #266, #267, #268,
    #269, #270, #271, #272, #273, #274, #275, #276, #277, #278, #279,
    #280, #283, #284, #285, #286, #288. UNRESOLVED: #281, #282, #287.
    Strict-read risks: #255 route parity inventory intentionally still reports
    missing routes, and #267 documents secret-provider options without adding a
    real `sops:` backend.
- Commit: `1b098d6`, `f5ae7e0`; final documentation checkpoint records this
  verification state.

## Active Batch: unresolved verifier gaps on 2026-05-03

- Scope: #184, #187, #188, #202, #203, #243, #245, #249, #250, #281,
  #282, #287, plus strict-read review for #255 and #267.
- Branch: `release/v0.8.1`
- Push/PR status: local only; no push, no PR, no remote issue closure.
- Implementation ownership:
  - Galileo (`019de972-584b-7ca1-b860-465fcd4e0acc`): UI memory/skills
    #184, #187, #188 in `packages/web/ui/src/views/settings-view.ts` and
    `packages/runtime-node/src/route-handlers.ts`.
  - McClintock (`019de972-5d8a-7191-a85d-705b0892eef7`): embedded protocol
    wiring #202, #203 in runtime/MCP/ACP embedding code.
  - Maxwell (`019de972-630f-7bf3-b91f-3fd43a22f556`): dashboard polish/perf/a11y
    #243, #245, #249, #250 in dashboard HTML/CSS, chat/connect/toast components,
    a11y tests, and generated web HTML.
  - Russell (`019de972-685e-77a0-9fd1-8c4895663178`): semantic memory #281
    in memory/storage/tool recall paths.
  - Euler (`019de972-6ef5-7213-b93d-c83de9839e7a`): delegate depth #282 in
    core delegate metadata/tooling tests.
  - Gibbs (`019de972-7637-7620-97c6-6b2dad6e8149`): Codex provider
    defaults/JSDoc #287 in provider/runtime provider docs and tests.
  - Leader-local: strict-read review and any small closure needed for #255
    and #267 because the current app hit its concurrent subagent limit.
- Verification plan:
  - Focused tests for each touched issue surface.
  - `npm run typecheck`.
  - `npm test` before claiming the batch complete.
  - `npm run build:ui --workspace @crowclaw/web`.
  - `npm run build:html --workspace @crowclaw/web`.
  - `git diff --check`.
- Result:
  - Galileo completed #184, #187, #188. Verification reported:
    `git diff --check` on owned files, `npx tsc -p packages/runtime-node/tsconfig.json
    --noEmit --pretty false`, `npm --workspace @crowclaw/web run build:ui`,
    `npx vitest run tests/runtime-memory-list.test.ts tests/e2e-dashboard-api.test.ts`,
    and `npx vitest run tests/mcp-skill-crud.test.ts tests/dashboard-contract.test.ts`
    passed.
  - McClintock completed #202 and #203. Verification reported:
    `npx vitest run tests/runtime-mcp-server-routes.test.ts tests/runtime-acp-routes.test.ts`,
    the broader MCP/ACP focused suite, runtime-node package typecheck, and
    `git diff --check` passed.
  - Maxwell completed #243, #245, #249, #250. Verification reported:
    `npm run build:html --workspace @crowclaw/web`, `npx vitest run tests/a11y.test.ts
    tests/dashboard-polish.test.ts`, targeted `rg` checks for highlight.js and
    glass tokens, and `git diff --check` passed.
  - Russell completed #281. Verification reported:
    `npx vitest run tests/storage-memory.test.ts tests/storage-d1-memory.test.ts
    tests/memory-provider.test.ts`, `npx vitest run tests/embedding-memory.test.ts`,
    storage package typecheck, memory package typecheck, and owned-file
    `git diff --check` passed.
  - Euler completed #282. Verification reported:
    `npm run typecheck`, `npm run build -- --pretty false`,
    `npm test -- tests/delegate-tool.test.ts tests/delegate-enhanced.test.ts`,
    `npm test -- tests/e2e-core-agent.test.ts`, and
    `rg -n "__delegateDepth" . --glob "!node_modules" --glob "!dist"` passed.
  - Gibbs completed #287. Verification reported:
    `npm test -- tests/openai-provider.test.ts tests/codex-auth.test.ts`,
    `npm run typecheck`, and `git diff --check` passed.
  - Leader-local completed strict-read #255 and #267. #255 now has a refactor-safe
    route audit, explicit Worker unsupported route table, CI parity check, and
    zero `missing` rows. #267 now has a SOPS CLI-backed secret reference source
    with focused provider-factory tests and docs.
  - Integration verification after all subagent results landed:
    - `npm run build -- --pretty false` passed.
    - `npm run typecheck` passed.
    - focused unresolved-gap test batch passed: 12 files, 132 tests.
    - `npm run build:ui --workspace @crowclaw/web` passed.
    - `npm run build:html --workspace @crowclaw/web` passed.
    - `npm test` passed: 238 files, 2,982 tests.
    - `node scripts/audit-routes.mjs --check` passed.
    - `git diff --check` passed.
    - `rg` checks found no legacy dashboard glass/highlight.js tokens in
      generated HTML or UI source.
- Commit: `1b098d6`, `f5ae7e0`; this documentation checkpoint finalizes
  the batch ledger.

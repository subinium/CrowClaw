# CrowClaw Agent Framework Audit

Date: 2026-04-13
Scope: current workspace state in `/Users/subinium/Projects/hermes-agent-typescript`
Method: repo structure review, source inspection, test/typecheck verification, and comparison against official documentation for LangGraph, OpenAI Agents SDK, Mastra, and CrewAI.

## Executive Summary

CrowClaw is ambitious and unusually broad for a TypeScript agent framework. It already has real strengths:

- wide surface area across runtime, CLI, gateway, MCP, scheduler, memory, and tools
- strong test inventory and decent regression discipline
- a clean zero-dependency bias in core packages
- a runtime-agnostic package split that is directionally correct

But compared with mature agent frameworks, its biggest weakness is not missing features in isolation. The bigger problem is **depth mismatch**:

- the project markets itself as a self-improving, durable framework
- the codebase often implements those ideas with heuristic or in-memory approximations
- several high-value production concerns are still shallower than the README positioning suggests

Bottom line:

- As a beta TypeScript agent runtime, CrowClaw is promising.
- As a direct competitor to LangGraph, OpenAI Agents SDK, Mastra, or CrewAI on production reliability, it is not there yet.
- The next gains should come from **durability, memory realism, observability, and maintainability**, not from adding more surface area.

## Comparative Position

| Dimension | CrowClaw today | Mature peers | Audit verdict |
| --- | --- | --- | --- |
| Core loop | Real multi-turn tool loop in `@crowclaw/core` | Strong across all compared frameworks | Competitive at baseline |
| Durable execution | Checkpoint/replay exists, but node runtime uses `InMemoryCheckpointStore` | LangGraph and Mastra emphasize persisted resume/suspend state | Behind |
| Memory | Heuristic summaries, in-memory vector index, placeholder embedding adapter | CrewAI and Mastra expose deeper persistent memory semantics | Clearly behind |
| Learning / self-improvement | Skill extraction/matching is mostly heuristic | Peers lean more on evals, traces, human review, or explicit workflow gates | Behind |
| Observability / evals | Usage tracking exists, but cost/latency/model info are not populated richly | OpenAI Agents SDK, Mastra, and CrewAI all foreground tracing/evals | Behind |
| Orchestration model | Loop-centric, not graph/state-machine centric | LangGraph and CrewAI Flows provide richer stateful workflow control | Behind for complex workflows |
| Runtime/tool breadth | Broad: gateway, browser, terminal, MCP, scheduler, vision, image | Competitive breadth for a beta TS project | Strong |
| Maintainability | Several very large modules contradict stated architecture rules | Peers usually separate runtime, workflow, and telemetry concerns more clearly | Material debt |

## Verification Snapshot

- `npm run typecheck`: passed
- `npm run preflight`: failed
- failing `preflight` result: `155` test files, `1564` tests passed, `5` tests failed
- focused repro: `npm test -- tests/runtime-scheduler.test.ts tests/runtime-node.test.ts tests/e2e-runtime-parity.test.ts` failed with `4` runtime/scheduler-related assertions
- CI expects both typecheck and tests to pass: `.github/workflows/ci.yml:27-31`

The current release gate problem is not the compiler. It is **test reliability and environment coupling**.

## High-Impact Findings

### 1. The “self-improving” claim is materially stronger than the current implementation

Severity: High

Why this matters:

- The README leads with “learns from every conversation” and “self-improving” positioning (`README.md:5`, `README.md:20`, `README.md:124`).
- In practice, the learning loop is mostly a heuristic drafting and matching system, not a validated learning system.

Evidence:

- Completion detection is phrase scoring on the final assistant message, not outcome verification: `packages/learning/src/index.ts:118-179`
- Heuristic draft extraction turns user and assistant phrases directly into triggers and steps: `packages/learning/src/index.ts:242-270`
- Skill matching is substring and word-overlap scoring: `packages/learning/src/index.ts:186-239`
- Auto-capture publishes based on heuristic completion confidence: `packages/learning/src/index.ts:404-407`
- Skill quality control is limited to simple helpful/unhelpful counters: `packages/learning/src/index.ts:379-401`
- Even “E2E” learning tests are happy-path oriented around phrases like “All done!”: `tests/e2e-learning-flow.test.ts:70-86`

Why peers are stronger:

- OpenAI Agents SDK emphasizes tracing, sessions, guardrails, and human-in-the-loop as first-class production primitives, not “auto-learning” by default.
- Mastra emphasizes evals and scoring in CI.
- CrewAI memory uses richer save/recall analysis than raw string overlap.

What to change:

1. Add a publish gate for learned skills.
2. Require post-run evidence before promoting a draft to `published`.
3. Record whether a learned skill actually improved latency, tool count, or success rate.
4. Validate required tools at publish time, not only with runtime warnings.
5. Split “draft extraction” from “approved reusable skill” as different lifecycle states.

### 2. Durable memory is currently too weak to support the framework’s long-term positioning

Severity: High

Why this matters:

- CrowClaw wants to look like a framework with durable recall and reusable operational memory.
- The current memory stack behaves more like a local heuristic memory helper.

Evidence:

- `MemoryService.summarize()` only uses the last 4 messages and slices to 200 chars: `packages/memory/src/index.ts:28-47`
- Expired memories are “cleaned” by writing tombstones because the store has no delete capability: `packages/memory/src/index.ts:144-167`
- `EmbeddingMemoryStore` keeps its vector index only in memory via `EmbeddingIndex` and `recordCache`: `packages/memory/src/embedding-store.ts:39-45`, `packages/memory/src/embedding-store.ts:91-99`
- Search depends on that in-memory index and returns no semantic hits when the in-memory index is empty: `packages/memory/src/embedding-store.ts:136-182`
- There is no rehydrate step from persistent storage into the vector index on startup
- The configured “embedding provider” in runtime-node is a placeholder that asks a text model for an embedding and then generates an 8-dim sine/hash vector: `packages/runtime-node/src/provider-factory.ts:220-239`
- User modeling is keyword-list extraction plus 4-token preference phrases: `packages/memory/src/user-model.ts:23-48`, `packages/memory/src/user-model.ts:61-70`, `packages/memory/src/user-model.ts:98-123`

Why peers are stronger:

- LangGraph persistence is explicitly designed around saved checkpoints and resumable state.
- Mastra’s Memory Gateway markets persistent observational memory with thread/resource scoping.
- CrewAI’s unified memory describes composite scoring using semantic similarity, recency, and importance.

What to change:

1. Implement a persistent vector index or deterministic reindex-on-start path.
2. Replace the placeholder embedding adapter with real embedding backends.
3. Add memory importance/recency weighting rather than plain newest-first or cosine-only ranking.
4. Give `MemoryStore` a real delete/update API instead of tombstone writes.
5. Treat user model extraction as a separate structured subsystem with schema/versioning.

### 3. Checkpointing exists, but the runtime durability story is still not in the same class as LangGraph or Mastra

Severity: High

Why this matters:

- Checkpoint/restore/replay is a major advertised capability (`README.md:126`, `README.md:392-420`).
- In the node runtime, checkpoint storage is process-local memory.

Evidence:

- Node runtime creates `const checkpointStore = new InMemoryCheckpointStore()`: `packages/runtime-node/src/index.ts:842`
- Checkpoint list/save/restore/replay routes all use that in-memory store: `packages/runtime-node/src/index.ts:2920-3020`
- Checkpoint creation does not preserve actual pending tool calls; it explicitly writes an empty list: `packages/runtime-node/src/index.ts:2979-2983`
- The feature matrix still rates multiple stateful subsystems as partial: `docs/feature-matrix.md:12-23`

Why peers are stronger:

- LangGraph documents durable execution and persistence as a built-in persisted checkpointer model.
- Mastra workflows document suspend/resume with snapshots persisted to storage.
- CrewAI Flows documents persistent flow state and resume-oriented workflow semantics.

What to change:

1. Add a persistent checkpoint backend interface for Node and Cloudflare.
2. Persist checkpoints in storage, not only in process memory.
3. Capture resumable execution metadata, not just message snapshots.
4. Add crash-recovery tests, not just same-process restore tests.
5. Decide whether CrowClaw wants true workflow durability or only conversation rollback, and document that honestly.

### 4. The codebase is carrying enough architectural debt that delivery speed will start to drop

Severity: Medium-High

Why this matters:

- The project’s own philosophy says “one file, one job” and that runtime adapters should be under 500 lines: `docs/design-philosophy.md:19`, `docs/design-philosophy.md:47`
- The current hotspots are much larger:

  - `packages/runtime-node/src/index.ts`: 3409 LOC
  - `packages/cli/src/index.ts`: 2328 LOC
  - `packages/tools/src/index.ts`: 2220 LOC
  - `packages/sandbox-executor/src/index.ts`: 1972 LOC
  - `packages/providers/src/index.ts`: 1859 LOC
  - `packages/core/src/index.ts`: 1375 LOC

Evidence:

- Web dashboard is a single embedded HTML/CSS/JS blob starting at `packages/web/src/index.ts:8`
- Large inline CSS starts at `packages/web/src/index.ts:17`
- Large inline HTML/DOM starts at `packages/web/src/index.ts:342`
- Large inline JS/app logic starts at `packages/web/src/index.ts:390`

Why peers are stronger:

- LangGraph and CrewAI push orchestration/state into clearer abstractions.
- OpenAI Agents SDK stays deliberately small in primitives.
- Mastra separates framework, observability, workflow, and memory products more cleanly.

What to change:

1. Split `runtime-node` routes by domain: sessions, checkpoints, gateway, MCP, provider config, scheduler.
2. Split `tools/src/index.ts` into catalog, terminal, gateway, memory, and runtime tool modules.
3. Extract dashboard assets into separate static files, even if still framework-free.
4. Extract provider metadata, routing, and transport logic into separate files.
5. Set LOC caps for new modules and enforce them in review.

### 5. Observability and evals are not yet at framework-grade depth

Severity: Medium

Why this matters:

- Once the framework surface gets broad, bugs stop being “feature missing” and become “hard to diagnose.”
- Right now CrowClaw has traces in spirit, but not enough runtime evidence to compete with the better-instrumented frameworks.

Evidence:

- Usage tracking records `model: 'unknown'`, `provider: 'primary'`, `costUsd: 0`, `latencyMs: 0`: `packages/core/src/index.ts:437-451`
- Plugin hooks are thin and synchronous, covering only a handful of event families: `packages/plugins/src/index.ts:7-40`
- `package.json` has no coverage script even though README discusses test breadth: `package.json:19-29`, `README.md:488-493`
- CI runs typecheck and tests, but there is no evaluation or coverage gate: `.github/workflows/ci.yml:27-31`

Why peers are stronger:

- OpenAI Agents SDK explicitly documents built-in tracing, evaluation, sessions, handoffs, guardrails, and human-in-the-loop.
- Mastra foregrounds traces, telemetry, custom evals, and CI eval runs.
- CrewAI documents built-in tracing for Crews and Flows.

What to change:

1. Emit structured spans for provider, tool, memory recall, and checkpoint operations.
2. Track real model, provider, latency, token, and cost metadata.
3. Add a small eval harness for critical agent behaviors.
4. Add coverage reporting and require it for release candidates.
5. Add regression dashboards for learned-skill effectiveness.

### 6. Surface area is wider than operational depth

Severity: Medium

Why this matters:

- A broad surface attracts users.
- If parts of that surface are “descriptor only” or internally inconsistent, trust degrades quickly.

Evidence:

- Feature matrix explicitly marks many subsystems `partial` or `planned`: `docs/feature-matrix.md:7-25`
- Terminal backends include `modal` and `daytona` as planned descriptors, not executable backends: `packages/tools/src/index.ts:69-82`, `packages/tools/src/index.ts:152-160`
- Skill execution only warns when required tools are absent instead of rejecting incompatible execution: `packages/core/src/index.ts:810-817`
- These warnings already show up during tests
- Version drift exists: package version is `0.1.2` but CLI still prints `v0.1.0`: `package.json:3`, `packages/cli/src/index.ts:541`, `packages/cli/src/index.ts:2117`
- README still shows `1302` tests, while current run passed `1492`: `README.md:12`, `README.md:18`

Why peers are stronger:

- Mature frameworks usually ship a narrower set of primitives, but the primitives are more coherent.

What to change:

1. Add capability negotiation to tools and skills.
2. Fail fast when a skill requires tools that are not present.
3. Mark descriptor-only backends as experimental in the public docs.
4. Sync version strings and test counts from release automation.
5. Publish a stability table for each subsystem.

### 7. Security posture is useful, but mostly heuristic and partially duplicated

Severity: Medium-Low

Why this matters:

- The current security layer is better than nothing and shows good intent.
- But it is still mostly regex-driven and partially duplicated across packages.

Evidence:

- Core SSRF logic is regex/hostname based: `packages/core/src/security.ts:1-40`
- Gateway duplicates URL safety logic because of zero-dep separation: `packages/gateway/src/index.ts:3-12`
- Prompt injection detection is heuristic pattern matching, not a policy engine

Why peers are stronger:

- OpenAI Agents SDK includes explicit guardrails as a primary primitive.
- Mastra markets input/output processing and sanitization as part of its evaluation/production platform.

What to change:

1. Move shared zero-dep SSRF policy into a shared package to avoid drift.
2. Add structured guardrail stages before tool execution and before final response emission.
3. Add adversarial regression cases for prompt injection, not just heuristic checks.
4. Separate “warn” from “block” policy in a more declarative way.

### 8. Test reliability is environment-coupled and currently undermines release confidence

Severity: High

Why this matters:

- A framework project lives or dies by whether its test suite is trustworthy.
- Right now the suite has signs of order dependence and machine-local state leakage.

Evidence:

- `npm run typecheck` currently passes, but `npm run preflight` fails in runtime/scheduler tests.
- Full `preflight` failed in:
  - `tests/runtime-scheduler.test.ts`
  - `tests/runtime-node.test.ts`
  - `tests/e2e-runtime-parity.test.ts`
- Focused repro still fails in runtime-node and parity routes.
- `tests/runtime-scheduler.test.ts` explicitly opts into isolated in-memory scheduler state with `createNodeRuntime({ schedulerStorePath: null })`: `tests/runtime-scheduler.test.ts:5-18`
- `tests/runtime-node.test.ts` uses the default `createNodeRuntime()` and assumes zero scheduler jobs: `tests/runtime-node.test.ts:5-32`, `tests/runtime-node.test.ts:75-103`
- `createNodeRuntime()` defaults to `FileSchedulerStore` under `~/.crowclaw/scheduler-jobs.json` unless `schedulerStorePath === null`: `packages/runtime-node/src/index.ts:542-553`
- The same runtime also defaults to a file-backed config store: `packages/runtime-node/src/index.ts:558-575`

Interpretation:

- Some tests are isolated.
- Others implicitly read persisted local state.
- That means the result can depend on prior local runs, prior tests, or workstation residue.

Compared with peers:

- Mature frameworks still have flaky tests, but their release trust is usually built on hermetic test lanes.
- For a framework that sells reliability primitives, non-hermetic tests are especially damaging.

What to change:

1. Make all runtime tests opt into in-memory stores by default.
2. Require explicit integration flags before touching `~/.crowclaw/*` in tests.
3. Add a hermetic test helper that constructs `createNodeRuntime()` with null file-backed paths.
4. Split “unit/in-memory runtime tests” from “file-backed persistence integration tests”.
5. Add CI assertions that fail if tests read or write operator home-directory state.

## Strengths Worth Preserving

CrowClaw should not throw away the parts that already work:

- The monorepo package split is good strategy, even if implementation drift exists.
- Tool/runtime breadth is unusually strong for a TypeScript-first beta.
- The test suite is broad and fast enough to support aggressive iteration.
- Zero-dependency discipline in core is a useful differentiator if it does not force too much duplication.
- Gateway plus runtime plus dashboard plus CLI gives CrowClaw an operator-centric identity that many frameworks do not have.

## Recommended Priority Order

### Immediate: next 1-2 weeks

1. Restore green `preflight` by fixing current type errors.
2. Align version strings and README counters automatically.
3. Make skill-tool incompatibility a hard validation error where appropriate.
4. Add a “current limits” section to the README so public claims match actual depth.

### Near-term: next 2-6 weeks

1. Replace placeholder embeddings with real embedding adapters.
2. Add persistent checkpoint storage and memory index rehydration.
3. Implement structured trace events with latency, token, provider, model, and cost data.
4. Split the biggest runtime and tool modules before adding major new features.

### Strategic: next 1-3 months

1. Decide whether CrowClaw wants to compete as:
   - a lightweight TypeScript runtime with strong operator UX
   - or a durable workflow/orchestration framework in the LangGraph/Mastra class
2. If the answer is “durable workflow framework,” add:
   - persisted execution state
   - proper suspend/resume semantics
   - richer execution graphs or structured workflows
   - eval-driven learning instead of phrase-driven learning

## Recommendation

Recommendation: `REQUEST CHANGES`

This is not a rejection of the project. It is a judgment on readiness versus positioning.

CrowClaw already has enough substance to be interesting. The right move now is not adding more channels, tools, or presets. The right move is making the existing core trustworthy:

- durable state
- real memory
- observable execution
- smaller modules
- stricter release hygiene

If those are fixed, CrowClaw can become a serious TypeScript-native alternative in the space. If they are not, it will keep looking wider than it is deep.

## Comparison Sources

- LangGraph durable execution: https://docs.langchain.com/oss/python/langgraph/durable-execution
- LangGraph persistence: https://docs.langchain.com/oss/python/langgraph/persistence
- LangGraph human-in-the-loop / interrupts: https://docs.langchain.com/oss/python/langgraph/human-in-the-loop
- OpenAI Agents SDK TypeScript overview: https://openai.github.io/openai-agents-js/
- Mastra workflows: https://mastra.ai/workflows
- Mastra observability: https://mastra.ai/observability
- Mastra platform overview: https://mastra.ai/
- Mastra Memory Gateway: https://gateway.mastra.ai/docs
- Mastra workflow update note: https://mastra.ai/blog/vNext-workflows
- CrewAI flows: https://docs.crewai.com/en/concepts/flows
- CrewAI memory: https://docs.crewai.com/en/concepts/memory
- CrewAI tracing: https://docs.crewai.com/en/observability/tracing
- CrewAI human input: https://docs.crewai.com/learn/human-input-on-execution

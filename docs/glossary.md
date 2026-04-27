# CrowClaw Glossary (#151)

A cross-cutting reference for terminology used in CrowClaw. The same concept
sometimes carries different names across CLI flags, REST routes, EventBus
event types, ACP RPCs, and MCP tool names — usually because each surface
adopted the term that fit its own protocol idioms first. **No renames are
planned for v0.6.x**; this doc just maps the surface area so contributors and
integrators can navigate it.

If a future major version (v1.x) does a breaking rename pass, the candidate
canonical names are flagged below as `(canonical)`.

## Core concepts

### Session — `Session` `(canonical)`

A long-lived conversation thread owned by a single agent. Persisted in the
session store (`InMemorySessionStore`, `FileSessionStore`, `D1SessionStore`).
Identified by `sessionId: string`.

| Surface | Term | Notes |
|---|---|---|
| Core (`@crowclaw/core`) | `Session` | Type defined in `packages/shared`. |
| REST | `/api/sessions/:id` | Path noun is `sessions`. |
| WebSocket | `session:*` events | All lifecycle events are `session:`-prefixed. |
| EventBus (`runtime-node`) | `session:created` / `session:updated` / `session:steered` / `session:aborted` / `session:forked` / `session:compacted` | See `event-bus.ts`. |
| ACP | `sessions/list`, `sessions/create` | RPC methods. |
| MCP | `crowclaw.sessions.list`, `crowclaw.sessions.get` | Tool names. |
| CLI | `crowclaw session ...` (where exposed) | Aligned with REST. |

**No alias**: `conversation` and `thread` are sometimes used in user-facing
docs but never in code. Treat them as synonyms in prose only.

### Run — single agent turn

A single invocation of `Agent.run(input)` that produces a result. One session
contains many runs. Not separately persisted — only the resulting messages
are stored on the session.

| Surface | Term | Notes |
|---|---|---|
| Core | `Agent.run(input: AgentRunInput): AgentRunResult` | Method on `Agent`. |
| Core (streaming) | `Agent.runStream(input)` | Yields events as they arrive. |
| Scheduler | "run" in `runJob`, `RunContext`, `run-history` | A scheduler tick *executes* a job, producing a run. |
| EventBus | no dedicated `run:*` type | Run boundaries surface as `session:updated`. |
| ACP | `sessions/run` | RPC method on a session. |
| MCP | `crowclaw.chat` | The MCP tool wrapping the canonical chat → run flow. |

**Disambiguation**: scheduler "runs" are a strict subset — they're runs
triggered by a cron tick rather than a user message.

### Job — `CronJobDefinition` (scheduler-only)

A scheduled, recurring agent task definition stored by `SchedulerStore`.
Carries a cron expression, target agent, prompt, and per-job constraints
(`enabledToolsets`, `timeoutMs`, `inactivityTimeoutMs`, `wallClockTimeoutMs`).

| Surface | Term | Notes |
|---|---|---|
| Scheduler | `CronJobDefinition`, `SchedulerStore.{listJobs, saveJob}` | The job is the *definition*, not an execution. |
| EventBus | `scheduler:*` (where wired) | Job lifecycle events. |
| REST | `/api/scheduler/jobs/...`, `/api/scheduler/stop` | |
| MCP | `crowclaw.scheduler.create`, `crowclaw.scheduler.list` | Privileged tool. |

A "job" is **not** the same as a "run". One job produces many runs over its
lifetime.

### Task — informal, not a typed concept

Used in three distinct, non-canonical ways. **Not a typed primitive.**

1. **Fork task** — `forkSession(parent, task, childAgentId)` accepts a task
   string that becomes the seed user message of the child session. (Local
   to `@crowclaw/core` `forkSession()`.)
2. **Tool/skill task description** — free-form description in plugin manifests
   and skills. Just metadata.
3. **User-facing copy** — "task" appears in dashboard UI as a synonym for
   "what the user asked the agent to do". Pure UI copy.

If you find yourself needing a "task" type, you almost certainly want
`Session`, `AgentRunInput`, or `CronJobDefinition` instead.

## Lifecycle actions: abort vs stop

These two action endpoints overlap but are **not** interchangeable. The
distinction is **synchronous wait** vs **fire-and-forget signal**.

| Action | Path | Behavior | Response |
|---|---|---|---|
| `abort` | `POST /api/sessions/:id/abort` | Signals the session controller to abort. Returns immediately. | `200 { ok: <bool>, aborted: <bool>, reason?: string }` |
| `stop` | `POST /api/sessions/:id/stop` | Signals abort, then **waits up to 5s** for the session to leave the active set. | See below. |

### `stop` response shapes (#59)

| HTTP | Body | Meaning |
|---|---|---|
| `200` | `{ ok: true, status: "stopped", sessionId }` | Aborted and drained within 5s. Caller can rely on session being inactive. |
| `202` | `{ ok: true, status: "pending", sessionId }` | Abort signalled; session still winding down. Caller should poll `GET /api/sessions/active`. |
| `404` | `{ ok: false, status: "not-active", reason }` | Session was not in the active set when stop was received. |

### `abort` response shape

```json
{
  "ok": true,
  "aborted": true,
  "reason": "<optional string when aborted=false>"
}
```

`aborted: false` means the session was already not running (treated as a
no-op; HTTP status remains 200).

### When to use which

- **Use `abort`** for fire-and-forget cancel (CLI Ctrl+C, dashboard
  abort button) where you don't need to know whether drain finished.
- **Use `stop`** when the next request **depends** on the session having
  fully released its mutex / cleared in-flight tool calls (CI tear-down,
  destructive workspace operations on the same session id).

The WebSocket `session:abort` message has the same semantics as
`POST /abort` — fire-and-forget signal.

## Lifecycle events (EventBus)

Discriminated union introduced in #147 (v0.6.0). Previously all
non-message changes were squashed into `session:updated` with an untyped
`action` field — that pattern is now legacy.

| Event type | Payload (key fields) | Emitted from |
|---|---|---|
| `session:created` | `sessionId, agentId` | session create handler |
| `session:updated` | `sessionId, messageCount` | message append, generic update |
| `session:steered` | `sessionId, directiveLength` | `/steer` |
| `session:aborted` | `sessionId, reason?` | `/abort` and `/stop` |
| `session:forked` | `sessionId, parentSessionId, parentAgentId, childAgentId` | `/fork` |
| `session:compacted` | `sessionId, removedMessages, summaryLength` | `/compact` |

Dashboard handlers in `packages/web/ui/src/app.ts` dispatch per type and emit
DOM events that `chat-view` consumes for timeline markers.

## Provider / gateway terminology

Spelled out here to avoid confusion across Hermes / OpenClaw / NemoClaw
parity work.

| Term | Meaning |
|---|---|
| **Provider** | A backend LLM service: Anthropic, OpenAI, Gemini, NVIDIA, xAI, OpenRouter. `ProviderAdapter` per provider. |
| **Model** | A specific model id under a provider, e.g. `claude-opus-4-5`. `ModelMetadata` includes `vision`, `requestTimeoutMs`. |
| **Gateway** | The runner that turns a request into a provider call, applies retries, fallback chain, credential pool, rate limit. |
| **Credential pool** | `ProviderKeyPool` — multiple keys per provider with `least_used` / `round_robin` cursor and 401-rotation. |
| **Fallback chain** | Ordered `GatewayConfig.fallbackProviders`. On hop, emits `gateway:fallback_used`. |

## Tool / skill / plugin / preset

Frequently confused. They are layered, not synonyms.

| Term | Definition | Where it lives |
|---|---|---|
| **Tool** | A single callable function exposed to the agent (e.g. `web.search`, `terminal.exec`). Naming convention `namespace.action`. | `@crowclaw/tools`, `@crowclaw/mcp` |
| **Toolset** | A named bundle of tools. Plumbed via `enabledToolsets: string[]`. | All packages that gate tools (forks, cron jobs, MCP scope). |
| **Skill** | A markdown-described capability (a SKILL.md file). May reference one or more tools, plus prompt fragments. | `@crowclaw/workspace` (SKILL.md path safety), agent prompt assembly. |
| **Plugin** | Code-level extension implementing `Plugin` interface (`preToolCall`, `transformToolResult`, etc.). | `@crowclaw/plugins` |
| **Preset** | An MCP+Skill+Tool **bundle** named for quick onboarding. Not a "persona". | Config layer. |

**Reminder**: presets are bundles, not personas. See `CLAUDE.md` (project).

## Tool naming convention

All tools use `namespace.action`:

| Pattern | Examples |
|---|---|
| `web.*` | `web.search`, `web.fetch` |
| `terminal.*` | `terminal.exec`, `terminal.spawn` |
| `sandbox.*` | `sandbox.run` |
| `scheduler.*` | `scheduler.create`, `scheduler.list` |
| `crowclaw.*` (MCP only) | `crowclaw.chat`, `crowclaw.sessions.list`, `crowclaw.sessions.get` |

The `crowclaw.` prefix is reserved for the MCP server's privileged surface
(maps to runtime-internal capabilities). Tool authors should not introduce
new top-level namespaces without a contract review.

## Quick term overlap matrix

| Concept | CLI | REST | EventBus | ACP | MCP |
|---|---|---|---|---|---|
| Session | `crowclaw session …` | `/api/sessions/:id` | `session:*` | `sessions/list`, `sessions/create` | `crowclaw.sessions.list` |
| One run | (implicit per message) | `POST /api/sessions/:id/messages` | `session:updated` | `sessions/run` | `crowclaw.chat` |
| Cancel (signal) | Ctrl+C | `POST /abort` | `session:aborted` | — | — |
| Cancel (drain) | — | `POST /stop` | `session:aborted` | — | — |
| Steer | — | `POST /steer` | `session:steered` | — | — |
| Fork | — | `POST /fork` | `session:forked` | — | — |
| Compact | — | `POST /compact` | `session:compacted` | — | — |
| Cron job | — | `/api/scheduler/jobs` | `scheduler:*` | — | `crowclaw.scheduler.*` |

## See also

- `packages/runtime-node/src/event-bus.ts` — EventBus discriminated union.
- `packages/runtime-node/src/route-paths.ts` — Canonical REST path strings.
- `packages/scheduler/src/index.ts` — `CronJobDefinition`, `RunContext`.
- `packages/acp/src/index.ts` — ACP RPC method names.
- `packages/mcp-server/src/index.ts` — MCP tool names.
- `CHANGELOG.md` v0.6.0 — `RuntimeEventType` extension and `routePaths.sessions.*` listing.

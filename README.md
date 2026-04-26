<p align="center">
  <img src="./docs/hero.png" alt="CrowClaw" width="720" />
  <h1 align="center">CrowClaw</h1>
  <p align="center">
    <strong>TypeScript runtime for self-improving agents.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/crowclaw"><img src="https://img.shields.io/npm/v/crowclaw?color=cb3837" alt="npm" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
    <a href="#5-minute-quickstart"><img src="https://img.shields.io/badge/node-%3E%3D22-blue.svg" alt="Node 22+" /></a>
    <a href="#packages"><img src="https://img.shields.io/badge/packages-19-purple.svg" alt="19 packages" /></a>
    <img src="https://img.shields.io/badge/tests-2187%20passed-brightgreen.svg" alt="Tests" />
    <a href="./CHANGELOG.md"><img src="https://img.shields.io/badge/changelog-v0.5.0-blue.svg" alt="Changelog" /></a>
  </p>
</p>

---

> **Beta. Single-maintainer, moving fast.** Pin exact versions. The agent loop and security surface are well-tested (2187 tests, five-agent cross-audit, 38-issue v0.5.0 sweep). Several subsystems are still partial — see [Feature status](#feature-status).

CrowClaw gives you an agent loop, 50+ tools, skill learning, scheduled jobs, multi-channel webhooks, and a dashboard — without wiring the whole stack yourself.

## What it is

CrowClaw is for building **backend agents** that can:

- run multi-turn tool loops with retries, fallbacks, and approval gates,
- learn reusable skills from completed conversations and inject them into future runs,
- expose a CLI, web dashboard, HTTP API, and messaging webhooks,
- run primarily on **Node.js**, with a Cloudflare Workers adapter for serverless deployments,
- replay any session from any iteration via checkpoints.

It is **not** a frontend SDK and **not** a personal-assistant product. If you want a polished AI assistant you install on your own devices, look at [OpenClaw](https://docs.openclaw.ai). If you want to build the runtime *underneath* one, you're in the right place.

## Is this for you?

Use CrowClaw if you want:

- a TypeScript-native agent runtime you can embed in your own Node service,
- built-in tool execution, session state, memory, and skill learning out of the box,
- inbound webhook normalization for Slack/Telegram/Discord/etc. and outbound delivery,
- a learning loop you can inspect and approve,
- replayable debugging through checkpoints.

Probably look elsewhere if you want:

- only a React chat UI ([Vercel AI SDK](https://sdk.vercel.ai) is closer),
- multi-agent graph orchestration as the primary abstraction ([CrewAI](https://www.crewai.com), [AutoGen](https://microsoft.github.io/autogen/)),
- a fully production-hardened enterprise sandbox stack (see [NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/) for that layer),
- a turnkey personal assistant — OpenClaw is the polished product.

## 5-minute quickstart

**Requirements**: Node.js >= 22, one model provider key.

```bash
git clone https://github.com/subinium/CrowClaw.git
cd CrowClaw

npm install
npm run build

cp .env.example .env
# Edit .env. Minimum: set CROWCLAW_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
```

### Try the CLI

```bash
node packages/cli/dist/index.js
```

```text
crowclaw> /doctor       # show configured provider, tool count, security state
crowclaw> /tools        # list registered tools
crowclaw> what day is it
crowclaw> fetch https://news.ycombinator.com and summarize the top 3 stories
```

### Start the HTTP server + dashboard

```bash
node packages/cli/dist/index.js serve --port 3117
```

Then open <http://localhost:3117> for the Lit dashboard (Chat / Agent / Connect / Automate / Settings tabs with SSE streaming). API example:

```bash
curl -X POST http://localhost:3117/api/sessions/demo/message \
  -H 'content-type: application/json' \
  -d '{"userMessage": "What can you do?"}'
```

Bind to a non-localhost interface and the runtime refuses `/api/*` until `CROWCLAW_DASHBOARD_TOKEN` is set — the dashboard uses an HttpOnly cookie derived from that token. See [Security](#security).

### Embed the agent loop in your own code

```typescript
import { AgentLoop } from '@crowclaw/core'
import { OpenAICompatibleProvider } from '@crowclaw/providers'
import { createDefaultWorkerRegistry } from '@crowclaw/tools'
import { InMemorySessionStore } from '@crowclaw/storage'

const provider = new OpenAICompatibleProvider({
  apiKey: process.env.CROWCLAW_API_KEY ?? process.env.OPENAI_API_KEY!,
  baseUrl: process.env.CROWCLAW_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.CROWCLAW_MODEL ?? 'gpt-4o',
})

const tools = createDefaultWorkerRegistry()

const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
  maxToolIterations: 8,
  errorReflection: true,
  synthesizeOnExhaustion: true,
  runtimeName: 'my-agent',
})

const result = await agent.run({
  agentId: 'my-agent',
  sessionId: 'session-1',
  userMessage: 'What time is it?',
})

console.log(result.finalResponse)
console.log(result.toolResults)
```

## How the learning loop works

This is the part that makes CrowClaw different from a thin wrapper around an LLM.

```
Conversation -> Skill Draft -> Review -> Publish -> SkillRegistry -> Agent Prompt
     ^                                                              |
     +---------------------- improved behavior ---------------------+
```

Step by step:

1. A user asks the agent to complete a task.
2. The agent uses tools and finishes.
3. `LearningPipeline.autoCapture` detects completion and drafts a reusable skill.
4. You review the draft in the dashboard (or accept programmatically).
5. Future sessions matching that skill's triggers get the instruction injected automatically.

**Before learning:**

```text
User: Deploy this worker to Cloudflare.
Agent: searches docs → discovers wrangler config → reads README → retries → eventually deploys.
```

**After learning** (skill `cloudflare-worker-deploy` published):

```text
User: Deploy another worker.
Agent: loads the skill at run start, follows the known checklist, deploys directly.
```

Skill quality is tracked over time — `auto-improver.ts` scores helpful rate, total uses, and trend, then proposes `improve / merge / unpublish / promote` actions. Learned skills compose with built-in skills and any local `SKILL.md` files you check in.

```typescript
import { LearningPipeline, InMemorySkillStore, SkillRegistry } from '@crowclaw/learning'

const store = new InMemorySkillStore()
const registry = new SkillRegistry({ skillStore: store })
const pipeline = new LearningPipeline(store)
pipeline.setRegistry(registry)

// Auto-capture after a session ends
const draft = await pipeline.autoCapture(session.messages, 'deploy-workflow')
if (draft) await pipeline.publishDraft(draft.id)

// On the next run, skills are resolved into the system prompt
const skills = registry.resolve()
```

## Architecture at a glance

```
                    +-------------------------------------+
                    |         Agent Loop (core)           |
                    |  retries . fallbacks . checkpoints  |
                    +---------+-----------+---------------+
                              |           |
              +-------+-------+           +-------+-------+
              v       v       v           v       v       v
        +----------+ +-----+ +--------+ +------+ +----------+
        | Providers| |Tools| | Memory | |Skills| | Gateway  |
        +----------+ +-----+ +--------+ +------+ +----------+
                                            |           |
                                    +-------+     +-----+
                                    v             v
                              +-----------+ +----------+
                              | Learning  | | Scheduler|
                              | pipeline  | | executor |
                              +-----------+ +----------+
```

Runtime adapters (`runtime-node`, `runtime-cloudflare`) wrap the runtime-agnostic core. See [docs/architecture.md](./docs/architecture.md) and [docs/design-philosophy.md](./docs/design-philosophy.md) for principles (zero-dep core, runtime-agnostic interfaces, plain files over databases).

## Feature status

| Area | Status |
|---|---|
| Agent loop (`@crowclaw/core`) | Beta — tested, five-agent cross-audit, 38-issue v0.5.0 sweep |
| Node.js runtime | Beta — primary runtime |
| Cloudflare Workers runtime | **Early adapter** — functional, narrower override surface than Node |
| Provider routing (OpenAI-compat / Anthropic) | Partial — credential pooling, prompt caching, fallback chain |
| Tools (50+) | Partial-to-strong — registry + dispatch, terminal/web/workspace/memory/MCP |
| Skill learning | Beta — auto-capture, dedup, quality scoring, registry |
| Memory | Partial — in-memory + D1 + embedding store (bag-of-words by default; `LocalEmbeddingProvider` for Ollama) |
| Gateway integrations | Partial — 8 inbound platforms, 6 outbound; per-platform support varies |
| Scheduler / cron | Partial — file-backed jobs + delivery, activity-based timeouts |
| MCP | Partial — HTTP + stdio, 17 presets, OAuth device-code flow |
| Security hardening | Active — SSRF, prompt-injection scan, redaction, audit log. **Not** a sandbox replacement |

Expand any of the above into the matching package's source — the public API is what's exported from `packages/<name>/src/index.ts`. See [docs/feature-matrix.md](./docs/feature-matrix.md) for a finer-grained breakdown.

## Extension points

CrowClaw is built around small interfaces. Bring your own implementation when you need to:

- `ProviderAdapter` — model provider (OpenAI-compatible, Anthropic, custom)
- `ToolDefinition` — register tools with manifests + dispatcher
- `SessionStore` — persist sessions
- `MemoryStore` — scoped memory + `getByIds` for embedding-backed search
- `CheckpointStore` — replay/rollback agent runs
- `SecurityPolicy` — redact, scan, or block risky tool calls
- `EmbeddingProvider` — duck-typed `embed(texts) -> number[][]`; `LocalEmbeddingProvider` ships for Ollama
- `SkillStore` — persist learned skills
- `GatewayIdempotencyStore` — atomic webhook dedup with TTL

Most of these have an `InMemory*` default and a file- or D1-backed concrete; you only implement one when you want a different backend.

## Tool families

The 50+ built-in tools are grouped:

- **web** — search, fetch, extract metadata (with SSRF validation, prompt-injection scan)
- **terminal** — local / docker / ssh execution
- **workspace** — file read/write/diff inside a runtime-neutral file abstraction
- **memory** — scoped remember/recall
- **MCP** — every tool exposed by a connected MCP server appears here
- **gateway** — outbound senders for 6 messaging platforms
- **scheduler** — create/list/dry-run/pause/resume scheduled agent jobs
- **vision / image / TTS** — media tools (degrade gracefully without provider keys)
- **delegation** — spawn sub-agents (with optional context forking via `forkSession`)

Local terminal backends (local/docker/ssh) are available today. Other backend descriptors (e.g. Modal, Daytona) are placeholders, not active execution paths.

## Runtime support

| Runtime | Status | Notes |
|---|---|---|
| **Node.js 22+** | Primary | Full feature surface — local SKILL.md loading, persona dirs, all execution backends |
| **Cloudflare Workers** | Early adapter | Functional, narrower override surface — local SKILL.md / persona dirs are Node-only. Active-preset persistence + scheduler persistence + 7 lifecycle endpoints landed in v0.5.0 |

See [docs/deployment-cloudflare.md](./docs/deployment-cloudflare.md) for the Cloudflare adapter's current scope and limits.

## Security

Security is wired into the agent loop, not bolted on:

- **SSRF protection** — every outbound `fetch()` validates against private/CGNAT/ULA/IPv4-mapped IPv6 ranges before resolving
- **Prompt-injection scanning** — pattern-based (fast, not ML); detected payloads from tool output are wrapped in `<untrusted-content>` so the LLM reads them as data
- **Tool output redaction** — credentials, PII, and secrets stripped from tool output before it re-enters the model context
- **Command risk scanning** — destructive commands gated by approval; a hardline blocklist short-circuits unrecoverable ones (`rm -rf /` and friends) without prompting
- **Sanitized child-process env** — child shells get a stripped env (no `KEY|TOKEN|SECRET|...` vars)
- **Webhook signature verification** — Slack HMAC, Telegram secret token, Discord Ed25519, generic HMAC; deny-by-default
- **Auth** — HttpOnly cookie derived from `CROWCLAW_DASHBOARD_TOKEN`, timing-safe comparison, per-IP + global rate limit on `/api/auth/verify`
- **MCP owner-only enforcement** — privileged tools (`crowclaw.chat`, sessions list/get, memories search) require an owner token
- **Audit log** — every redaction, scan, and block decision recorded; dashboard exposes a security grade (A-F)

```typescript
import { validateFetchUrl, scanForInjection, redactPII } from '@crowclaw/core'

validateFetchUrl('http://169.254.169.254/metadata')
// { safe: false, reason: 'URL resolves to private/internal network' }

scanForInjection('ignore previous instructions and...')
// { safe: false, threats: [...], riskScore: 3, hasInvisibleChars: false }

redactPII('SSN: 123-45-6789')
// { text: 'SSN: [SSN_REDACTED]', redactedCount: 1 }
```

**Out of scope:** advanced adversarial prompt injection (multi-step, encoded), DNS rebinding, sandbox escape prevention. The execution backend (local / docker / ssh) determines that boundary. For a hardened sandbox stack on top of an OpenClaw-style assistant, see [NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/).

## Providers

```typescript
import { OpenAICompatibleProvider, AnthropicProvider } from '@crowclaw/providers'

const provider = new OpenAICompatibleProvider({
  apiKey: process.env.CROWCLAW_API_KEY,
  baseUrl: process.env.CROWCLAW_BASE_URL ?? 'https://api.openai.com/v1',
  model: process.env.CROWCLAW_MODEL ?? 'gpt-4o',
})

// Anthropic with native tool calling + prompt caching
// Use Anthropic's dated model slug (e.g., claude-sonnet-4-20250514). The undated
// `claude-sonnet-4` label is metadata-only and rejected by the API.
const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  baseUrl: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-20250514',
  promptCaching: true,
})
```

The provider interface is model-agnostic. Any endpoint that implements the OpenAI chat completions API works. A model catalog is included for context-window lookups; `loadManifest()` can fetch a remote manifest with 24h cache + ETag fallback.

## Presets

Three preset families ship in-tree:

- **Agent presets** — `coding-assistant`, `research-agent`, `devops-engineer`, `code-reviewer`, `data-analyst`, `technical-writer`, `security-auditor`, `project-manager`, `api-designer`, `fullstack-developer`, `sysadmin`, `creative-writer`, `database-admin`, `test-engineer`, `ml-engineer`
- **Toolset presets** — `minimal`, `web`, `terminal`, `workspace`, `memory`, `mcp`, `research`, `devops`, `creative`, `full`
- **MCP presets** — `filesystem`, `github`, `braveSearch`, `memory`, `puppeteer`, `playwright`, `fetch`, `postgres`, `sqlite`, `slack`, `googleDrive`, `googleMaps`, `everart`, `sequentialThinking`, `everything`, `time`, `exa`

```typescript
import { getAgentPreset } from '@crowclaw/core'
import { createMcpFromPreset } from '@crowclaw/mcp'

const preset = getAgentPreset('coding-assistant')
const github = createMcpFromPreset('github', { token: process.env.GITHUB_TOKEN })
```

## Gateway

Webhook normalization (inbound) and message delivery (outbound) for messaging platforms. Request/response model — works on serverless without persistent connections.

```typescript
import { normalizeTelegramWebhook, sendTelegramMessage } from '@crowclaw/gateway'

const message = normalizeTelegramWebhook(webhookBody)
// { platform: 'telegram', text: '...', channelId: '...', userId: '...' }

await sendTelegramMessage(botToken, chatId, 'Hello!')
```

DM and group access control is pairing-based (`evaluateAccess` + `generatePairingCode`), modeled after personal-agent frameworks. Outbound messages get per-platform rate limiting and exponential-backoff retry (capped at 30s/hop). The generic webhook (`/webhooks/generic`) requires an HMAC `X-CrowClaw-Signature: sha256=<hex>` header.

| Direction | Platforms |
|---|---|
| Inbound (8) | Telegram, Discord, Slack, WhatsApp, Signal, Email, Matrix, SMS, plus generic webhook |
| Outbound (6) | Telegram, Discord, Slack, WhatsApp, Matrix, Email |

## Scheduled execution

Run agent tasks on a schedule with optional gateway delivery.

```typescript
import { createScheduledAgentJob, SchedulerExecutor, InMemorySchedulerStore } from '@crowclaw/scheduler'

const store = new InMemorySchedulerStore()
const executor = new SchedulerExecutor(store, agentRunFn, deliveryFn)

const job = createScheduledAgentJob({
  id: 'daily-briefing',
  schedule: '0 9 * * *',
  task: 'Generate a daily project status briefing',
  deliverTo: { platform: 'telegram', config: { botToken: '...', chatId: '...' } },
  inactivityTimeoutMs: 5 * 60_000,
  maxRunDurationMs: 2 * 60 * 60_000,
})
await store.saveJob(job)

const results = await executor.tick()
```

Timeouts are activity-based — the watchdog only kills the job if no tool has run within `inactivityTimeoutMs`, with a separate hard `maxRunDurationMs` cap.

## Checkpoints

```typescript
import { createCheckpoint, restoreFromCheckpoint, createReplaySession, InMemoryCheckpointStore } from '@crowclaw/core'

const cpStore = new InMemoryCheckpointStore({ maxCheckpoints: 1000 })

const cp = createCheckpoint(session, toolResults, 3, 'iteration', 'before-deploy')
await cpStore.save(cp)

const restored = restoreFromCheckpoint(cp, currentSession)
const replaySession = createReplaySession(cp)
```

`autoCheckpoint` saves every iteration; checkpoint storage uses a length-cursor + per-session secondary index, so restore stays O(1) at the 1000-checkpoint cap.

## Batch processing

Process JSONL prompt datasets and export ShareGPT/JSONL trajectories — see `runBatch()` and `exportTrajectoryJsonl()` in `@crowclaw/learning`.

## How CrowClaw differs

CrowClaw lives in the same neighborhood as several Claw-named projects but plays a different role.

- **[Hermes Agent](https://github.com/NousResearch/hermes-agent)** is a polished self-improving agent product (Python). CrowClaw is the TypeScript runtime you'd embed when building one. Multi-turn loop, learning loop, credential pooling, and prompt caching here all started by studying Hermes.
- **[OpenClaw](https://docs.openclaw.ai)** is a personal AI assistant + gateway you run on your own devices. CrowClaw borrows OpenClaw's gateway/operator UX and SKILL.md format but focuses on backend agent infrastructure rather than a turnkey assistant product.
- **[NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/)** hardens OpenClaw deployments with privacy and security controls (NVIDIA). CrowClaw includes security controls *inside* the agent loop and runtime, but does **not** claim to replace a hardened sandbox stack.
- **[NeMo Agent Toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit)** (separate NVIDIA project) shaped CrowClaw's observability, memory, MCP, and checkpoint patterns.

## Roadmap

Things we know are still partial. No version commitments.

- **Persistent default checkpoint and memory stores.** In-memory is the default; a SQLite-backed durable store is on the roadmap.
- **Real semantic memory.** `EmbeddingMemoryStore` defaults to bag-of-words. Real embeddings work today via `LocalEmbeddingProvider` (Ollama-compatible) or any custom adapter; built-in remote-embedding providers are partial.
- **Cloudflare runtime parity.** ~25 routes still missing on the CF adapter (auth, config, security, providers, MCP CRUD, gateway admin). Active-preset + scheduler lifecycle landed in v0.5.0; the rest is incremental.
- **Tighter ANN index for embedding search.** Linear scan is fine to ~10k vectors; a real index lands when someone hits the wall.
- **Inline-style nonce CSP.** Currently `style-src 'unsafe-inline'`; Lit dashboard has inline styles that need an audit before nonce-only CSP.

For the full historical roadmap and shipped items, see [CHANGELOG.md](./CHANGELOG.md).

## Environment variables

Set in `.env` (copy from `.env.example`).

```bash
# Provider — set CROWCLAW_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY (at least one)
CROWCLAW_API_KEY=         # Provider-agnostic; primary lookup
CROWCLAW_PROVIDER=        # openai | anthropic | (custom OpenAI-compatible endpoint)
CROWCLAW_BASE_URL=        # Default: https://api.openai.com/v1
CROWCLAW_MODEL=           # Default: gpt-4o

OPENAI_API_KEY=           # Fallback if CROWCLAW_API_KEY is unset
ANTHROPIC_API_KEY=        # Anthropic-specific path

# Dashboard auth — required when binding to non-localhost
CROWCLAW_DASHBOARD_TOKEN= # Bearer token; HttpOnly cookie derived from this
CROWCLAW_TRUSTED_PROXIES= # CIDR list (e.g. 10.0.0.0/24,fe80::/10) for X-Forwarded-For trust

# Gateway (optional)
CROWCLAW_TELEGRAM_TOKEN=  # From @BotFather
SLACK_SIGNING_SECRET=     # From Slack app settings
DISCORD_PUBLIC_KEY=       # Ed25519 public key for webhook verification

# MCP (optional)
MCP_BASE_URL=             # MCP server URL for HTTP transport

# Persona & Skills (optional)
CROWCLAW_PERSONA_DIR=     # Path to persona markdown files (SOUL.md, IDENTITY.md, etc.)
CROWCLAW_SKILL_DIR=       # Path to local SKILL.md directory

# Media tools (optional — degrade gracefully if missing)
VISION_API_KEY=           # OpenAI API key for vision analysis
IMAGE_GEN_API_KEY=        # OpenAI API key for DALL-E image generation
```

## Test suite

```bash
npm run typecheck    # tsc -b
npm test             # vitest run
npm run preflight    # both
```

Coverage spans agent loop, providers, tools, memory, gateway (normalization + access policy), MCP, ACP, CLI, security (SSRF, auth rate limit, cookie hardening, CSP, hardline blocklist, MCP owner-only), browser, delegation, learning, plugins, scheduler, workspace, configuration API, and end-to-end wiring. **2187 tests** as of v0.5.0.

## Packages

19 npm workspaces, layered:

| Layer | Packages |
|---|---|
| Core | `core` · `providers` · `plugins` |
| Tools | `tools` · `workspace` · `sandbox-executor` |
| Persistence | `storage` · `memory` |
| Intelligence | `learning` · `scheduler` |
| Protocol | `mcp` · `mcp-server` · `acp` |
| Delivery | `gateway` |
| Runtime | `runtime-node` · `runtime-cloudflare` |
| Interface | `cli` · `web` |
| Infra | `shared` |

## Contributing

```bash
npm install
npm run build
npm run typecheck   # must pass
npm test            # must pass
```

Before opening a PR:

- Run typecheck and tests locally
- One logical change per PR
- Include tests for behavior changes
- Update docs if the change affects user-facing behavior

See [CONTRIBUTING.md](./CONTRIBUTING.md) for more.

## Design heritage

CrowClaw started as a TypeScript port of [Hermes Agent](https://github.com/NousResearch/hermes-agent) and absorbed patterns from [OpenClaw](https://docs.openclaw.ai), [NemoClaw](https://www.nvidia.com/en-us/ai/nemoclaw/), [NeMo Agent Toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit), and a [survey of ~30 other frameworks](https://github.com/subinium/awesome-agent-frameworks). The interesting patterns came from other people's projects; what's original here is the runtime-agnostic TypeScript glue and the operator-facing surface.

## License

[MIT](./LICENSE)

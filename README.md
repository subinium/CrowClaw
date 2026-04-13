<p align="center">
  <img src="./docs/hero.png" alt="CrowClaw" width="720" />
  <h1 align="center">CrowClaw</h1>
  <p align="center">
    <strong>A self-improving TypeScript agent framework that learns from every conversation.</strong>
  </p>
  <p align="center">
    <a href="https://www.npmjs.com/package/crowclaw"><img src="https://img.shields.io/npm/v/crowclaw?color=cb3837" alt="npm" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
    <a href="#quickstart"><img src="https://img.shields.io/badge/node-%3E%3D22-blue.svg" alt="Node 22+" /></a>
    <a href="#project-structure"><img src="https://img.shields.io/badge/packages-19-purple.svg" alt="19 packages" /></a>
    <img src="https://img.shields.io/badge/tests-1619%20passed-brightgreen.svg" alt="Tests" />
  </p>
</p>

---

> **Beta.** Core systems are functional and tested (1619 tests), but APIs may change before 1.0. Not recommended for production without review.

CrowClaw started as an effort to bring [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Python) to Cloudflare Workers. Porting it to TypeScript opened up a chance to rethink the architecture — so we [studied dozens of agent frameworks](https://github.com/subinium/awesome-agent-frameworks), distilled the best patterns from each, and built a framework that actually closes the loop: your agent gets better every time it completes a task.

It runs a multi-turn tool loop, learns skills from conversations, schedules autonomous tasks, and delivers results across 8 messaging platforms.

**What makes it different:**

- **Learns and improves** -- conversations become reusable skills, automatically injected into future runs
- **Runs anywhere** -- Node.js server, Cloudflare Workers, CLI, or Docker
- **Full operator surface** -- web dashboard, scheduled execution, batch processing, checkpoint/rollback
- **38+ tools built in** -- web, terminal, workspace, memory, vision, TTS, MCP, delegation
- **No vendor lock-in** -- works with any OpenAI-compatible API, Anthropic, or local models

## Quickstart

**Requirements**: Node.js >= 22

```bash
git clone https://github.com/subinium/crowclaw.git
cd crowclaw
npm install
npm run build

# Configure an LLM provider
cp .env.example .env
# Set OPENAI_API_KEY or ANTHROPIC_API_KEY in .env

# Start the interactive CLI
node packages/cli/dist/index.js
```

```
crowclaw> hello!
[cli-1] CrowClaw received: hello!

crowclaw> /tools
crowclaw> /help
```

### API Server

```bash
npm run dev   # starts on :8787

curl -X POST http://localhost:8787/api/sessions/demo/message \
  -H 'content-type: application/json' \
  -d '{"userMessage": "What can you do?"}'

# Response:
# { "ok": true, "response": "I can help with...", "sessionId": "demo" }
```

### Docker

```bash
docker build -t crowclaw .
docker run -p 8787:8787 -e OPENAI_API_KEY=sk-... crowclaw
```

## End-to-End Example

A complete agent that uses tools, matches skills, and responds:

```typescript
import { AgentLoop } from '@crowclaw/core'
import { OpenAICompatibleProvider } from '@crowclaw/providers'
import { createDefaultWorkerRegistry } from '@crowclaw/tools'
import { InMemorySessionStore } from '@crowclaw/storage'

// 1. Set up provider
const provider = new OpenAICompatibleProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: 'gpt-4o',
})

// 2. Create tool registry
const tools = createDefaultWorkerRegistry()

// 3. Create agent loop
const agent = new AgentLoop(provider, tools, new InMemorySessionStore(), {
  maxToolIterations: 8,
  runtimeName: 'my-agent',
})

// 4. Run
const result = await agent.run({
  agentId: 'my-agent',
  sessionId: 'session-1',
  userMessage: 'What time is it?',
})

console.log(result.finalResponse)
// "The current time is 2026-04-12T15:30:00.000Z"
console.log(result.toolResults)
// [{ toolName: 'time', ok: true, output: '2026-04-12T15:30:00.000Z' }]
```

## What CrowClaw Does

- **Multi-turn agent loop** — tool dispatch, retries, fallbacks, approval gates, budget control
- **Tool registry** — terminal execution, file I/O, web search/crawl, browser automation, vision, TTS, delegation
- **Provider abstraction** — OpenAI-compatible + Anthropic with native tool calling and streaming
- **Gateway** — webhook normalization and outbound message sending for Telegram, Discord, Slack, WhatsApp, Signal, Email, Matrix, SMS
- **MCP support** — consume external tools via Model Context Protocol (HTTP + stdio transports)
- **Skill system** — Markdown-based skill definitions (SKILL.md) that inject domain knowledge into the agent's system prompt
- **Learning loop** — extract skills from conversations, publish them, and have them automatically influence future agent behavior
- **Batch processing** — process JSONL prompt datasets through the agent, export trajectories in JSONL or ShareGPT format
- **Checkpoint/rollback** — save session state at any point, restore to a checkpoint, replay with different configuration
- **Scheduled execution** — cron-style jobs that run the agent on a schedule with optional gateway delivery
- **Presets** — agent identity presets, toolset bundles, MCP server configurations
- **Security** — SSRF protection, prompt injection scanning, PII redaction, auth rate limiting, XSS prevention
- **Structured logging** — JSON logger with request correlation, replacing console.log
- **SSE event bus** — real-time push for chat, gateway, job, and session events via `/api/events`
- **CLI** — interactive REPL with tab completion, slash commands, streaming display
- **Web dashboard** — Lit Web Components UI for tools, skills, gateway, MCP, presets, and settings

## Architecture

```
                    +-------------------------------------+
                    |         Agent Loop (core)           |
                    |   orchestration . retries .          |
                    |   fallbacks . checkpoints           |
                    +---------+-----------+---------------+
                              |           |
              +-------+-------+           +-------+-------+
              v       v       v           v       v       v
        +----------+ +-----+ +--------+ +------+ +----------+
        | Providers| |Tools| | Memory | |Skills| | Gateway  |
        | OpenAI   | |38+  | | scoped | |learn | | webhook  |
        | Anthropic| |MCP  | | recall | |match | | outbound |
        +----------+ +-----+ +--------+ +------+ +----------+
                                            |           |
                                    +-------+     +-----+
                                    v             v
                              +-----------+ +----------+
                              | Learning  | | Scheduler|
                              | pipeline  | | executor |
                              | batch     | | delivery |
                              +-----------+ +----------+
```

### Package Map

| Layer            | Packages                                                                   |
| ---------------- | -------------------------------------------------------------------------- |
| **Core**         | `core` . `providers` . `plugins`                                           |
| **Tools**        | `tools` . `workspace` . `sandbox-executor`                                 |
| **Persistence**  | `storage` . `memory`                                                       |
| **Intelligence** | `learning` (skills, batch, trajectory) . `scheduler` (execution, delivery) |
| **Protocol**     | `mcp` . `mcp-server` . `acp`                                               |
| **Delivery**     | `gateway`                                                                  |
| **Runtime**      | `runtime-node` . `runtime-cloudflare`                                      |
| **Interface**    | `cli` . `web`                                                              |
| **Infra**        | `shared`                                                                   |

## Providers

```typescript
import {
  OpenAICompatibleProvider,
  AnthropicProvider,
} from '@crowclaw/providers'

// Works with any OpenAI-compatible API (OpenAI, OpenRouter, local models, etc.)
const provider = new OpenAICompatibleProvider({
  apiKey: process.env.OPENAI_API_KEY,
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-4o',
})

// Anthropic with native tool calling + prompt caching
const anthropic = new AnthropicProvider({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4',
  promptCaching: true,
})
```

The provider interface is model-agnostic. Any endpoint that implements the OpenAI chat completions API works. A model metadata catalog is included for pricing and context window lookups.

## Presets

### Agent Presets

Pre-configured agent identities that set role, goal, and recommended tools:

```typescript
import { getAgentPreset, listAgentPresetNames } from '@crowclaw/core'

const preset = getAgentPreset('coding-assistant')
// { name: 'Coding Assistant', role: 'Senior software engineer', goal: '...', tools: [...] }
```

Available: `coding-assistant` . `research-agent` . `devops-engineer` . `code-reviewer` . `data-analyst` . `technical-writer` . `security-auditor` . `project-manager` . `api-designer` . `fullstack-developer` . `sysadmin` . `creative-writer` . `database-admin` . `test-engineer` . `ml-engineer`

### Toolset Presets

Named tool bundles for different workflows:

Available: `minimal` . `web` . `terminal` . `workspace` . `memory` . `mcp` . `research` . `devops` . `creative` . `full`

### MCP Presets

One-line connection to official MCP servers:

```typescript
import { createMcpFromPreset } from '@crowclaw/mcp'

const client = createMcpFromPreset('github', {
  token: process.env.GITHUB_TOKEN,
})
```

Available: `filesystem` . `github` . `braveSearch` . `memory` . `puppeteer` . `fetch` . `postgres` . `sqlite` . `slack` . `googleDrive` . `googleMaps` . `everart` . `sequentialThinking` . `everything` . `time`

## Gateway

CrowClaw's gateway handles webhook normalization (inbound) and message delivery (outbound) for messaging platforms. It is **not** a persistent connection manager like some frameworks — it operates on a request/response model, which makes it compatible with serverless deployments.

```typescript
import {
  normalizeTelegramWebhook,
  sendTelegramMessage,
} from '@crowclaw/gateway'

// Inbound: normalize webhook payload
const message = normalizeTelegramWebhook(webhookBody)
// { platform: 'telegram', text: '...', channelId: '...', userId: '...' }

// Outbound: send a message
const result = await sendTelegramMessage(botToken, chatId, 'Hello!')
// { ok: true, platform: 'telegram', messageId: '123' }
```

### Access Policy

DM and group access control inspired by the pairing/allowlist patterns used in personal agent frameworks:

```typescript
import {
  evaluateAccess,
  createDefaultAccessPolicy,
  generatePairingCode,
} from '@crowclaw/gateway'

const policy = createDefaultAccessPolicy()
// { dmPolicy: 'pairing', groupPolicy: 'open', requireMention: true, ... }

const decision = evaluateAccess(message, policy, isGroup, pendingPairings)
// { allowed: false, reason: 'pairing-required', pairingCode: 'A3K9HN2P' }
```

Supported platforms: Telegram . Discord . Slack . WhatsApp . Signal . Email . Matrix . SMS . Generic Webhooks

Outbound messages include per-platform rate limiting and retry with exponential backoff.

## Security

Every outbound `fetch()` in web tools goes through SSRF validation. Prompt injection detection uses pattern matching (not ML — fast but has limits). PII redaction covers common US patterns.

```typescript
import {
  validateFetchUrl,
  scanForInjection,
  redactPII,
  containsSecrets,
} from '@crowclaw/core'

validateFetchUrl('http://169.254.169.254/metadata')
// { safe: false, reason: 'URL resolves to private/internal network' }

scanForInjection('ignore previous instructions and...')
// { safe: false, riskScore: 6, threats: ['ignore...previous...instructions'] }
// Note: keyword-based detection. Not a substitute for input sanitization.

redactPII('SSN: 123-45-6789')
// { text: 'SSN: [SSN_REDACTED]', redactedCount: 1 }
```

**What the security layer does NOT cover:**

- Advanced prompt injection (adversarial, multi-step, encoded)
- DNS rebinding attacks
- Sandbox escape prevention (depends on execution backend)

## Skills & Learning

Skills are Markdown files with YAML frontmatter (SKILL.md format). The agent reads them as instructions — they don't execute code. Built-in skills cover common developer workflows.

```typescript
import {
  loadBuiltInSkills,
  LearningPipeline,
  InMemorySkillStore,
} from '@crowclaw/learning'

const store = new InMemorySkillStore()
await loadBuiltInSkills(store)

const pipeline = new LearningPipeline(store)
const matches = await pipeline.findRelevantSkills('deploy to vercel')
```

Skill matching uses keyword overlap (not embeddings). It works well for exact trigger phrases but may miss semantic matches.

## Learning Loop

CrowClaw implements a closed learning loop:

```
Conversation → Skill Draft → Review → Publish → SkillRegistry → Agent Prompt
     ↑                                                              |
     └──────────────────── improved behavior ───────────────────────┘
```

```typescript
import {
  LearningPipeline,
  InMemorySkillStore,
  SkillRegistry,
} from '@crowclaw/learning'

const store = new InMemorySkillStore()
const registry = new SkillRegistry({ skillStore: store })

const pipeline = new LearningPipeline(store)
pipeline.setRegistry(registry)

// Auto-capture: extracts skill from conversation if task was completed
const draft = await pipeline.autoCapture(session.messages, 'deploy-workflow')

// Review and publish
if (draft) {
  const published = await pipeline.publishDraft(draft.id)
  // `published` is now in the registry and will be injected into future runs
}

// Skills from all sources are resolved for AgentLoop
const skills = registry.resolve()
// → [built-in skills] + [learned skills] + [local SKILL.md files]
```

## Batch Processing

Process prompt datasets and export conversation trajectories:

```typescript
import {
  parseJsonlPrompts,
  runBatch,
  batchToTrajectories,
  exportTrajectoryJsonl,
} from '@crowclaw/learning'

// Parse JSONL input
const prompts = parseJsonlPrompts(await readFile('dataset.jsonl', 'utf-8'))

// Run through agent
const summary = await runBatch(prompts, agentRunFn, {
  runName: 'eval-run-1',
  concurrency: 3,
  timeoutMs: 120_000,
  onProgress: (p) => console.log(`${p.completed}/${p.total}`),
})

// Export trajectories
const trajectories = batchToTrajectories(summary)
const jsonl = exportTrajectoryJsonl(trajectories)
await writeFile('trajectories.jsonl', jsonl)

console.log(
  `${summary.succeeded}/${summary.total} succeeded, avg ${summary.avgDurationMs}ms`,
)
```

## Checkpoints

Save and restore conversation state at any point:

```typescript
import {
  createCheckpoint,
  restoreFromCheckpoint,
  createReplaySession,
  InMemoryCheckpointStore,
} from '@crowclaw/core'

const cpStore = new InMemoryCheckpointStore()

// Save checkpoint after iteration 3
const cp = createCheckpoint(
  session,
  toolResults,
  3,
  'iteration',
  'before-deploy',
)
await cpStore.save(cp)

// Restore to checkpoint
const restored = restoreFromCheckpoint(cp, currentSession)

// Or replay from checkpoint in a new session
const replaySession = createReplaySession(cp)
```

## Scheduled Execution

Run agent tasks on a schedule with optional delivery:

```typescript
import {
  createScheduledAgentJob,
  SchedulerExecutor,
  InMemorySchedulerStore,
} from '@crowclaw/scheduler'

const store = new InMemorySchedulerStore()
const executor = new SchedulerExecutor(store, agentRunFn, deliveryFn)

// Create a job
const job = createScheduledAgentJob({
  id: 'daily-briefing',
  schedule: 'every:1440m', // every 24 hours
  task: 'Generate a daily project status briefing',
  deliverTo: {
    platform: 'telegram',
    config: { botToken: '...', chatId: '...' },
  },
  maxRuns: 30,
})
await store.saveJob(job)

// Execute due jobs (call this from a cron trigger or setInterval)
const results = await executor.tick()
```

## Known Limitations

- **In-memory checkpoint and memory stores** -- conversation state and memories are lost on restart (except scheduler jobs, which use `FileSchedulerStore`). Persistent SQLite backend planned for v0.3.0.
- **Bag-of-words embeddings** -- `EmbeddingMemoryStore` uses a lightweight hash-based approach, not a real embedding model. Adequate for keyword-heavy recall but misses semantic similarity. Real embedding provider planned for v0.3.0.
- **Cloudflare runtime** is functional but has narrower override support than Node.js -- local SKILL.md loading, persona directories, and some execution overrides are Node-only.

## Environment Variables

```bash
# LLM Providers (set at least one)
OPENAI_API_KEY=           # OpenAI or any compatible API key
OPENAI_BASE_URL=          # Default: https://api.openai.com/v1
OPENAI_MODEL=             # Default: gpt-4o
ANTHROPIC_API_KEY=        # Anthropic API key

# Gateway (optional — needed only if using platform integrations)
TELEGRAM_BOT_TOKEN=       # From @BotFather
SLACK_SIGNING_SECRET=     # From Slack app settings

# MCP (optional)
MCP_BASE_URL=             # MCP server URL for HTTP transport

# Persona & Skills (optional)
CROWCLAW_PERSONA_DIR=     # Path to persona markdown files (SOUL.md, IDENTITY.md, etc.)
CROWCLAW_SKILL_DIR=       # Path to local SKILL.md directory

# Media tools (optional — tools degrade gracefully without these)
VISION_API_KEY=           # OpenAI API key for vision analysis
IMAGE_GEN_API_KEY=        # OpenAI API key for DALL-E image generation
```

## Test Suite

```bash
npm run typecheck   # TypeScript type checking
npm test            # Vitest — covers all subsystems
```

Test coverage includes: agent loop, providers, tools, memory, gateway (normalization + access policy), MCP, ACP, CLI, security (SSRF wiring), browser, delegation, learning, plugins, scheduler, workspace, configuration API, and E2E wiring.

## Project Structure

```
crowclaw/
├── packages/
│   ├── core/              # Agent loop, types, prompt builder, security, presets
│   ├── providers/         # OpenAI-compatible, Anthropic, streaming, model catalog
│   ├── tools/             # Tool definitions, toolset presets, pipelines
│   ├── sandbox-executor/  # Local, Docker, SSH, Playwright execution
│   ├── storage/           # Session + memory stores (in-memory, D1)
│   ├── memory/            # Scoped remember/recall
│   ├── learning/          # Skill extraction, matching, registry, batch runner, trajectory
│   ├── mcp/               # MCP client (HTTP + stdio), presets
│   ├── mcp-server/        # MCP server (expose CrowClaw as MCP provider)
│   ├── acp/               # ACP adapter (Zed, JetBrains, Neovim)
│   ├── gateway/           # Webhook normalization, outbound send, access policy
│   ├── plugins/           # Lifecycle hooks
│   ├── scheduler/         # Cron/interval job scheduling
│   ├── workspace/         # Runtime-neutral file abstraction
│   ├── runtime-node/      # Node.js HTTP runtime + config store
│   ├── runtime-cloudflare/ # Cloudflare Workers + Durable Objects
│   ├── cli/               # Interactive REPL + slash commands
│   ├── shared/            # Cross-runtime type abstractions
│   └── web/               # Web dashboard
├── tests/
├── docs/
├── Dockerfile
└── .github/workflows/ci.yml
```

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md).

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

## Design Heritage

CrowClaw is built on patterns distilled from studying dozens of agent frameworks. See [awesome-agent-frameworks](https://github.com/subinium/awesome-agent-frameworks) for the full survey. Below are the primary influences and what we adopted from each.

### Hermes Agent (Python, NousResearch)

The original foundation. CrowClaw started as a TypeScript port of [Hermes Agent](https://github.com/NousResearch/hermes-agent)'s multi-turn agent loop.

| Inspired by | CrowClaw Implementation |
|---|---|
| Multi-turn tool loop with retries and fallbacks | `AgentLoop` in `@crowclaw/core` |
| Self-improving skill extraction from conversations | `LearningPipeline` with LLM-powered extraction via `SkillExtractionProvider` |
| Credential pooling with failover rotation | `CredentialPool` in `@crowclaw/providers` -- round-robin, 429 cooldown, rate limit header tracking |
| Prompt caching (Anthropic cache breakpoints) | `AnthropicProvider` with `cache_control` on system prompt and tool definitions |
| Real cron expressions for scheduled tasks | `parseCron()` in `@crowclaw/scheduler` -- standard 5-field cron |
| Batch processing and trajectory export | `runBatch()` + `exportTrajectoryJsonl()` in `@crowclaw/learning` |
| Extensive built-in tool set | 39+ tools including 5 git tools, vision (real API), TTS, delegation |
| Token budget and context compression | Token-aware budget with LLM-powered summarization fallback |

### OpenClaw

Dashboard UX, skill format, and persona system were shaped by studying [OpenClaw](https://docs.openclaw.ai)'s operator experience.

| Inspired by | CrowClaw Implementation |
|---|---|
| [SKILL.md format](https://docs.openclaw.ai/tools/skills) with YAML frontmatter | `parseSkillFile()` / `renderSkillFile()` in `@crowclaw/core` |
| Gateway webhook normalization | 9 platform normalizers in `@crowclaw/gateway` |
| [SoulSpec](https://soulspec.org/) persona files (SOUL.md, IDENTITY.md, USER.md) | `PersonaRegistry` with `scanPersonaDirectories()` in `@crowclaw/core` |
| Web dashboard with live agent management | 5-tab dashboard (Chat / Agent / Connect / Automate / Settings) with SSE streaming |
| Cost tracking visualization | `DetailedUsageTracker` with per-session cost, token breakdown in dashboard |
| Config presets as MCP+Skill+Tool bundles | `ConfigPreset` in `FileConfigStore` -- distinct from agent personas |
| Provider fallback chain | 5-slot config (primary / fallback / vision / compression / embedding) with UI |
| Skill rating and refinement | `rateSkill()` with LLM-powered merge of new insights into existing skills |

### NemoClaw and NeMo Agent Toolkit (NVIDIA)

Security sandboxing drew from [NemoClaw](https://github.com/NVIDIA/NemoClaw) (NVIDIA's hardened deployment layer for OpenClaw agents). Observability and memory patterns drew from [NeMo Agent Toolkit](https://github.com/NVIDIA/NeMo-Agent-Toolkit), a separate NVIDIA project.

| Source | Inspired by | CrowClaw Implementation |
|---|---|---|
| NemoClaw | Sandboxed execution with declarative security policy | `SecurityPolicy` wired into `AgentLoop` -- credential redaction, injection scanning, command blocking |
| NeMo Agent Toolkit | Token/cost/latency observability | `DetailedUsageTracker` per provider call with `estimateCostUsd()` |
| NeMo Agent Toolkit | Pluggable memory backends | `EmbeddingMemoryStore` with cosine similarity recall, TTL, deduplication |
| NeMo Agent Toolkit | Agent checkpoint and rollback | `createCheckpoint()` / `restoreFromCheckpoint()` with auto-checkpoint on each iteration |
| NeMo Agent Toolkit | MCP protocol support | `McpClient` with HTTP + stdio transports, 17+ presets, OAuth device code flow |
| NeMo Agent Toolkit | User modeling from interactions | `UserModelService` tracking expertise areas and preferences |

### Gaps We Identified Across Frameworks

While building CrowClaw we noticed common gaps that no single reference framework fully addressed. Our solutions:

- **Scheduler with built-in delivery** -- cron triggers exist in most frameworks, but few connect job output directly to messaging platforms. `AutonomousScheduler` integrates execution with gateway delivery.
- **Security audit transparency** -- `SecurityAuditLog` records every redaction, scan, and block decision. The dashboard exposes a security grade (A-F) so operators can see what the security layer is actually doing.
- **Deny-by-default webhooks** -- all inbound gateway messages require platform-specific signature verification before reaching the agent.
- **Persistent config store** -- `FileConfigStore` survives restarts without requiring environment variables or re-configuration.

## License

[MIT](./LICENSE)

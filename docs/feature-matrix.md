# CrowClaw Feature Matrix

Current capability status across all subsystems.

| Capability bucket | CrowClaw target | Current status |
| --- | --- | --- |
| Agent loop | `packages/core` runtime-agnostic agent loop | partial-to-strong |
| Provider routing | TS provider adapter layer (OpenAI / Anthropic / custom) | partial |
| Tool registry | `packages/tools` — manifests + dispatch | partial-to-strong |
| Terminal tools | sandbox-backed tools + runtime routes | partial |
| File mutation | `packages/workspace` + tool/runtime adapters | partial-to-strong |
| Session state | generic storage contracts + runtime-backed stores | partial-to-strong |
| Session search | D1-backed and in-memory search adapters | partial-to-strong |
| Memory | `packages/memory` + storage adapters | partial |
| Gateway adapters | normalized gateway layer + runtime handlers | partial |
| Browser tooling | sandbox/browser tools + runtime routes | partial |
| MCP | `packages/mcp` + runtime bridge(s) + tool surface | partial |
| Skill generation | `packages/learning` — 60 built-in skills + learning pipeline | partial-to-strong |
| CLI/TUI | `packages/cli` — REPL + 32 slash commands | partial-to-strong |
| Cloudflare runtime | `packages/runtime-cloudflare` | partial-to-strong |
| Node runtime | `packages/runtime-node` | partial-to-strong |
| Other runtimes | runtime adapter packages | planned |
| Scheduler / cron | `packages/scheduler` | partial |
| Plugins | `packages/plugins` — context/memory/plugin hooks | partial-to-strong |
| RL / training | likely later / optional | deferred |

## Status definitions
- `partial-to-strong` — real code plus regression coverage, but depth gaps remain.
- `partial` — meaningfully implemented but still missing some depth.
- `deferred` — intentionally outside the current shipping slice.
- `planned` — direction is known, implementation has not started.

# CrowClaw Design Philosophy

CrowClaw is a crow that learns from every agent framework and evolves. It watches Claude Code, LangChain, CrewAI, AutoGen, Hermes — absorbs the patterns that work, discards the bloat, and distills them into a single lightweight TypeScript runtime. This document is how we build.

## 1. Core Principles

**Zero-dep core.** `@crowclaw/core` has no `dependencies`. No axios, no lodash, no zod. If Node ships it, use it. If it needs a polyfill, it belongs in a runtime adapter, not core. This is non-negotiable — every dependency is a liability on the edge.

**Runtime-agnostic.** Core logic runs on Node, Cloudflare Workers, Deno, and the browser. No `fs`, no `process.env`, no Node-specific APIs in core. Runtime adapters (`runtime-node`, `runtime-cloudflare`) bridge the gap.

**Pattern distillation, not copying.** We study how LangChain chains tools, how CrewAI orchestrates roles, how Claude Code manages sessions. Then we implement the pattern fresh in our idiom. Never fork, never wrap, never vendor.

**Types over runtime validation.** If a tool definition is wrong, `tsc` should catch it before the agent ever runs. Generics, discriminated unions, and branded types are cheap. Runtime `if` checks for known shapes are a code smell.

**Plain files over databases.** Memory is markdown. Skills are YAML. Config is JSON. Everything is human-readable, git-trackable, and diffable. A developer should understand an agent's state by reading files, not querying a database.

## 2. Code Style

- **One file, one job.** If a file does two things, split it. `tool-registry.ts` registers tools. `tool-executor.ts` executes them.
- **Interfaces before implementations.** Define the contract in a `.types.ts` or at the top of the module. Write the implementation second. Consumers depend on the interface, never the class.
- **Pure functions by default.** Stateless, testable, composable. Use classes only when you need lifecycle management or shared mutable state (providers, sessions, stores).
- **Explicit error types.** Every operation that can fail returns a typed result or throws a typed error. Never `catch (e) { /* shrug */ }`. Catch as `unknown`, narrow with `instanceof`, propagate with `{ cause }`.
- **No magic.** No decorators that secretly register things. No global singletons populated at import time. Every behavior is traceable through explicit function calls and dependency injection.

## 3. Package Architecture

```
core          — agent loop, types, contracts (zero deps)
  tools       — tool definitions, registry, executor
  providers   — LLM provider abstractions
  memory      — memory read/write contracts
  storage     — session and state persistence contracts
  gateway     — inbound message normalization (Discord, Telegram, HTTP)
  mcp         — Model Context Protocol client
  mcp-server  — MCP server implementation
  plugins     — plugin system
  scheduler   — task scheduling
  sandbox-executor — sandboxed code execution
runtime-node        — Node.js adapter
runtime-cloudflare  — Cloudflare Workers adapter
cli                 — CLI entry point
web                 — dashboard UI
```

**Dependencies flow downward only.** `tools` may import from `core`. `runtime-node` may import from `tools`, `providers`, `storage`. Core never imports from a runtime. If you need a cycle, you're missing an interface.

**Runtime adapters are thin.** A runtime adapter wires contracts to platform APIs. It should be under 500 lines. If your adapter is fat, the business logic it contains belongs in a core package.

## 4. Testing Philosophy

**Test behaviors, not lines.** If the agent should retry on a 429, test that. Don't test that an internal counter incremented — that's an implementation detail.

**No external deps in unit tests.** Use `InMemoryStore` for storage, `EchoProvider` for LLM calls. If your test needs a network connection, it's an integration test — label and isolate it.

**Fake providers for tool tests.** `EchoProvider` returns predictable responses. Tool tests verify that the tool transforms input to output correctly, independent of any real LLM.

**Conformance tests for contracts.** Every storage backend (memory, file, KV) must pass the same `StorageConformance` test suite. Same for providers. This guarantees substitutability.

## 5. Dashboard / UI Design

**Dark, sharp, functional.** Dark background (`#1a1a2e` or similar), sharp corners (0 border-radius), generous whitespace. This is a management console, not a chatbot widget.

**Crow brand.** Red accent `#c0392b` for actions and highlights. Inter font. Monospace for code/logs. The UI should feel like a mission control terminal, not a SaaS landing page.

**Everything visible.** Tools, active sessions, memory entries, gateway connections, MCP servers — all on the dashboard. The operator should never wonder "what is the agent doing right now?"

**Zero external deps.** The dashboard is a single HTML file with embedded CSS and JS. No React, no Tailwind CDN, no build step. It loads instantly on any browser. If it needs a framework, we've over-engineered it.

## 6. Naming Conventions

| Thing | Pattern | Example |
|-------|---------|---------|
| Tools | `category.action` | `web.search`, `file.read`, `code.execute` |
| Packages | `@crowclaw/domain` | `@crowclaw/core`, `@crowclaw/gateway` |
| Interfaces | PascalCase | `ToolDefinition`, `StorageProvider` |
| Events | `namespace:event` | `tool:beforeExecute`, `agent:afterRun` |
| Files | kebab-case | `tool-registry.ts`, `echo-provider.ts` |
| Constants | UPPER_SNAKE | `MAX_RETRIES`, `DEFAULT_MODEL` |

Use `I` prefix on interfaces only when a class has the same name (`IStorage` vs `Storage` class). Prefer renaming the class (`FileStorage`) over prefixing the interface.

## 7. Security Posture

**SSRF protection.** Every outbound `fetch` in tools goes through a URL allowlist. Private IPs, localhost, and metadata endpoints are blocked by default.

**Prompt injection detection.** User input passes through injection heuristics before reaching the LLM. This is not foolproof — it's a speed bump that catches obvious attacks.

**PII redaction.** Available via `@crowclaw/core` utilities but opt-in. Operators choose their compliance posture.

**Sandbox isolation.** Code execution tools run in `sandbox-executor` with resource limits. No filesystem access, no network unless explicitly granted.

**Immutable security policies.** Security config is set at startup. The agent cannot relax its own constraints at runtime. An injected prompt cannot disable SSRF protection.

## 8. Contribution Guidelines

- **Small diffs.** One logical change per PR. If "and" appears in the PR title, split it.
- **Tests with every behavior change.** No exceptions. If you add a feature, add a test. If you fix a bug, add the regression test first.
- **No new dependencies unless clearly necessary.** Open an issue first. Explain why the standard library or existing code can't do it.
- **Match existing patterns.** Read three similar files before writing a new one. If the codebase uses factory functions, don't introduce a builder pattern without discussion.
- **Run `npm run preflight` before pushing.** Typecheck and tests must pass locally.

---

*The crow watches. The crow learns. The crow builds only what it needs.*

# CrowClaw — General Architecture

Date: 2026-04-11

## Goal
Build CrowClaw as a runtime-agnostic TypeScript agent framework with core packages and runtime-specific adapters.

## Principles
- Core logic should not depend on one deployment platform.
- Runtime-specific concerns should live in dedicated adapter packages.
- Storage, tools, providers, and memory should expose reusable contracts.
- CrowClaw should support multiple execution targets over time.

## Layer split
### Generic core layer
- `packages/core`
- `packages/providers`
- `packages/tools`
- `packages/storage`
- `packages/memory`
- `packages/gateway`

These packages define the agent loop, tool contracts, search/memory abstractions, and inbound message normalization.

### Runtime adapter layer
- `packages/runtime-node`
- `packages/runtime-cloudflare`
- future runtime packages such as `packages/runtime-web` if needed later

These packages handle request routing, deployment-specific bindings, and execution environment integration.

## Execution model
1. A runtime adapter receives a request/event.
2. It loads or creates session state via storage contracts.
3. The provider plans tool usage.
4. Tools execute through runtime-appropriate adapters.
5. The provider synthesizes a final response.
6. Storage/memory layers persist session and recall artifacts.

## Why this split matters
This keeps CrowClaw aligned with the user goal:
- CrowClaw first
- deployment target second

Cloudflare remains important, but it is an adapter and deployment path, not the identity of the whole codebase.

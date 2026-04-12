# ADR 0001: Use Workers + Durable Objects + Sandbox for CrowClaw

Date: 2026-04-11
Status: accepted

## Context
CrowClaw requires both:
- stateful orchestration and webhook/API handling
- real execution capabilities such as shell commands, file mutation, git operations, and long-running processes

Plain Workers are a strong fit for orchestration, but not for OS-level execution. Cloudflare Sandboxes/Containers provide the execution layer while staying within the Cloudflare platform.

## Decision
Adopt a split runtime:
- Workers + Durable Objects = control plane
- Sandbox/Containers = execution plane
- D1 + R2 + KV = storage plane

## Consequences
### Positive
- Stays fully on Cloudflare
- Preserves path to full feature completeness
- Keeps policy, auth, and routing centralized in Workers
- Gives coding/runtime tools a real Linux environment

### Negative
- More moving pieces than a pure Worker app
- Sandbox lifecycle, cold starts, and cost must be managed
- Some gateway SDKs may still need special handling

## Follow-ups
- Define sandbox lifecycle and pooling policy
- Define tool capability routing rules
- Define D1 schema and R2 object layout
- Build minimal end-to-end spike before large-scale implementation

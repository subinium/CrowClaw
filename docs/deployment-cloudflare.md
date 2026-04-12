# CrowClaw — Cloudflare Deployment Notes

Date: 2026-04-11

## Summary
Cloudflare is one of the runtime adapters implemented for CrowClaw. Node.js (`packages/runtime-node`) is the primary runtime target.

## Current adapter package
- `packages/runtime-cloudflare`

## Cloudflare-specific components
- Workers for HTTP/webhook orchestration
- Durable Objects for stateful session routing
- Sandbox/Containers for command/file/code execution
- D1 for structured storage and search
- R2 for artifacts and large blobs

## Current runtime flow
1. Worker receives a request
2. Worker routes to an Agent Durable Object
3. The Durable Object runs CrowClaw core logic
4. Tools execute via worker-native or sandbox-backed paths
5. D1/R2-backed stores persist the result

## Why Cloudflare stays isolated
Cloudflare-specific bindings, request routing, and sandbox integration should remain inside the runtime adapter package so the rest of CrowClaw can stay portable.

## Current status
This deployment path is implemented as an early adapter and still needs deeper production-hardening around:
- Sandbox lifecycle
- D1 migrations/search
- platform auth and secrets
- richer gateway integrations

# Contributing to CrowClaw

Thanks for your interest in CrowClaw.

## Current project stage

CrowClaw is in final-stage hardening before its initial public release.

The highest-value contributions right now are:
- closing remaining feature gaps
- strengthening tests around existing behavior
- reducing structural risk in oversized files
- improving deployment and operational readiness

## Before opening a PR

Please run:

```bash
npm run typecheck
npm test
```

## Contribution priorities

Prefer:
- small, reviewable diffs
- no new dependencies unless clearly necessary
- tests with every behavior change
- honest README/docs updates when behavior meaning changes

Avoid:
- cosmetic churn without product value
- large rewrites without verification
- new abstractions before repeated patterns justify them

## Architectural priorities

Mainline target:
- runtime-agnostic TypeScript core
- Node runtime

Secondary target:
- Cloudflare compatibility

If you're looking for what to work on, start from:
- `docs/finalization-plan.md`
- `docs/distillation-plan.md`

## Naming and provenance

CrowClaw is an independent TypeScript agent framework inspired by studying many open-source agent architectures.

Please do not remove:
- README disclaimers
- license notes

## Reporting issues

Helpful issues include:
- expected behavior
- actual behavior
- reproduction steps
- runtime/environment details
- relevant logs or failing tests

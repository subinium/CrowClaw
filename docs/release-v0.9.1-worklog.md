# Release v0.9.1 "Sentinel" — Worklog

Date opened: 2026-06-13
Branch: `feat/v0.9.1-sentinel`
Theme: **Security hardening + v0.9.0 debt closure + bounded feature wave 2.**

This release is driven by a full audit of the v0.9.0 codebase plus an upstream
research sweep across NousResearch/hermes-agent (v0.14–v0.16, post-Tenacity),
OpenClaw, and NVIDIA NemoClaw / NanoClaw. The audit found that of the 39 open
issues, 10 actually shipped in v0.9.0 (left open by mistake), 4 are partial
(blocked on one webhook-wiring item), and 25 were never started. The upstream
sweep surfaced ~25 net-new patterns worth tracking, several of them security
CRITICAL.

## Phase 0 — Audit conclusions

### Close as already-shipped (verified at file:line + tests pass)
`#297 #302 #304 #328 #330 #332 #333 #336 #337 #338` — every v0.9.0 CHANGELOG
claim was verified to have real implementation and passing tests. These get
closed with evidence comments, not re-implemented.

### v0.9.0 residual debt (the "Caveats" section, now actioned)
| Item | Severity | Where |
| --- | --- | --- |
| `#342` ACL webhook enforcement not wired (closes #294/#295/#318 at runtime; #294 is CVSS 8.1) | critical | `runtime-node/route-handlers.ts` |
| `#293` `recordRedactionDefaultApplied` never called — first-run audit event missing | warning | `runtime-node/config-store.ts` |
| `#297` duplicate local `writeSecretAtomic` in CLI → re-export `@crowclaw/shared` | warning | `cli/commands/secret-write.ts` |
| `#298/#333` CLI skills install + voice-clone still on `validateFetchUrl` → `assertSafeUrl` | warning | `cli/commands/skills.ts`, `tools/voice-clone.ts` |
| decimal.js worker-pool test failure (corrupted self-ref symlink in node_modules) | warning | `tests/markdown-renderer.test.ts` |
| README prose stale test count (line ~483 says 2,864; actual 3,575) | nit | `README.md` |

## Phase 1 — v0.9.1 implementation wave (this PR)

Security-led wave 2. Strict per-package file ownership; `runtime-node` agent
pre-adds all new config-schema fields + RuntimeEventType entries for the whole
wave so other agents consume via optional access (no shared-file races).

| ID | Title | Owner pkg | Source |
| --- | --- | --- | --- |
| #342 | ACL webhook ingress enforcement (closes #294/#295/#318) | runtime-node | audit |
| NEW | Promptware/Brainworm defense at tool-result + memory-recall chokepoints | core | hermes v0.15 |
| NEW | Control-plane / credential file protection (deny-list + symlink/traversal reject) | tools | hermes |
| NEW | Host-header / BadHost validation + SSRF hardening (CVE-2026-48710 class) | runtime-node | hermes v0.15 |
| NEW | WebSocket origin validation + exec-approval fail-closed-on-timeout | runtime-node/core | openclaw |
| #293 | First-run redaction-default audit event wiring | runtime-node | audit |
| #297 | `writeSecretAtomic` dedup re-export | cli | audit |
| #298/#333 | `assertSafeUrl` migration (skills + voice-clone) | cli/tools | audit |
| #301 | `/goal` persistent cross-turn goals (Ralph loop) | core | hermes v0.13 |
| #307 | Checkpoints v2 — pruner + retention + disk guardrail | storage | hermes v0.13 |
| #331 | MCP SSE transport (OAuth forwarding + keepalive + MEDIA image tags) | mcp | hermes v0.13 |
| #335 | 7-locale i18n (zh, ja, de, es, fr, uk, tr) | core/shared | hermes v0.13 |
| — | decimal.js test fix + README test-count prose | tests/docs | audit |

## Phase 2 — Backlog expansion (issues filed, deferred to wave 3+)

All net-new upstream patterns filed as issues so nothing is lost. Deferred
because they are L/XL refactors or need separate design sessions:
- Existing not-started: #303 (ProviderProfile ABC) + #319–#323 (5 providers),
  #305 (review-fork), #306 (Kanban XL), #308 (auto-resume), #311 (Curator),
  #312 (video_analyze), #313 (SearXNG web-split), #315/#316/#317 (channels),
  #326 (Spotify), #327 (Google Meet), #334 (models dashboard), #339 (Vercel
  Sandbox), #340 (Langfuse plugin), #341 (curator subcommands).
- Net-new (filed this release): session_search no-LLM FTS, agent-loop
  modularization, Session Control REST+SSE, LSP-on-write diagnostics, mTLS MCP,
  1h cross-session caching, OAuth provider expansion (xAI/Codex/Azure Entra),
  SkillSpector skill-risk scan, Skill Workshop quarantine, CDP browser,
  HEARTBEAT.md scheduling, SQLite store migration, kernel egress policy,
  declarative YAML network policy, inference-time credential injection, sudo
  brute-force detection, Bitwarden secrets backend, plugin-surface expansion,
  `/undo`, security posture tiers, ServiceManager abstraction.

## Verification gate (RESULT)
- `npm run build` — clean
- `npm run typecheck` — clean (0 errors)
- `npm test` — **3,752 tests passing** across 293 files (+177 over the 3,575
  baseline), 0 failures.

### Integration notes (gaps the parallel agents left, fixed during integration)
- 4 of 7 wave agents (W-RUNTIME/W-CORE/W-TOOLS/W-I18N) wrote their source but
  stalled before emitting manifests; a 2-agent completion pass finished #342 ACL
  enforcement, #293 redaction-audit call, and the #301 goal loop.
- Integration fixes: `shared/tsconfig.json` JSON include; `SupportedLocale` vs
  `SkillLocale` narrowing; persona `getActivePrompt` locale widening; the
  control-plane guard's over-broad basename ban (config.json/auth.json) corrected
  to location-based; Host-header validation now allows a missing Host (embedded /
  in-process path); WhatsApp stranger-gating made opt-in. Config-schema +
  control-plane + cli-toctou tests updated to match the corrected behavior.

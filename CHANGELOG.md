# Changelog

All notable changes to CrowClaw will be documented in this file.

> Releases v0.2.0 through v0.3.4 were tracked in GitHub Releases. See
> https://github.com/subinium/hermes-agent-typescript/releases for details.

## [0.3.6] — 2026-04-16 — Security, sync, and retry audit fixes

### Security (CRITICAL / HIGH)
- **Fail-close when bound to non-localhost without a dashboard token.** `runtime-node` previously only gated routes tagged as "dangerous". `/api/events`, `/api/sessions/:id/message`, `/api/mcp/call`, and `/ws` were left open, so an instance bound to `0.0.0.0` without `CROWCLAW_DASHBOARD_TOKEN` leaked live session events, accepted prompts, and executed tools. Every protected surface now returns 500 until a token is set; webhook routes keep working because they carry their own per-platform secret.
- **`POST /api/providers/config` no longer echoes stored apiKeys.** The previous handler merged the inbound payload with stored secrets and then responded with the raw merged config, leaking every persisted provider key — including slots the caller never touched. The POST response now uses the same `***` redaction as the GET handler.
- **Stop persisting provider apiKeys and gateway tokens to disk.** `FileConfigStore` wrote `apiKey` values in plaintext into `~/.crowclaw/runtime-config.json` despite a comment saying otherwise, and wrote `token: '***'` for gateway configs — which then reloaded as the literal string `'***'`, silently corrupting Telegram/Slack/Discord delivery on every restart. Secrets are now stripped before serialization; users provide them via env vars or the dashboard after a restart.
- **Dashboard auth no longer stores the raw token on the client.** `packages/web/ui/src/lib/{api,sse,ws}.ts` no longer keeps the token in `sessionStorage`, no longer attaches it as `Authorization: Bearer`, and no longer appends `?token=...` to the `/ws` URL (which leaked into access logs and Referer headers). Auth rides the existing HttpOnly cookie over same-origin credentials; the `/ws` upgrade handler now accepts that cookie and a new `POST /api/auth/logout` lets sign-out actually clear it. Server still accepts `Authorization: Bearer` from non-browser clients.

### Reliability (HIGH / MEDIUM)
- **Gateway retry now treats `{ok: false}` as a retryable failure.** `sendTelegramMessage` and friends report API errors as `{ok: false, error}` instead of throwing, so `executeWithRetry` used to return success on the very first failure and `GatewayRunner` would silently drop replies. The retry helper now detects the gateway envelope, retries with exponential backoff, and exposes the last error/value through `RetryResult`.
- **Config writes are serialized and atomic.** `FileConfigStore.persistToDisk()` was fire-and-forget (`void ...`), so back-to-back mutators raced on a full-file rewrite. Writes now chain through a shared promise queue and land via temp file + `rename()`, matching the snapshot of the state observed when the caller invoked the mutator.
- **`SessionMutex` refuses to evict a live chain.** At `maxSessions` capacity the old code deleted the oldest entry even if it was currently locked or queued, which let a subsequent `acquire()` on the evicted session create a fresh chain and run concurrently with the original holder. New behaviour: throw when adding a brand-new session would exceed the cap (existing sessions still queue).
- **`GatewayRunner.sleep()` cleans up its abort listener on timeout.** Long pollers no longer accumulate one `abort` listener per poll cycle.

### Tests
- `tests/provider-factory.test.ts`: gateway token / webhook secret / provider apiKey must never land on disk, and reloaded stores must not inherit the `***` placeholder.
- `tests/session-mutex.test.ts`: regression test for the overflow eviction bug.
- `tests/gateway-retry.test.ts`: `{ok:false}` results now drive retries and propagate the last error.
- Test count 2157 → 2161.

## [0.3.5] — 2026-04-16 — Dashboard contract drift fix + senior-pass cleanup

### Fixed
- **Dashboard contract drift (16+4 issues)**: aligned every UI `api()` call with the runtime endpoint shape. Highlights:
  - `POST /api/agent/preset`, `/api/toolset/select`, `/api/config-presets/switch` now accept `{name}` (UI was sending `{preset}`)
  - `/api/presets` returns `activeAgent`/`activeToolset`/`activeMcp` so the UI can render Active badges
  - `/api/skills` includes `requiredTools` so skill cards show tool badges
  - `/api/sessions` summary includes `title` derived from rename meta or first user message
  - `/api/sessions/active` strips non-serializable `AbortController`
  - `/api/security/events` honors `?severity=` filter
  - `/api/config/remote-access` includes `publicUrl`
  - `/api/gateway/telegram/webhook` GET flattens the `{ok, result}` envelope
  - `/api/gateway/:platform/probe` and `/api/providers/test` fall back to stored credentials so the dashboard never round-trips API keys
  - `/api/config/agent` UI now reads `data.config` wrapper
  - `/api/feedback` UI now reads `data.recent` (was `data.entries`)
  - `/api/config-presets/list` → `/api/config-presets` (path didn't exist)
  - WebSocket path corrected from `/api/ws` to `/ws`
  - SSE `tool-end` event uses `result`/`ok` (matches core wire format), no longer `output`/`success`
  - Provider config save no longer corrupts stored API keys with the `***` redaction placeholder
  - Scheduler dry-run reads `result.response` (was `result.output`)
- **Empty dashboard views on first login**: views were mounted before authentication, fetched 401, and froze with empty data. Now mounted only after `authenticated=true` so each `connectedCallback` fires with a valid cookie.
- **Real-time transport dies after fresh login**: `_connectTransport()` was started before auth, exhausted its 3-failure budget, and never reconnected. Moved into `_initApp()` which only runs after successful auth.
- **Duplicate `crowclaw-modal` registration**: app.ts and components/modal.ts both registered the same custom element name, throwing `NotSupportedError` at module load and breaking every view. App-level pairing modal renamed to `crowclaw-pairing-modal`.
- **CSP blocked WebSocket, Google Fonts, and highlight.js**: `connect-src 'self'` doesn't cover `ws:`/`wss:` in older browsers; the dashboard pulls Inter/JetBrains Mono from `fonts.googleapis.com` and highlight.js from `cdnjs.cloudflare.com`. CSP now explicitly allowlists each.
- **Auth rate limit locked out the dashboard**: `/api/auth/check` (a passive cookie status read the dashboard hits on every page load) was counted as an auth attempt, triggering 429 after 5 page loads. Limit now applies only to `POST /api/auth/verify` and is raised from 5 to 10/min.
- **`[session-meta]` markers leaked into the LLM context and chat UI**: the rename feature stores titles as `[session-meta] name=...` system messages. `AgentLoop.run`, `runStreaming`, and the `/history` endpoint now strip these before sending to the provider or to the dashboard.
- **Provider config corruption** when saving from the dashboard: GET `/api/providers/config` redacts API keys to `***`; POSTing the unchanged body wrote `***` over the real stored key. Server now detects the placeholder and preserves the stored secret. `null` slots are also preserved instead of being merged blindly.
- **Localhost auth bypass ignored HTTP method**: any local process could `POST`/`DELETE` to bypassed routes without a token. Bypass is now restricted to `GET` only.
- **`runtime-wiring-e2e` flake**: parallel test files raced on the shared `~/.crowclaw/runtime-config.json` disk store. `createNodeRuntime()` now auto-detects Vitest (`process.env.VITEST`) and defaults to in-memory config + `EchoProvider`, isolating test runs from local API keys.
- **Test pollution from local OpenRouter key**: provider resolution now skips env/config lookup in Vitest mode unless a provider is explicitly passed.
- **Dashboard auth UI**: card width was broken (`var(--sp-7)` is not a defined token), error didn't clear on input, no submitting state. Rebuilt with brand-tokenized layout, brand mark, sentence-case label, hover/focus transitions, and `Signing in…` state.
- **Session ID injection**: `POST /api/sessions` now validates client-supplied IDs against `/^[a-zA-Z0-9][a-zA-Z0-9_:.-]{0,63}$/` to block path traversal and XSS payloads. Chat view `_createSession` no longer generates IDs client-side; the server is the authority.
- **`/api/sessions/active` leaked `AbortController`** as `{}` in the response.
- **Scheduler dry-run UI** showed an empty success toast because it read the wrong field.
- **`runtime-cloudflare/agent-do.ts`** now mirrors the title derivation in `summarizeSessionRecord` so cross-runtime parity is preserved.

### Added
- `tests/dashboard-contract.test.ts` — 14 contract tests pinning every fixed endpoint's exact request/response shape, so future drift fails CI immediately.
- `provider-factory.ts` now reads `OPENROUTER_API_KEY` (priority: CROWCLAW > ANTHROPIC > OPENAI > OPENROUTER > config file > Echo).
- Activate buttons on persona/toolset cards in the Identity tab — previously the wire was correct but there was no UI element to click.
- README + bottom of CHANGELOG: test count badge updated to 2157.

### Security
- HttpOnly cookie now used for SSE EventSource auth; token no longer leaked in URL query string.
- `/api/providers/test` and `/api/mcp/servers/:name/reconnect` UI handlers now check `data.ok` instead of always reporting success.
- Localhost bypass tightened to GET-only; the bypass list itself was trimmed to read-only routes.

## [Unreleased] — v0.2.0

### Added
- FileCheckpointStore for persistent checkpoint storage
- Memory search routing through MemoryService (TTL-aware)
- Dashboard: custom confirm/form modals, toast unification, code copy buttons
- Dashboard: syntax highlighting, message retry, button loading states
- Version sync automation (`scripts/sync-versions.mjs`)

### Fixed
- Promise.allSettled for parallel tool execution (prevents result loss on rejection)
- Streaming/non-streaming checkpoint trigger parity
- Completion checkpoint now saved in streaming path
- Dashboard: replaced all native prompt()/alert()/confirm() with custom UI

## [0.1.4] — 2026-04-13

### Added
- Agent loop reasoning guidance (tiered budget warnings, exhaustion synthesis)
- OpenClaw-style skill activation gates and token budget
- Tool result truncation, DuckDuckGo-aware search snippets
- InputSchema for all 46 tools
- Security hardening (API key redaction, command scanning, SSRF protection)
- Dashboard auth, streaming tool display, markdown rendering
- Auto skill capture after conversations
- Design heritage documentation (Hermes, OpenClaw, NeMo)

### Fixed
- Streaming tool name reverse-mapping (web_search -> web.search)
- Template literal escaping in dashboard (regex, backticks, quotes)
- Dashboard "Connecting..." bug

## [0.1.3] — 2026-04-12

### Added
- Initial dashboard with chat, tools, MCP, skills management
- Gateway auto-start for Telegram
- Config presets (MCP + Skill + Tool bundles)
- 46 built-in tools across 8 namespaces

## [0.1.0] — 2026-04-10

### Added
- Initial release: AgentLoop, ToolRegistry, MemoryService
- Multi-provider support with fallback chain
- Checkpoint/rollback system (in-memory)
- Learning pipeline with auto skill capture
- 19-package monorepo architecture

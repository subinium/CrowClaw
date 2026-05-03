# Memory Providers

CrowClaw v0.8.0 introduced a pluggable `MemoryProvider` interface so external memory backends — `mem0`, `Letta`, `MemGPT`, `Zep`, `supermemory`, `Honcho`, or any house-built store — can replace the default in-process backend without forking the runtime.

This document describes the contract, the reference implementations shipped with the framework, and the steps required to author and register your own provider.

## Why pluggable memory exists

Memory shape is the difference between a toy agent and a production agent. Forcing every consumer into CrowClaw's record format would do to memory what shipping fixed personas did to behaviour: lock users out of the rest of the ecosystem.

The interface was lifted verbatim from the [Hermes-agent `MemoryProvider` ABC](https://github.com/NousResearch/hermes-agent) so adapters written against either project port over with zero contract drift. CrowClaw is therefore an ecosystem participant, not a competitor — `mem0` integrations, `Letta` deployments, and `Honcho`-compatible stores all reuse the same lifecycle hooks.

## Contract

The interface lives in `packages/memory/src/provider.ts`. Every adapter implements it; the runtime depends on nothing else.

```ts
import type { MemoryRecord, MemoryScope, ConversationMessage } from '@crowclaw/memory';

export interface MemoryProvider {
  init?(config?: Record<string, unknown>): Promise<void>;

  prefetch?(sessionId: string, query: string, limit: number): Promise<MemoryRecord[]>;

  recall(
    sessionId: string,
    query: string,
    limit: number,
    scope?: MemoryScope,
    scopeKey?: string,
  ): Promise<MemoryRecord[]>;

  sync_turn?(
    sessionId: string,
    summary: string,
    metadata?: Record<string, unknown>,
  ): Promise<void>;

  store(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord>;
  delete(id: string): Promise<boolean>;
  list(sessionId: string, scope?: MemoryScope, limit?: number): Promise<MemoryRecord[]>;

  shutdown?(): Promise<void>;
}
```

The lifecycle methods carry the following semantics. Adapters MUST honour them — recall ordering and shutdown drain are part of the public contract, not implementation detail.

| Method | Required | Semantics |
|---|---|---|
| `init` | optional | Called once at runtime construction. Open connections, warm caches, validate config. Throwing here aborts runtime startup. |
| `prefetch` | optional | Called before the agent turn. Returns candidate memories for cache warming or batch reads. Falls through to `recall` if absent. |
| `recall` | required | Final memory selection. Ordering contract: relevance descending, then recency descending. The agent loop enforces the 5-record default cap, not the provider. |
| `sync_turn` | optional | Fire-and-forget post-turn write. The host does NOT await this. Adapters swallow their own errors; do not propagate them up. |
| `store` | required | Explicit user-issued save (e.g., dashboard "Remember this"). Returns the persisted record with `id` and `createdAt` populated. |
| `delete` | required | Hard delete by id. Returns `true` when a record was deleted. |
| `list` | required | List records for browsing or dashboard rendering. |
| `shutdown` | optional | Graceful drain on `SIGTERM`. Wait up to 10 seconds for in-flight `sync_turn` calls before resolving. |

`prefetch` and `recall` must complete in under 100ms p95 for a 1000-record session against the default in-process provider. `sync_turn` latency MUST NOT block the next agent turn.

## Reference implementation: `InMemoryMemoryProvider`

The default backend, exported from `@crowclaw/memory`, wraps an injected `MemoryStore` (typically `InMemoryMemoryStore` from `@crowclaw/storage`, or a D1-backed store in Cloudflare runtimes). It is the path most callers run on out of the box.

```ts
import { InMemoryMemoryProvider } from '@crowclaw/memory';
import { InMemoryMemoryStore } from '@crowclaw/storage';

const store = new InMemoryMemoryStore();
const provider = new InMemoryMemoryProvider(store);

const memories = await provider.recall('session-1', 'cloudflare deploy', 5);
```

Two implementation details are worth knowing about:

- **Drain tracking.** Every `sync_turn` invocation registers a tracked promise in a private `Set`. `shutdown()` drains the set with a 10-second cap. Adapters that do real post-turn work should track their promises the same way so `shutdown` cleans up after them.
- **TTL filtering.** Records carrying `metadata.ttlMs` are filtered out of `recall`/`list` results when expired. Adapters that mirror this filter MUST use the same `metadata.ttlMs` field, otherwise expired records leak through into prompts.

## Test implementation: `MockMemoryProvider`

For unit tests that exercise the agent loop without provisioning a real backend, construct a minimal mock satisfying the interface. This is the canonical no-op shape used in `tests/memory-provider.test.ts`:

```ts
import type { MemoryProvider } from '@crowclaw/memory';

const mock: MemoryProvider = {
  async recall() { return []; },
  async store(record) { return { ...record, id: 'mock', createdAt: new Date().toISOString() }; },
  async delete() { return false; },
  async list() { return []; },
};
```

Inject the mock through `createNodeRuntime({ memoryProvider: mock })`. Chat completes, no memories surface, and no errors are thrown.

## Honcho-compatible adapter example

`packages/memory/examples/honcho-compatible.ts` wraps a Honcho-style client (any object exposing `search` / `remember` / `forget` / `list` / `syncTurn` / `close`) into a `MemoryBackendPlugin` that the runtime auto-discovers from the plugin registry.

```ts
import { createHonchoCompatibleMemoryPlugin } from '@crowclaw/memory/examples/honcho-compatible.js';

const plugin = createHonchoCompatibleMemoryPlugin(myHonchoClient);
// register through the plugins manager — runtime picks it up automatically
```

Use the example as a copy-paste template when porting an existing client SDK. The plugin registration path is the lowest-friction way to ship a new backend: it composes with `runtime-node` and `runtime-cloudflare` without touching either.

## Adapter authoring guide

The shortest adapter is roughly thirty lines. The required steps:

1. **Implement the interface.** Start with `recall`, `store`, `delete`, `list`. Optional methods (`init`, `prefetch`, `sync_turn`, `shutdown`) are added as the upstream backend supports them.
2. **Persist every field the runtime writes.** The runtime depends on `summary`, `scope`, and `tags`. Adapters MAY persist additional fields, but MUST NOT drop these three.
3. **Track in-flight `sync_turn` promises.** If your adapter does real post-turn work, register the promise so `shutdown()` drains it cleanly. Mirror the pattern in `InMemoryMemoryProvider`.
4. **Swallow `sync_turn` errors.** The host does not await the call and does not see thrown errors. Log them yourself.
5. **Honour the recall ordering contract.** Relevance descending then recency descending. The runtime trusts this ordering for prompt budgeting.

A minimal Postgres-backed skeleton:

```ts
import type { MemoryProvider, MemoryRecord, MemoryScope } from '@crowclaw/memory';
import { Pool } from 'pg';

export class PostgresMemoryProvider implements MemoryProvider {
  constructor(private readonly pool: Pool) {}

  async init(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        summary TEXT NOT NULL,
        tags TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
  }

  async recall(sessionId: string, query: string, limit: number, scope?: MemoryScope): Promise<MemoryRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM memories
         WHERE session_id = $1
           AND ($3::text IS NULL OR scope = $3)
           AND summary ILIKE '%' || $2 || '%'
         ORDER BY created_at DESC LIMIT $4`,
      [sessionId, query, scope ?? null, limit],
    );
    return result.rows.map(rowToRecord);
  }

  async store(record: Omit<MemoryRecord, 'id' | 'createdAt' | 'lastAccessedAt'>): Promise<MemoryRecord> {
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    await this.pool.query(
      'INSERT INTO memories (id, session_id, scope, summary, tags) VALUES ($1, $2, $3, $4, $5)',
      [id, record.sessionId, record.scope, record.summary, record.tags ?? []],
    );
    return { ...record, id, createdAt };
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.pool.query('DELETE FROM memories WHERE id = $1', [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async list(sessionId: string, scope?: MemoryScope, limit = 50): Promise<MemoryRecord[]> {
    const result = await this.pool.query(
      `SELECT * FROM memories
         WHERE session_id = $1
           AND ($2::text IS NULL OR scope = $2)
         ORDER BY created_at DESC LIMIT $3`,
      [sessionId, scope ?? null, limit],
    );
    return result.rows.map(rowToRecord);
  }

  async shutdown(): Promise<void> {
    await this.pool.end();
  }
}

function rowToRecord(row: Record<string, unknown>): MemoryRecord {
  return {
    id: String(row.id),
    sessionId: String(row.session_id),
    scope: row.scope as MemoryScope,
    summary: String(row.summary),
    tags: (row.tags as string[]) ?? [],
    createdAt: (row.created_at as Date).toISOString(),
  };
}
```

Wire it into a runtime through `createNodeRuntime({ memoryProvider: new PostgresMemoryProvider(pool) })`.

## Configuration

The runtime accepts a custom provider through `createNodeRuntime` options. The relevant entry on `NodeRuntimeOptions` is documented in `packages/runtime-node/src/runtime-support.ts`:

```ts
import { createNodeRuntime } from '@crowclaw/runtime-node';
import { PostgresMemoryProvider } from './my-postgres-provider.js';

const runtime = createNodeRuntime({
  memoryProvider: new PostgresMemoryProvider(pool),
});
```

Resolution order at runtime construction:

1. `options.memoryProvider` — explicit injection wins.
2. The first `MemoryBackendPlugin` registered through the plugin manager — auto-discovered via `memoryProviderFromPluginRegistry`.
3. A default `InMemoryMemoryProvider` wrapping the supplied `memoryStore`.

Provider selection happens once at construction. Switching providers requires a runtime restart — this matches the Hermes contract and prevents mid-session drift between two backends.

If the env var `CROWCLAW_MEMORY_SUMMARIZE=true` is set, the runtime attaches an `llmSummarize` callback to the provider so session summaries can use the active LLM. Adapters that ship their own summarizer can ignore this hook entirely.

## Shutdown semantics

`shutdown()` exists because `sync_turn` is fire-and-forget. Without a drain step, `SIGTERM` would land while writes were still in flight, and the next agent turn would cold-start with stale memory.

The `InMemoryMemoryProvider` tracks every `sync_turn` promise in a private `Set` and drains it in `shutdown()` with a 10-second cap. The cap exists so a hung adapter cannot block process exit indefinitely.

The drain is asserted by `tests/memory-provider.test.ts` (`InMemoryMemoryProvider.shutdown drain`), which:

- Spawns a `sync_turn` whose body never resolves until manually unblocked.
- Calls `shutdown()` and confirms the returned promise is still pending.
- Unblocks the work and confirms `shutdown()` resolves.
- Re-runs the same flow with a stuck `sync_turn` and asserts the cap fires within the configured timeout.

Adapters that override `sync_turn` MUST register their promises in the same `inFlight` set (or supply their own equivalent drain mechanism). Otherwise `shutdown` returns immediately and the runtime exits with writes still pending — a silent data-loss bug.

## Out of scope

- Cross-provider migration tooling. Two backends, one record per session, no copy path.
- Vector-search abstractions. Different backends ship very different vector contracts; the interface deliberately omits them.
- Hot-swapping providers at runtime. Selection is one-shot at construction time.

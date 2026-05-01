/**
 * Shared memory-package types for the v0.8.0 Hermes pluggable MemoryProvider ABC
 * (issue #233).
 *
 * The canonical record shape lives in `@crowclaw/storage` so the storage layer
 * can persist/index it without a runtime dep on `@crowclaw/memory`. We re-export
 * it here under the same name so adapters and host code can import everything
 * memory-related from one place.
 */
export type { MemoryRecord } from '@crowclaw/storage';

/**
 * The three scopes a memory record can live under. Mirrors the storage-layer
 * `MemoryRecord['scope']` so they stay in lock-step.
 */
export type MemoryScope = 'session' | 'user' | 'workspace';

/**
 * Re-export the canonical `ConversationMessage` from `@crowclaw/core` so
 * provider implementations and tests can import everything memory-related
 * from one place. Memory already depends on core for `MemoryService`, so
 * this doesn't widen the dep graph.
 */
export type { ConversationMessage } from '@crowclaw/core';

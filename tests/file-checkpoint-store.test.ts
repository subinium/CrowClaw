import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { FileCheckpointStore } from '@crowclaw/storage';
import { createCheckpoint } from '@crowclaw/core';
import type { SessionState, ToolExecutionResult } from '@crowclaw/core';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeSession(overrides: Partial<SessionState> = {}): SessionState {
  return {
    agentId: 'agent-1',
    sessionId: 'session-1',
    messages: [
      { role: 'user', content: 'Hello', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'Hi there', createdAt: '2026-01-01T00:00:01.000Z' },
    ],
    updatedAt: '2026-01-01T00:00:01.000Z',
    lineage: { rootSessionId: 'session-1', compressionCount: 0 },
    ...overrides,
  };
}

function makeToolResult(overrides: Partial<ToolExecutionResult> = {}): ToolExecutionResult {
  return {
    toolName: 'echo',
    runtime: 'worker',
    ok: true,
    output: 'echoed',
    ...overrides,
  };
}

describe('FileCheckpointStore', () => {
  let store: FileCheckpointStore;
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'crowclaw-test-'));
    store = new FileCheckpointStore(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('saves and retrieves a checkpoint', async () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration', 'step-1');

    await store.save(cp);
    const loaded = await store.get(cp.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.sessionId).toBe('session-1');
    expect(loaded!.iteration).toBe(1);
    expect(loaded!.messages).toEqual(cp.messages);
    expect(loaded!.toolResults).toEqual(cp.toolResults);
    expect(loaded!.metadata).toEqual(cp.metadata);
  });

  it('returns null for non-existent checkpoint', async () => {
    expect(await store.get('nonexistent')).toBeNull();
  });

  it('lists checkpoints by session sorted by iteration', async () => {
    const session = makeSession();
    const cp1 = createCheckpoint(session, [], 1, 'iteration');
    const cp2 = createCheckpoint(session, [], 2, 'iteration');
    const cp3 = createCheckpoint(makeSession({ sessionId: 'session-2' }), [], 1, 'iteration');

    await store.save(cp2);
    await store.save(cp1);
    await store.save(cp3);

    const list = await store.listBySession('session-1');
    expect(list).toHaveLength(2);
    expect(list[0].iteration).toBe(1);
    expect(list[1].iteration).toBe(2);
  });

  it('gets latest checkpoint', async () => {
    const session = makeSession();
    const cp1 = createCheckpoint(session, [], 1, 'iteration');
    const cp2 = createCheckpoint(session, [], 2, 'iteration');

    await store.save(cp1);
    await store.save(cp2);

    const latest = await store.getLatest('session-1');
    expect(latest).not.toBeNull();
    expect(latest!.iteration).toBe(2);
  });

  it('getLatest returns null for unknown session', async () => {
    const result = await store.getLatest('nonexistent');
    expect(result).toBeNull();
  });

  it('deletes a checkpoint', async () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 1, 'iteration');

    await store.save(cp);
    const ok = await store.delete(cp.id);
    expect(ok).toBe(true);
    expect(await store.get(cp.id)).toBeNull();
  });

  it('delete returns false for unknown id', async () => {
    const deleted = await store.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('deletes by session', async () => {
    const s1 = makeSession({ sessionId: 'session-1' });
    const s2 = makeSession({ sessionId: 'session-2' });

    await store.save(createCheckpoint(s1, [], 1, 'iteration'));
    await store.save(createCheckpoint(s1, [], 2, 'iteration'));
    await store.save(createCheckpoint(s2, [], 1, 'iteration'));

    const count = await store.deleteBySession('session-1');
    expect(count).toBe(2);
    expect(await store.listBySession('session-1')).toHaveLength(0);
    expect(await store.listBySession('session-2')).toHaveLength(1);
  });

  it('handles empty/non-existent base directory gracefully', async () => {
    const emptyStore = new FileCheckpointStore(join(testDir, 'nope'));
    expect(await emptyStore.get('x')).toBeNull();
    expect(await emptyStore.listBySession('x')).toEqual([]);
    expect(await emptyStore.getLatest('x')).toBeNull();
    expect(await emptyStore.delete('x')).toBe(false);
    expect(await emptyStore.deleteBySession('x')).toBe(0);
  });

  it('listBySession filters by sessionId', async () => {
    const s1 = makeSession({ sessionId: 'session-1' });
    const s2 = makeSession({ sessionId: 'session-2' });

    await store.save(createCheckpoint(s1, [], 1, 'iteration'));
    await store.save(createCheckpoint(s2, [], 1, 'iteration'));
    await store.save(createCheckpoint(s1, [], 2, 'iteration'));

    const list = await store.listBySession('session-1');
    expect(list).toHaveLength(2);
    expect(list.every(cp => cp.sessionId === 'session-1')).toBe(true);
  });
});

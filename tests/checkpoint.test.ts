import { describe, expect, it, beforeEach } from 'vitest';
import type { SessionState, ToolExecutionResult, ConversationMessage, SessionCheckpoint } from '@crowclaw/core';
import {
  createCheckpoint,
  restoreFromCheckpoint,
  diffCheckpoints,
  createReplaySession,
  InMemoryCheckpointStore,
} from '@crowclaw/core';
import { InMemorySessionStore } from '@crowclaw/storage';
import { createNodeRuntime } from '../packages/runtime-node/src/index.js';

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

describe('createCheckpoint', () => {
  it('creates a checkpoint with correct fields', () => {
    const session = makeSession();
    const toolResults = [makeToolResult()];
    const cp = createCheckpoint(session, toolResults, 1, 'iteration', 'step-1');

    expect(cp.id).toMatch(/^cp-session-1-1-/);
    expect(cp.sessionId).toBe('session-1');
    expect(cp.iteration).toBe(1);
    expect(cp.createdAt).toBeTruthy();
    expect(cp.messages).toHaveLength(2);
    expect(cp.toolResults).toHaveLength(1);
    expect(cp.metadata).toEqual({
      agentId: 'agent-1',
      messageCount: 2,
      toolCallCount: 1,
      trigger: 'iteration',
      label: 'step-1',
    });
  });

  it('creates checkpoint without label', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 0, 'manual');
    expect(cp.metadata.label).toBeUndefined();
    expect(cp.metadata.trigger).toBe('manual');
  });

  it('supports all trigger types', () => {
    const session = makeSession();
    const triggers = ['iteration', 'manual', 'pre-dangerous', 'error', 'completion'] as const;
    for (const trigger of triggers) {
      const cp = createCheckpoint(session, [], 0, trigger);
      expect(cp.metadata.trigger).toBe(trigger);
    }
  });
});

describe('InMemoryCheckpointStore', () => {
  let store: InMemoryCheckpointStore;

  beforeEach(() => {
    store = new InMemoryCheckpointStore();
  });

  it('save/get round-trips a checkpoint', async () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration');

    await store.save(cp);
    const retrieved = await store.get(cp.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(cp.id);
    expect(retrieved!.sessionId).toBe(cp.sessionId);
    expect(retrieved!.messages).toEqual(cp.messages);
    expect(retrieved!.toolResults).toEqual(cp.toolResults);
    expect(retrieved!.metadata).toEqual(cp.metadata);
  });

  it('get returns null for unknown id', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('listBySession returns sorted checkpoints', async () => {
    const session = makeSession();
    const cp3 = createCheckpoint(session, [], 3, 'iteration');
    const cp1 = createCheckpoint(session, [], 1, 'iteration');
    const cp2 = createCheckpoint(session, [], 2, 'iteration');

    // Save in non-sorted order
    await store.save(cp3);
    await store.save(cp1);
    await store.save(cp2);

    const list = await store.listBySession('session-1');
    expect(list).toHaveLength(3);
    expect(list[0].iteration).toBe(1);
    expect(list[1].iteration).toBe(2);
    expect(list[2].iteration).toBe(3);
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

  it('getLatest returns most recent checkpoint', async () => {
    const session = makeSession();
    await store.save(createCheckpoint(session, [], 1, 'iteration'));
    await store.save(createCheckpoint(session, [], 3, 'iteration'));
    await store.save(createCheckpoint(session, [], 2, 'iteration'));

    const latest = await store.getLatest('session-1');
    expect(latest).not.toBeNull();
    expect(latest!.iteration).toBe(3);
  });

  it('getLatest returns null for unknown session', async () => {
    const result = await store.getLatest('nonexistent');
    expect(result).toBeNull();
  });

  it('delete removes a checkpoint', async () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 1, 'iteration');
    await store.save(cp);

    expect(store.size).toBe(1);
    const deleted = await store.delete(cp.id);
    expect(deleted).toBe(true);
    expect(store.size).toBe(0);

    const retrieved = await store.get(cp.id);
    expect(retrieved).toBeNull();
  });

  it('delete returns false for unknown id', async () => {
    const deleted = await store.delete('nonexistent');
    expect(deleted).toBe(false);
  });

  it('deleteBySession removes all checkpoints for a session', async () => {
    const s1 = makeSession({ sessionId: 'session-1' });
    const s2 = makeSession({ sessionId: 'session-2' });

    await store.save(createCheckpoint(s1, [], 1, 'iteration'));
    await store.save(createCheckpoint(s1, [], 2, 'iteration'));
    await store.save(createCheckpoint(s2, [], 1, 'iteration'));

    expect(store.size).toBe(3);
    const count = await store.deleteBySession('session-1');
    expect(count).toBe(2);
    expect(store.size).toBe(1);

    const remaining = await store.listBySession('session-2');
    expect(remaining).toHaveLength(1);
  });

  it('size reflects store count', async () => {
    expect(store.size).toBe(0);
    const session = makeSession();
    await store.save(createCheckpoint(session, [], 1, 'iteration'));
    expect(store.size).toBe(1);
    await store.save(createCheckpoint(session, [], 2, 'iteration'));
    expect(store.size).toBe(2);
  });
});

describe('restoreFromCheckpoint', () => {
  it('restores session messages from checkpoint', () => {
    const session = makeSession({
      messages: [
        { role: 'user', content: 'Hello', createdAt: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'Hi', createdAt: '2026-01-01T00:00:01.000Z' },
        { role: 'user', content: 'Do something bad', createdAt: '2026-01-01T00:00:02.000Z' },
        { role: 'assistant', content: 'Oops', createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    });

    const earlyMessages: ConversationMessage[] = [
      { role: 'user', content: 'Hello', createdAt: '2026-01-01T00:00:00.000Z' },
      { role: 'assistant', content: 'Hi', createdAt: '2026-01-01T00:00:01.000Z' },
    ];

    const checkpoint: SessionCheckpoint = {
      id: 'cp-test',
      sessionId: 'session-1',
      iteration: 1,
      createdAt: '2026-01-01T00:00:01.000Z',
      messages: earlyMessages,
      toolResults: [],
      metadata: {
        agentId: 'agent-1',
        messageCount: 2,
        toolCallCount: 0,
        trigger: 'iteration',
      },
    };

    const restored = restoreFromCheckpoint(checkpoint, session);

    expect(restored.session.messages).toHaveLength(2);
    expect(restored.session.messages[0].content).toBe('Hello');
    expect(restored.session.messages[1].content).toBe('Hi');
    expect(restored.session.updatedAt).toBeTruthy();
    expect(restored.session.agentId).toBe('agent-1');
    expect(restored.session.sessionId).toBe('session-1');
    expect(restored.toolResults).toEqual([]);
    expect(restored.loopState).toBeUndefined();
  });

  it('preserves existing lineage info', () => {
    const session = makeSession({
      lineage: { rootSessionId: 'root-1', compressionCount: 3 },
    });
    const cp = createCheckpoint(session, [], 1, 'manual');

    const restored = restoreFromCheckpoint(cp, session);
    expect(restored.session.lineage?.rootSessionId).toBe('root-1');
    expect(restored.session.lineage?.compressionCount).toBe(3);
    expect(restored.session.lineage?.lastCompressedAt).toBeTruthy();
  });

  it('creates default lineage when session has none', () => {
    const session = makeSession({ lineage: undefined });
    const cp = createCheckpoint(session, [], 1, 'manual');

    const restored = restoreFromCheckpoint(cp, session);
    expect(restored.session.lineage?.rootSessionId).toBe('session-1');
    expect(restored.session.lineage?.compressionCount).toBe(0);
  });

  it('restores toolResults from checkpoint', () => {
    const session = makeSession();
    const toolResults = [makeToolResult({ toolName: 'echo' }), makeToolResult({ toolName: 'search' })];
    const cp = createCheckpoint(session, toolResults, 2, 'iteration');

    const restored = restoreFromCheckpoint(cp, session);
    expect(restored.toolResults).toHaveLength(2);
    expect(restored.toolResults[0].toolName).toBe('echo');
    expect(restored.toolResults[1].toolName).toBe('search');
  });

  it('restores loopState when present', () => {
    const session = makeSession();
    const loopState = {
      currentIteration: 3,
      pendingToolCalls: [{ name: 'echo', input: { text: 'hello' } }],
      systemPrompt: 'You are helpful.',
      agentPreset: { role: 'engineer', goal: 'build things' },
    };
    const cp = createCheckpoint(session, [], 3, 'iteration', undefined, loopState);

    const restored = restoreFromCheckpoint(cp, session);
    expect(restored.loopState).toBeDefined();
    expect(restored.loopState!.currentIteration).toBe(3);
    expect(restored.loopState!.pendingToolCalls).toHaveLength(1);
    expect(restored.loopState!.systemPrompt).toBe('You are helpful.');
    expect(restored.loopState!.agentPreset?.role).toBe('engineer');
  });

  it('loopState is undefined when checkpoint has no loopState', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 1, 'manual');

    const restored = restoreFromCheckpoint(cp, session);
    expect(restored.loopState).toBeUndefined();
  });
});

describe('runtime checkpoint auto-resume', () => {
  it('restores in_progress checkpoints during runtime startup', async () => {
    const sessionStore = new InMemorySessionStore();
    const checkpointStore = new InMemoryCheckpointStore();
    const checkpointSession = makeSession({
      sessionId: 'startup-resume-session',
      messages: [
        { role: 'user', content: 'before restart', createdAt: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'checkpointed startup response', createdAt: '2026-01-01T00:00:01.000Z' },
      ],
    });
    const liveSession = makeSession({
      sessionId: 'startup-resume-session',
      messages: [
        ...checkpointSession.messages,
        { role: 'assistant', content: 'uncheckpointed startup text', createdAt: '2026-01-01T00:00:02.000Z' },
      ],
    });
    const checkpoint = createCheckpoint(checkpointSession, [], 2, 'iteration', 'in_progress');
    await sessionStore.put(liveSession);
    await checkpointStore.save(checkpoint);

    const runtime = createNodeRuntime({
      sessionStore,
      checkpointStore,
      schedulerStorePath: null,
      configStorePath: null,
    });
    const events: string[] = [];
    runtime.eventBus.subscribe((event) => {
      if (event.type === 'session:resumed') events.push(String(event.data.checkpointId));
    });
    await runtime.autoResumeStartupReady;

    const restored = await sessionStore.get('startup-resume-session');
    expect(restored?.messages.some((message) => message.content === 'uncheckpointed startup text')).toBe(false);
    expect(events).toContain(checkpoint.id);
    await runtime.shutdown();
  });

  it('skips startup auto-resume when autoResumeCheckpoints is false', async () => {
    const sessionStore = new InMemorySessionStore();
    const checkpointStore = new InMemoryCheckpointStore();
    const checkpointSession = makeSession({
      sessionId: 'startup-no-resume-session',
      messages: [
        { role: 'user', content: 'before restart', createdAt: '2026-01-01T00:00:00.000Z' },
      ],
    });
    const liveSession = makeSession({
      sessionId: 'startup-no-resume-session',
      messages: [
        ...checkpointSession.messages,
        { role: 'assistant', content: 'keep in-flight text', createdAt: '2026-01-01T00:00:02.000Z' },
      ],
    });
    await sessionStore.put(liveSession);
    await checkpointStore.save(createCheckpoint(checkpointSession, [], 1, 'iteration', 'in_progress'));

    const runtime = createNodeRuntime({
      sessionStore,
      checkpointStore,
      autoResumeCheckpoints: false,
      schedulerStorePath: null,
      configStorePath: null,
    });
    await runtime.autoResumeStartupReady;

    const restored = await sessionStore.get('startup-no-resume-session');
    expect(restored?.messages.some((message) => message.content === 'keep in-flight text')).toBe(true);
    await runtime.shutdown();
  });

  it('restores the latest in_progress checkpoint before the next turn', async () => {
    const sessionStore = new InMemorySessionStore();
    const checkpointStore = new InMemoryCheckpointStore();
    const checkpointSession = makeSession({
      sessionId: 'resume-session',
      messages: [
        { role: 'user', content: 'before crash', createdAt: '2026-01-01T00:00:00.000Z' },
        { role: 'assistant', content: 'checkpointed response', createdAt: '2026-01-01T00:00:01.000Z' },
      ],
    });
    const liveSession = makeSession({
      sessionId: 'resume-session',
      messages: [
        ...checkpointSession.messages,
        { role: 'assistant', content: 'uncheckpointed in-flight text', createdAt: '2026-01-01T00:00:02.000Z' },
      ],
    });
    await sessionStore.put(liveSession);
    await checkpointStore.save(createCheckpoint(checkpointSession, [], 1, 'iteration', 'in_progress'));

    const runtime = createNodeRuntime({
      sessionStore,
      checkpointStore,
      schedulerStorePath: null,
      configStorePath: null,
    });
    const response = await runtime.fetch(new Request('http://localhost/api/sessions/resume-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userMessage: 'continue' }),
    }));
    expect(response.status).toBe(200);

    const restored = await sessionStore.get('resume-session');
    expect(restored?.messages.some((message) => message.content === 'uncheckpointed in-flight text')).toBe(false);
    expect(restored?.messages.some((message) => message.content === 'continue')).toBe(true);
    await runtime.shutdown();
  });
});

describe('diffCheckpoints', () => {
  it('shows correct differences between checkpoints', () => {
    const session = makeSession();
    const toolResults1 = [makeToolResult({ toolName: 'echo' })];
    const cp1 = createCheckpoint(session, toolResults1, 1, 'iteration');

    const laterSession = makeSession({
      messages: [
        ...session.messages,
        { role: 'user', content: 'More work', createdAt: '2026-01-01T00:00:02.000Z' },
        { role: 'assistant', content: 'Done', createdAt: '2026-01-01T00:00:03.000Z' },
      ],
    });
    const toolResults2 = [
      ...toolResults1,
      makeToolResult({ toolName: 'search' }),
      makeToolResult({ toolName: 'write' }),
    ];
    const cp2 = createCheckpoint(laterSession, toolResults2, 3, 'iteration');

    const diff = diffCheckpoints(cp1, cp2);

    expect(diff.earlierId).toBe(cp1.id);
    expect(diff.laterId).toBe(cp2.id);
    expect(diff.iterationRange).toEqual([1, 3]);
    expect(diff.addedMessages).toBe(2);
    expect(diff.addedToolCalls).toBe(2);
    expect(diff.newMessages).toHaveLength(2);
    expect(diff.newMessages[0].content).toBe('More work');
    expect(diff.newToolResults).toHaveLength(2);
    expect(diff.newToolResults[0].toolName).toBe('search');
  });

  it('returns zero diffs for identical checkpoints', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration');

    const diff = diffCheckpoints(cp, cp);

    expect(diff.addedMessages).toBe(0);
    expect(diff.addedToolCalls).toBe(0);
    expect(diff.newMessages).toHaveLength(0);
    expect(diff.newToolResults).toHaveLength(0);
  });
});

describe('createReplaySession', () => {
  it('creates new session from checkpoint', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 2, 'manual');

    const replay = createReplaySession(cp);

    expect(replay.sessionId).toMatch(/^replay-session-1-/);
    expect(replay.agentId).toBe('agent-1');
    expect(replay.messages).toEqual(cp.messages);
    expect(replay.lineage?.rootSessionId).toBe('session-1');
    expect(replay.lineage?.compressionCount).toBe(0);
  });

  it('uses custom sessionId when provided', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 1, 'manual');

    const replay = createReplaySession(cp, 'custom-replay-id');
    expect(replay.sessionId).toBe('custom-replay-id');
  });

  it('messages are independent from checkpoint', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [], 1, 'manual');

    const replay = createReplaySession(cp);
    replay.messages.push({
      role: 'user',
      content: 'New message',
      createdAt: '2026-01-01T00:01:00.000Z',
    });

    expect(cp.messages).toHaveLength(2);
    expect(replay.messages).toHaveLength(3);
  });
});

describe('deep clone isolation', () => {
  it('createCheckpoint messages are independent from source session', () => {
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration');

    // Mutate the original session
    session.messages.push({
      role: 'user',
      content: 'Mutated',
      createdAt: '2026-01-01T00:01:00.000Z',
    });

    expect(cp.messages).toHaveLength(2);
    expect(session.messages).toHaveLength(3);
  });

  it('createCheckpoint toolResults are independent from source', () => {
    const session = makeSession();
    const toolResults = [makeToolResult()];
    const cp = createCheckpoint(session, toolResults, 1, 'iteration');

    toolResults.push(makeToolResult({ toolName: 'mutated' }));

    expect(cp.toolResults).toHaveLength(1);
    expect(toolResults).toHaveLength(2);
  });

  it('store.save creates independent copies', async () => {
    const store = new InMemoryCheckpointStore();
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration');

    await store.save(cp);

    // Mutate the original checkpoint
    cp.messages.push({
      role: 'user',
      content: 'Mutated after save',
      createdAt: '2026-01-01T00:01:00.000Z',
    });

    const retrieved = await store.get(cp.id);
    expect(retrieved!.messages).toHaveLength(2);
    expect(cp.messages).toHaveLength(3);
  });

  it('store.get returns independent copies', async () => {
    const store = new InMemoryCheckpointStore();
    const session = makeSession();
    const cp = createCheckpoint(session, [makeToolResult()], 1, 'iteration');
    await store.save(cp);

    const first = await store.get(cp.id);
    const second = await store.get(cp.id);

    first!.messages.push({
      role: 'user',
      content: 'Mutated',
      createdAt: '2026-01-01T00:01:00.000Z',
    });

    expect(first!.messages).toHaveLength(3);
    expect(second!.messages).toHaveLength(2);
  });
});

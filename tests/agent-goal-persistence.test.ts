/**
 * v0.9.1 "Sentinel" (#301): /goal persistent cross-turn goals (Ralph loop).
 *
 * Covers the GoalTracker primitive, the reminder/satisfaction helpers, and the
 * AgentLoop integration: set/get/clear API, event emission, per-turn budget
 * decrement, cross-turn persistence into SessionState.activeGoal, and
 * heuristic satisfaction that clears the goal.
 */

import { describe, expect, it } from 'vitest';
import {
  AgentLoop,
  GoalTracker,
  buildGoalReminder,
  heuristicGoalSatisfied,
  GOAL_EVENTS,
  type ActiveGoal,
  type AgentEventEmitter,
} from '@crowclaw/core';
import { EchoProvider } from '@crowclaw/providers';
import { InMemorySessionStore } from '@crowclaw/storage';
import { ToolRegistry, createEchoTool } from '@crowclaw/tools';

describe('GoalTracker (#301)', () => {
  it('runs the set/get/has/tick/clear lifecycle', () => {
    const t = new GoalTracker();
    expect(t.set('s', '   ')).toBeNull(); // empty/whitespace rejected
    const g = t.set('s', 'ship v1', { maxTurns: 3 });
    expect(g?.turnsRemaining).toBe(3);
    expect(t.has('s')).toBe(true);
    expect(t.get('s')?.text).toBe('ship v1');
    expect(t.tick('s')?.turnsRemaining).toBe(2);
    expect(t.clear('s')?.text).toBe('ship v1');
    expect(t.get('s')).toBeNull();
  });

  it('isolates goals per session', () => {
    const t = new GoalTracker();
    t.set('a', 'goal-a');
    t.set('b', 'goal-b');
    expect(t.get('a')?.text).toBe('goal-a');
    expect(t.get('b')?.text).toBe('goal-b');
    t.clear('a');
    expect(t.get('a')).toBeNull();
    expect(t.get('b')?.text).toBe('goal-b');
  });

  it('rehydrates from a persisted snapshot but never clobbers a live goal', () => {
    const t = new GoalTracker();
    t.rehydrate('s', { text: 'restored', turnsRemaining: 5, maxTurns: 10, setAt: '2026-01-01T00:00:00Z' });
    expect(t.get('s')?.text).toBe('restored');

    t.set('s2', 'live');
    t.rehydrate('s2', { text: 'stale', turnsRemaining: 9, maxTurns: 9, setAt: '2026-01-01T00:00:00Z' });
    expect(t.get('s2')?.text).toBe('live');
  });
});

describe('goal helpers (#301)', () => {
  const goal: ActiveGoal = { text: 'finish the migration', turnsRemaining: 4, maxTurns: 5, setAt: 'x' };

  it('buildGoalReminder renders the [GOAL] reminder with the turn budget', () => {
    const reminder = buildGoalReminder(goal);
    expect(reminder).toContain('[GOAL]');
    expect(reminder).toContain('finish the migration');
    expect(reminder).toContain('Turn 2 of 5');
  });

  it('buildGoalReminder returns null for no goal or an exhausted budget', () => {
    expect(buildGoalReminder(null)).toBeNull();
    expect(buildGoalReminder({ text: 'x', turnsRemaining: 0, maxTurns: 5, setAt: 'x' })).toBeNull();
  });

  it('heuristicGoalSatisfied detects a self-reported completion only', () => {
    expect(heuristicGoalSatisfied(goal, 'The goal is complete.')).toBe(true);
    expect(heuristicGoalSatisfied(goal, 'still working on it')).toBe(false);
  });
});

describe('AgentLoop goal API + Ralph-loop persistence (#301)', () => {
  const makeAgent = (events: Array<{ type: string; data: Record<string, unknown> }>) => {
    const tools = new ToolRegistry().register(createEchoTool());
    const store = new InMemorySessionStore();
    const eventBus: AgentEventEmitter = { emit: (type, data) => events.push({ type, data }) };
    const agent = new AgentLoop(new EchoProvider(), tools, store, { eventBus });
    return { agent, store };
  };

  it('setGoal emits session:goal_set and getGoal/clearGoal round-trip', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { agent } = makeAgent(events);
    const g = agent.setGoal('s1', 'ship the release', { maxTurns: 10 });
    expect(g?.text).toBe('ship the release');
    expect(events.some((e) => e.type === GOAL_EVENTS.set)).toBe(true);
    expect(agent.getGoal('s1')?.text).toBe('ship the release');
    expect(agent.clearGoal('s1')?.text).toBe('ship the release');
    expect(agent.getGoal('s1')).toBeNull();
  });

  it('persists the active goal across a turn and decrements the budget', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { agent, store } = makeAgent(events);
    agent.setGoal('s2', 'keep working toward the objective', { maxTurns: 5 });
    await agent.run({ agentId: 'crowclaw', sessionId: 's2', userMessage: 'what is the status?' });
    const session = await store.get('s2');
    expect(session?.activeGoal?.text).toBe('keep working toward the objective');
    expect(session?.activeGoal?.turnsRemaining).toBeLessThan(5);
  });

  it('clears the goal and emits session:goal_satisfied on a self-reported completion', async () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const { agent, store } = makeAgent(events);
    agent.setGoal('s3', 'finish the task', { maxTurns: 5 });
    // EchoProvider echoes the user message, so this becomes the assistant's
    // self-report and trips the heuristic satisfaction check.
    await agent.run({ agentId: 'crowclaw', sessionId: 's3', userMessage: 'the goal is complete' });
    expect(agent.getGoal('s3')).toBeNull();
    expect(events.some((e) => e.type === GOAL_EVENTS.satisfied)).toBe(true);
    const session = await store.get('s3');
    expect(session?.activeGoal ?? null).toBeNull();
  });
});

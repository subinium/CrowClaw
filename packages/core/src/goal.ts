// ---------------------------------------------------------------------------
// #301 (v0.9.1 "Sentinel") — /goal persistent cross-turn goals (Ralph loop)
//
// Hermes v0.13 (#18262, #18275, #21287) added `/goal`: the agent locks onto a
// target objective that survives across turns. Each iteration it re-injects the
// goal into the system slot (NOT the saved transcript), checks satisfaction,
// and exits when the goal is met or the turn budget runs out — the "Ralph
// loop" that keeps the agent on task even when the user goes quiet or chases a
// tangent.
//
// Distinct from `/steer` (single-shot guidance, drained once) and the static
// `agentPreset.goal` (a role descriptor): an active goal is a *stateful,
// per-session* objective with a turn budget, persisted in
// `SessionState.activeGoal`.
//
// Design choice: `GoalTracker` is a thin per-session map facade plus pure
// helpers. It owns NO AgentLoop state and does not persist on its own — the
// loop reads/writes `SessionState.activeGoal` so the existing atomic
// SessionStore.put carries the goal across restore. Multi-session isolation is
// inherent: every operation is keyed by sessionId.
//
// The /goal slash command and REST endpoints (POST/DELETE
// /api/sessions/:id/goal) are wired by the runtime — this module exposes the
// tracker + the loop hooks (`buildGoalReminder`, `tickGoal`,
// `evaluateGoalSatisfaction`) and the event names the loop emits.
// ---------------------------------------------------------------------------

/**
 * Persisted goal state. Lives in `SessionState.activeGoal`. The atomic
 * SessionStore put carries it across host restart so a goal set on turn 1
 * still drives turn 7.
 */
export interface ActiveGoal {
  /** The operator-supplied objective text, e.g. "ship the parser refactor". */
  text: string;
  /** Iterations remaining before the goal expires. Decremented each loop tick;
   *  hitting 0 emits `session:goal_expired` and falls back to natural
   *  termination. */
  turnsRemaining: number;
  /** The budget the goal was created with (immutable). Surfaced in the
   *  reminder so the model sees "turn 4 of 50". */
  maxTurns: number;
  /** ISO timestamp the goal was set. */
  setAt: string;
  /** ISO timestamp the goal was satisfied, when applicable. Present only on a
   *  cleared-by-satisfaction goal that a caller chose to retain for audit. */
  satisfiedAt?: string;
}

/** Default turn budget for a new goal (issue #301: `goal.maxTurns: 50`). */
export const DEFAULT_GOAL_MAX_TURNS = 50;

/** Event names the AgentLoop emits for goal lifecycle transitions. */
export const GOAL_EVENTS = {
  set: 'session:goal_set',
  satisfied: 'session:goal_satisfied',
  expired: 'session:goal_expired',
} as const;

export type GoalEventName = (typeof GOAL_EVENTS)[keyof typeof GOAL_EVENTS];

/**
 * Optional model-classification hook for goal satisfaction. When supplied, the
 * loop calls it AFTER the heuristic check returns false, giving an LLM (or any
 * classifier) the chance to decide the goal is met. Returning `true` clears the
 * goal and emits `session:goal_satisfied`. Errors thrown here are swallowed by
 * the loop (treated as "not satisfied") so a flaky classifier never crashes a
 * run.
 */
export type GoalSatisfactionClassifier = (args: {
  goal: ActiveGoal;
  /** The agent's latest assistant message this turn (may be empty). */
  assistantMessage: string;
  sessionId: string;
  agentId: string;
}) => Promise<boolean> | boolean;

export interface SetGoalOptions {
  /** Turn budget; defaults to `DEFAULT_GOAL_MAX_TURNS`. */
  maxTurns?: number;
  /** Override the set timestamp (testing / determinism). */
  now?: () => string;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Per-session active-goal facade. Backed by an in-memory map keyed by
 * sessionId so a single AgentLoop instance serving many sessions keeps each
 * session's goal isolated. The loop mirrors the active goal into
 * `SessionState.activeGoal` for persistence; `rehydrate` seeds the tracker from
 * a restored session so an in-flight goal survives a host restart.
 */
export class GoalTracker {
  private readonly goals = new Map<string, ActiveGoal>();

  /**
   * Set (or replace) the active goal for a session. Empty/whitespace-only text
   * is rejected (returns null) — same drop-silently contract as steer/queue.
   * A maxTurns <= 0 is clamped to 1 so a goal is never born already-expired.
   */
  set(sessionId: string, text: string, options: SetGoalOptions = {}): ActiveGoal | null {
    if (!text || !text.trim()) return null;
    const maxTurns = Math.max(1, Math.floor(options.maxTurns ?? DEFAULT_GOAL_MAX_TURNS));
    const now = options.now ?? nowIso;
    const goal: ActiveGoal = {
      text: text.trim(),
      turnsRemaining: maxTurns,
      maxTurns,
      setAt: now(),
    };
    this.goals.set(sessionId, goal);
    return goal;
  }

  /** Return the active goal for a session, or null when none is set. */
  get(sessionId: string): ActiveGoal | null {
    return this.goals.get(sessionId) ?? null;
  }

  /** True when the session has an active (non-expired) goal. */
  has(sessionId: string): boolean {
    const goal = this.goals.get(sessionId);
    return !!goal && goal.turnsRemaining > 0;
  }

  /**
   * Decrement the turn budget for a session's goal by one and return the
   * updated goal. Returns null when no goal is set. Does NOT clear on
   * exhaustion — the caller inspects `turnsRemaining <= 0` and emits
   * `session:goal_expired`, then calls `clear`. This split keeps the
   * decrement and the side-effecting event emission in the loop.
   */
  tick(sessionId: string): ActiveGoal | null {
    const goal = this.goals.get(sessionId);
    if (!goal) return null;
    const updated: ActiveGoal = { ...goal, turnsRemaining: goal.turnsRemaining - 1 };
    this.goals.set(sessionId, updated);
    return updated;
  }

  /**
   * Lightweight, model-free satisfaction heuristic. Returns true when the
   * agent's own assistant message self-reports completion against the goal.
   * Deliberately conservative — false positives would prematurely abandon the
   * Ralph loop. The optional model classifier (wired by the loop) covers the
   * cases this misses.
   */
  check(sessionId: string, assistantMessage: string): boolean {
    const goal = this.goals.get(sessionId);
    if (!goal) return false;
    return heuristicGoalSatisfied(goal, assistantMessage);
  }

  /** Clear the active goal for a session. Idempotent. Returns the cleared goal
   *  (for audit / event payloads) or null when nothing was set. */
  clear(sessionId: string): ActiveGoal | null {
    const goal = this.goals.get(sessionId) ?? null;
    this.goals.delete(sessionId);
    return goal;
  }

  /**
   * Seed the tracker from a restored session's `activeGoal`. Called by the loop
   * at the start of a run. Skips when the session has no goal or the slot is
   * already populated in-memory (a runtime `set()` that landed before the run
   * must not be clobbered by the stored snapshot).
   */
  rehydrate(sessionId: string, goal: ActiveGoal | null | undefined): void {
    if (!goal) return;
    if (this.goals.has(sessionId)) return;
    if (typeof goal.text !== 'string' || !goal.text.trim()) return;
    if (typeof goal.turnsRemaining !== 'number' || goal.turnsRemaining <= 0) return;
    this.goals.set(sessionId, {
      text: goal.text,
      turnsRemaining: goal.turnsRemaining,
      maxTurns: typeof goal.maxTurns === 'number' && goal.maxTurns > 0 ? goal.maxTurns : goal.turnsRemaining,
      setAt: typeof goal.setAt === 'string' ? goal.setAt : nowIso(),
      ...(goal.satisfiedAt ? { satisfiedAt: goal.satisfiedAt } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// Pure helpers — usable without a GoalTracker instance (and unit-testable).
// ---------------------------------------------------------------------------

const COMPLETION_PHRASES = [
  /\bgoal\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|achieved|accomplished|satisfied|done|met)\b/i,
  /\b(?:i\s+have|i've|we\s+have|we've)\s+(?:now\s+)?(?:completed|achieved|accomplished|finished)\b[^.\n]{0,40}\b(?:goal|objective|task)\b/i,
  /\bobjective\s+(?:is\s+)?(?:now\s+)?(?:complete|completed|achieved|met)\b/i,
  /\ball\s+(?:tests?\s+)?(?:are\s+)?(?:passing|green)\b.*\b(?:goal|done|complete)\b/i,
];

/**
 * Heuristic goal-satisfaction check. True when the assistant message contains a
 * clear self-report of completion. Conservative by design.
 */
export function heuristicGoalSatisfied(goal: ActiveGoal, assistantMessage: string): boolean {
  if (!assistantMessage) return false;
  // A bare "done" is too weak; require an explicit completion phrase.
  return COMPLETION_PHRASES.some((p) => p.test(assistantMessage));
}

/**
 * Build the ephemeral `[GOAL]` system reminder injected at the top of each
 * iteration. NOT persisted in the transcript — the loop appends it for the
 * current turn only (same one-shot pattern as `/steer`). Surfaces the
 * remaining turn budget so the model can pace itself.
 *
 * Returns null when no goal is active or the budget is already exhausted.
 */
export function buildGoalReminder(goal: ActiveGoal | null | undefined): string | null {
  if (!goal || goal.turnsRemaining <= 0) return null;
  const usedTurn = goal.maxTurns - goal.turnsRemaining + 1;
  return [
    `[GOAL] You are working toward a persistent objective that spans multiple turns.`,
    `Objective: ${goal.text}`,
    `Turn ${usedTurn} of ${goal.maxTurns} (${goal.turnsRemaining} remaining).`,
    `Stay focused on this objective. If the user goes off-topic, address them briefly`,
    `then return to the objective. When the objective is fully achieved, state clearly`,
    `that the goal is complete so the session can close it out.`,
  ].join('\n');
}

/**
 * Run the full satisfaction evaluation for a turn: heuristic first, then the
 * optional model classifier. Returns `true` when the goal should be considered
 * satisfied. Classifier exceptions are swallowed (treated as "not satisfied")
 * so a flaky classifier never crashes the run — the error is returned in
 * `classifierError` for the caller to log.
 */
export async function evaluateGoalSatisfaction(args: {
  goal: ActiveGoal;
  assistantMessage: string;
  sessionId: string;
  agentId: string;
  classifier?: GoalSatisfactionClassifier;
}): Promise<{ satisfied: boolean; via: 'heuristic' | 'classifier' | 'none'; classifierError?: unknown }> {
  if (heuristicGoalSatisfied(args.goal, args.assistantMessage)) {
    return { satisfied: true, via: 'heuristic' };
  }
  if (args.classifier) {
    try {
      const result = await args.classifier({
        goal: args.goal,
        assistantMessage: args.assistantMessage,
        sessionId: args.sessionId,
        agentId: args.agentId,
      });
      if (result) return { satisfied: true, via: 'classifier' };
    } catch (error: unknown) {
      return { satisfied: false, via: 'none', classifierError: error };
    }
  }
  return { satisfied: false, via: 'none' };
}

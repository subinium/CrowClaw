import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SessionState, ConversationMessage } from '@crowclaw/core';
import { SessionController } from '../packages/runtime-node/src/session-controller.js';
import { EventBus } from '../packages/runtime-node/src/event-bus.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const makeSession = (id: string, messageCount: number): SessionState => ({
  agentId: 'crowclaw',
  sessionId: id,
  messages: [
    { role: 'system', content: 'You are CrowClaw', createdAt: new Date().toISOString() },
    ...Array.from({ length: messageCount }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i + 1}: ${i % 2 === 0 ? 'User says something' : 'Assistant responds'}`,
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    })),
  ],
  updatedAt: new Date().toISOString(),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionController', () => {
  let ctrl: SessionController;
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    ctrl = new SessionController(bus);
  });

  // -- registerSession -----------------------------------------------------

  describe('registerSession', () => {
    it('creates an AbortController and tracks the session', () => {
      const ac = ctrl.registerSession('s1');
      expect(ac).toBeInstanceOf(AbortController);
      expect(ctrl.isActive('s1')).toBe(true);

      const sessions = ctrl.getActiveSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('s1');
      expect(sessions[0].status).toBe('running');
      expect(sessions[0].startedAt).toBeTruthy();
    });

    it('emits session:updated on registration', () => {
      const spy = vi.fn();
      bus.subscribe(spy);
      ctrl.registerSession('s1');
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].type).toBe('session:updated');
      expect(spy.mock.calls[0][0].data.action).toBe('registered');
    });
  });

  // -- unregisterSession ---------------------------------------------------

  describe('unregisterSession', () => {
    it('removes the session from tracking', () => {
      ctrl.registerSession('s1');
      expect(ctrl.isActive('s1')).toBe(true);
      ctrl.unregisterSession('s1');
      expect(ctrl.isActive('s1')).toBe(false);
      expect(ctrl.getActiveSessions()).toHaveLength(0);
    });

    it('emits session:updated on unregister', () => {
      ctrl.registerSession('s1');
      const spy = vi.fn();
      bus.subscribe(spy);
      ctrl.unregisterSession('s1');
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].data.action).toBe('unregistered');
    });
  });

  // -- getActiveSessions ---------------------------------------------------

  describe('getActiveSessions', () => {
    it('returns all tracked sessions', () => {
      ctrl.registerSession('s1');
      ctrl.registerSession('s2');
      ctrl.registerSession('s3');
      const sessions = ctrl.getActiveSessions();
      expect(sessions).toHaveLength(3);
      const ids = sessions.map((s) => s.sessionId);
      expect(ids).toContain('s1');
      expect(ids).toContain('s2');
      expect(ids).toContain('s3');
    });

    it('returns empty array when nothing is tracked', () => {
      expect(ctrl.getActiveSessions()).toHaveLength(0);
    });
  });

  // -- isActive ------------------------------------------------------------

  describe('isActive', () => {
    it('returns true for registered sessions', () => {
      ctrl.registerSession('s1');
      expect(ctrl.isActive('s1')).toBe(true);
    });

    it('returns false for unknown sessions', () => {
      expect(ctrl.isActive('nonexistent')).toBe(false);
    });

    it('returns false after unregister', () => {
      ctrl.registerSession('s1');
      ctrl.unregisterSession('s1');
      expect(ctrl.isActive('s1')).toBe(false);
    });
  });

  // -- abort ---------------------------------------------------------------

  describe('abort', () => {
    it('signals the AbortController and sets status to aborting', () => {
      const ac = ctrl.registerSession('s1');
      expect(ac.signal.aborted).toBe(false);

      const result = ctrl.abort('s1');
      expect(result.aborted).toBe(true);
      expect(ac.signal.aborted).toBe(true);

      const sessions = ctrl.getActiveSessions();
      expect(sessions[0].status).toBe('aborting');
    });

    it('emits session:updated with action aborted', () => {
      ctrl.registerSession('s1');
      const spy = vi.fn();
      bus.subscribe(spy);

      ctrl.abort('s1');
      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].data.action).toBe('aborted');
      expect(spy.mock.calls[0][0].data.sessionId).toBe('s1');
    });

    it('returns false for non-active sessions', () => {
      const result = ctrl.abort('nonexistent');
      expect(result.aborted).toBe(false);
      expect(result.reason).toBe('Session is not active');
    });

    it('returns false after unregister', () => {
      ctrl.registerSession('s1');
      ctrl.unregisterSession('s1');
      const result = ctrl.abort('s1');
      expect(result.aborted).toBe(false);
    });
  });

  // -- compact -------------------------------------------------------------

  describe('compact', () => {
    it('reduces message count while preserving system + recent messages', () => {
      const session = makeSession('c1', 20);
      // 1 system + 20 conversation = 21 total
      expect(session.messages).toHaveLength(21);

      const result = ctrl.compact(session);
      // system + summary + last 10 = 12
      expect(result.originalMessageCount).toBe(21);
      expect(result.compactedMessageCount).toBe(12);
      expect(session.messages).toHaveLength(12);

      // First message is still the original system prompt
      expect(session.messages[0].role).toBe('system');
      expect(session.messages[0].content).toBe('You are CrowClaw');

      // Second message is the compressed summary
      expect(session.messages[1].role).toBe('system');
      expect(session.messages[1].content).toContain('[Compressed conversation summary]');
      expect(session.messages[1].metadata?.compressed).toBe(true);
    });

    it('generates a meaningful summary from old messages', () => {
      const session = makeSession('c2', 20);
      const result = ctrl.compact(session);

      expect(result.summary).toBeTruthy();
      expect(result.summary).toContain('User');
      expect(result.summary).toContain('Assistant');
      // Should reference actual message content
      expect(result.summary).toContain('Message');
    });

    it('respects custom keepLastN', () => {
      const session = makeSession('c3', 20);
      const result = ctrl.compact(session, { keepLastN: 5 });
      // system + summary + last 5 = 7
      expect(result.compactedMessageCount).toBe(7);
      expect(session.messages).toHaveLength(7);
    });

    it('respects custom summaryMaxLength', () => {
      const session = makeSession('c4', 30);
      const result = ctrl.compact(session, { summaryMaxLength: 50 });
      // Summary should be truncated
      expect(result.summary.length).toBeLessThanOrEqual(53); // 50 + '...'
    });

    it('handles edge case: few messages (no compaction needed)', () => {
      const session = makeSession('c5', 5);
      // 1 system + 5 conversation = 6 total, keepLastN=10 -> nothing to compact
      const result = ctrl.compact(session);
      expect(result.originalMessageCount).toBe(6);
      expect(result.compactedMessageCount).toBe(6);
      expect(result.summary).toBe('');
      expect(session.messages).toHaveLength(6);
    });

    it('handles edge case: no messages', () => {
      const session: SessionState = {
        agentId: 'crowclaw',
        sessionId: 'c6',
        messages: [],
        updatedAt: new Date().toISOString(),
      };
      const result = ctrl.compact(session);
      expect(result.originalMessageCount).toBe(0);
      expect(result.compactedMessageCount).toBe(0);
      expect(result.summary).toBe('');
    });

    it('handles edge case: all system messages', () => {
      const session: SessionState = {
        agentId: 'crowclaw',
        sessionId: 'c7',
        messages: [
          { role: 'system', content: 'System 1', createdAt: new Date().toISOString() },
          { role: 'system', content: 'System 2', createdAt: new Date().toISOString() },
          { role: 'system', content: 'System 3', createdAt: new Date().toISOString() },
        ],
        updatedAt: new Date().toISOString(),
      };
      // 1 system prefix + 2 remaining conversation messages <= keepLastN(10), no compaction
      const result = ctrl.compact(session);
      expect(result.compactedMessageCount).toBe(3);
      expect(result.summary).toBe('');
    });

    it('emits session:updated with compacted action', () => {
      const spy = vi.fn();
      bus.subscribe(spy);

      const session = makeSession('c8', 20);
      ctrl.compact(session);

      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].type).toBe('session:updated');
      expect(spy.mock.calls[0][0].data.action).toBe('compacted');
      expect(spy.mock.calls[0][0].data.originalMessageCount).toBe(21);
    });

    it('preserves the last N messages in order', () => {
      const session = makeSession('c9', 20);
      const lastMessages = session.messages.slice(-10);

      ctrl.compact(session);

      // The last 10 messages in compacted session should match original last 10
      const compactedTail = session.messages.slice(-10);
      for (let i = 0; i < 10; i++) {
        expect(compactedTail[i].content).toBe(lastMessages[i].content);
        expect(compactedTail[i].role).toBe(lastMessages[i].role);
      }
    });
  });

  // -- steer ---------------------------------------------------------------

  describe('steer', () => {
    it('adds a system directive message to the session', () => {
      const session = makeSession('st1', 5);
      const originalLength = session.messages.length;

      const result = ctrl.steer(session, 'Focus on code review only');

      expect(session.messages).toHaveLength(originalLength + 1);
      const injected = session.messages[session.messages.length - 1];
      expect(injected.role).toBe('system');
      expect(injected.content).toContain('[Operator directive]');
      expect(injected.content).toContain('Focus on code review only');
      expect(injected.metadata?.steer).toBe(true);

      expect(result.sessionId).toBe('st1');
      expect(result.injectedPrompt).toBe(injected.content);
      expect(result.timestamp).toBeTruthy();
    });

    it('emits session:updated with steered action', () => {
      const spy = vi.fn();
      bus.subscribe(spy);

      const session = makeSession('st2', 2);
      ctrl.steer(session, 'Be concise');

      expect(spy).toHaveBeenCalledOnce();
      expect(spy.mock.calls[0][0].type).toBe('session:updated');
      expect(spy.mock.calls[0][0].data.action).toBe('steered');
      expect(spy.mock.calls[0][0].data.directive).toBe('Be concise');
    });
  });

  // -- Multiple sessions ---------------------------------------------------

  describe('multiple sessions', () => {
    it('can track and abort multiple sessions independently', () => {
      const ac1 = ctrl.registerSession('m1');
      const ac2 = ctrl.registerSession('m2');
      const ac3 = ctrl.registerSession('m3');

      expect(ctrl.getActiveSessions()).toHaveLength(3);

      ctrl.abort('m2');
      expect(ac1.signal.aborted).toBe(false);
      expect(ac2.signal.aborted).toBe(true);
      expect(ac3.signal.aborted).toBe(false);

      ctrl.unregisterSession('m1');
      expect(ctrl.getActiveSessions()).toHaveLength(2);
      expect(ctrl.isActive('m1')).toBe(false);
      expect(ctrl.isActive('m2')).toBe(true); // still tracked, just aborting
      expect(ctrl.isActive('m3')).toBe(true);
    });
  });

  // -- Without EventBus ----------------------------------------------------

  describe('without EventBus', () => {
    it('works without an EventBus (no errors thrown)', () => {
      const ctrlNoBus = new SessionController();
      const ac = ctrlNoBus.registerSession('nb1');
      expect(ac).toBeInstanceOf(AbortController);
      expect(ctrlNoBus.isActive('nb1')).toBe(true);
      ctrlNoBus.abort('nb1');
      ctrlNoBus.unregisterSession('nb1');

      const session = makeSession('nb2', 15);
      const compactResult = ctrlNoBus.compact(session);
      expect(compactResult.compactedMessageCount).toBeLessThan(compactResult.originalMessageCount);

      const steerResult = ctrlNoBus.steer(session, 'test directive');
      expect(steerResult.injectedPrompt).toContain('test directive');
    });
  });
});

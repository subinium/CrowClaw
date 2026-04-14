import { describe, it, expect } from 'vitest';
import { FeedbackLedger } from '../packages/runtime-node/src/index.js';
import type { FeedbackEntry } from '../packages/runtime-node/src/index.js';

function makeEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    timestamp: new Date().toISOString(),
    toolName: 'web.search',
    ok: true,
    sessionId: 'sess-1',
    ...overrides,
  };
}

describe('FeedbackLedger', () => {
  describe('record and getEntries', () => {
    it('records entries and retrieves them', () => {
      const ledger = new FeedbackLedger();
      const entry = makeEntry();
      ledger.record(entry);

      const entries = ledger.getEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it('returns entries in insertion order', () => {
      const ledger = new FeedbackLedger();
      ledger.record(makeEntry({ toolName: 'web.search' }));
      ledger.record(makeEntry({ toolName: 'file.read' }));
      ledger.record(makeEntry({ toolName: 'shell.exec' }));

      const entries = ledger.getEntries();
      expect(entries.map(e => e.toolName)).toEqual(['web.search', 'file.read', 'shell.exec']);
    });

    it('getEntries with limit returns the most recent entries', () => {
      const ledger = new FeedbackLedger();
      for (let i = 0; i < 10; i++) {
        ledger.record(makeEntry({ toolName: `tool-${i}` }));
      }

      const recent = ledger.getEntries(3);
      expect(recent).toHaveLength(3);
      expect(recent.map(e => e.toolName)).toEqual(['tool-7', 'tool-8', 'tool-9']);
    });
  });

  describe('getStats', () => {
    it('accurately counts success and failure totals', () => {
      const ledger = new FeedbackLedger();
      ledger.record(makeEntry({ ok: true }));
      ledger.record(makeEntry({ ok: true }));
      ledger.record(makeEntry({ ok: false }));

      const stats = ledger.getStats();
      expect(stats.total).toBe(3);
      expect(stats.success).toBe(2);
      expect(stats.failure).toBe(1);
    });

    it('groups stats by tool name', () => {
      const ledger = new FeedbackLedger();
      ledger.record(makeEntry({ toolName: 'web.search', ok: true }));
      ledger.record(makeEntry({ toolName: 'web.search', ok: false }));
      ledger.record(makeEntry({ toolName: 'file.read', ok: true }));
      ledger.record(makeEntry({ toolName: 'file.read', ok: true }));
      ledger.record(makeEntry({ toolName: 'file.read', ok: false }));

      const stats = ledger.getStats();
      expect(stats.byTool['web.search']).toEqual({ ok: 1, fail: 1 });
      expect(stats.byTool['file.read']).toEqual({ ok: 2, fail: 1 });
    });

    it('returns zeros for empty ledger', () => {
      const ledger = new FeedbackLedger();
      const stats = ledger.getStats();
      expect(stats.total).toBe(0);
      expect(stats.success).toBe(0);
      expect(stats.failure).toBe(0);
      expect(stats.byTool).toEqual({});
    });
  });

  describe('getDigest', () => {
    it('returns formatted summary with stats', () => {
      const ledger = new FeedbackLedger();
      ledger.record(makeEntry({ toolName: 'web.search', ok: true }));
      ledger.record(makeEntry({ toolName: 'web.search', ok: false }));
      ledger.record(makeEntry({ toolName: 'file.read', ok: true }));

      const digest = ledger.getDigest();
      expect(digest).toContain('## Tool Feedback');
      expect(digest).toContain('Total: 3');
      expect(digest).toContain('Success: 2');
      expect(digest).toContain('Failure: 1');
      expect(digest).toContain('**web.search**: 1 ok, 1 fail');
      expect(digest).toContain('**file.read**: 1 ok, 0 fail');
    });

    it('returns empty string for empty ledger', () => {
      const ledger = new FeedbackLedger();
      expect(ledger.getDigest()).toBe('');
    });
  });

  describe('max entries limit', () => {
    it('enforces the 200-entry limit by dropping oldest entries', () => {
      const ledger = new FeedbackLedger();
      for (let i = 0; i < 250; i++) {
        ledger.record(makeEntry({ toolName: `tool-${i}` }));
      }

      const entries = ledger.getEntries();
      expect(entries).toHaveLength(200);
      // Oldest entries (0-49) should be dropped; most recent 200 remain
      expect(entries[0].toolName).toBe('tool-50');
      expect(entries[199].toolName).toBe('tool-249');
    });

    it('keeps exactly maxEntries after exceeding the limit', () => {
      const ledger = new FeedbackLedger();
      for (let i = 0; i < 201; i++) {
        ledger.record(makeEntry({ toolName: `t-${i}` }));
      }

      const stats = ledger.getStats();
      expect(stats.total).toBe(200);
    });
  });
});

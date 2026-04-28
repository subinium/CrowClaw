/**
 * #178 — Command palette (Cmd+K) coverage.
 *
 * The palette has three independently-testable seams:
 *   1. fuzzy scoring + filter (pure)
 *   2. recent-search localStorage (pure, takes injectable storage)
 *   3. multi-source result aggregation (pure)
 *
 * Vitest's environment is `node` for this repo, so we avoid mounting the
 * Lit element here — the component is a thin shell over these three pure
 * modules, and the contracts they expose are what app.ts depends on.
 */

import { describe, expect, it } from 'vitest';

import {
  fuzzyScore,
  fuzzyFilter,
  loadRecent,
  saveRecent,
  RECENT_KEY,
  RECENT_LIMIT,
  aggregateResults,
  type RecentStorage,
} from '../packages/web/ui/src/lib/search.js';

// ---------------------------------------------------------------------------
// Fake localStorage helper (RecentStorage is structurally compatible)
// ---------------------------------------------------------------------------

const makeStorage = (initial: Record<string, string> = {}): RecentStorage & {
  store: Record<string, string>;
} => {
  const store = { ...initial };
  return {
    store,
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = v;
    },
  };
};

// ---------------------------------------------------------------------------
// 1. Fuzzy scoring
// ---------------------------------------------------------------------------

describe('fuzzyScore', () => {
  it('returns 1 for an empty query (everything matches)', () => {
    expect(fuzzyScore('', 'anything')).toBe(1);
  });

  it('returns 0 when not all query chars appear in order', () => {
    expect(fuzzyScore('xyz', 'session-abc')).toBe(0);
    // Same chars, wrong order — must reject.
    expect(fuzzyScore('cba', 'abc')).toBe(0);
  });

  it('returns 0 when the source text is empty', () => {
    expect(fuzzyScore('q', '')).toBe(0);
  });

  it('rewards exact prefix matches above scattered ones', () => {
    const prefix = fuzzyScore('chat', 'chat-with-claude');
    const scattered = fuzzyScore('chat', 'cherrypick-helpful-anon-tool');
    expect(prefix).toBeGreaterThan(scattered);
    // Prefix branch returns the largest possible score in the function.
    expect(prefix).toBeGreaterThan(100);
  });

  it('rewards consecutive matches over scattered ones at the same position', () => {
    const consecutive = fuzzyScore('abc', 'xyzabc');
    const scattered = fuzzyScore('abc', 'aXbXc');
    expect(consecutive).toBeGreaterThan(scattered);
  });

  it('rewards word-boundary hits', () => {
    const boundary = fuzzyScore('os', 'open settings');
    const midword = fuzzyScore('os', 'closet');
    expect(boundary).toBeGreaterThan(midword);
  });

  it('is case-insensitive', () => {
    expect(fuzzyScore('CHAT', 'chat-with-claude')).toBeGreaterThan(0);
    expect(fuzzyScore('chat', 'CHAT-WITH-CLAUDE')).toBeGreaterThan(0);
  });
});

describe('fuzzyFilter', () => {
  it('drops zero-score items and sorts by score descending', () => {
    const items = ['banana', 'cherry', 'apple', 'apricot'];
    const ranked = fuzzyFilter('ap', items, (s) => s);
    expect(ranked.map((r) => r.item)).toEqual(['apple', 'apricot']);
    expect(ranked[0].score).toBeGreaterThanOrEqual(ranked[1].score);
  });

  it('respects the limit parameter', () => {
    const items = Array.from({ length: 10 }, (_, i) => `item-${i}`);
    const ranked = fuzzyFilter('item', items, (s) => s, 3);
    expect(ranked).toHaveLength(3);
  });

  it('takes the highest-scoring field when getText returns multiple', () => {
    const items = [{ id: 'abc-123', label: 'Settings' }];
    const byLabel = fuzzyFilter('sett', items, (i) => [i.label, i.id]);
    expect(byLabel).toHaveLength(1);
    expect(byLabel[0].score).toBeGreaterThan(0);
    // Score should match the higher-scoring `label` field, not the `id`.
    expect(byLabel[0].score).toBe(fuzzyScore('sett', 'Settings'));
  });

  it('returns every item with score 1 when query is empty', () => {
    const items = ['a', 'b', 'c'];
    const ranked = fuzzyFilter('', items, (s) => s);
    expect(ranked).toHaveLength(3);
    expect(ranked.every((r) => r.score === 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Recent-search persistence
// ---------------------------------------------------------------------------

describe('loadRecent / saveRecent', () => {
  it('returns [] when storage is empty', () => {
    const storage = makeStorage();
    expect(loadRecent(storage)).toEqual([]);
  });

  it('returns [] when the stored value is malformed', () => {
    const storage = makeStorage({ [RECENT_KEY]: 'not-json' });
    expect(loadRecent(storage)).toEqual([]);
  });

  it('returns [] when the stored value is not an array', () => {
    const storage = makeStorage({ [RECENT_KEY]: '"a string"' });
    expect(loadRecent(storage)).toEqual([]);
  });

  it('persists each saved query and returns them newest-first', () => {
    const storage = makeStorage();
    saveRecent('first', storage);
    saveRecent('second', storage);
    saveRecent('third', storage);
    expect(loadRecent(storage)).toEqual(['third', 'second', 'first']);
  });

  it('moves duplicates to the front instead of duplicating', () => {
    const storage = makeStorage();
    saveRecent('alpha', storage);
    saveRecent('beta', storage);
    saveRecent('alpha', storage); // duplicate
    expect(loadRecent(storage)).toEqual(['alpha', 'beta']);
  });

  it('is case-insensitive when deduplicating but keeps newest casing', () => {
    const storage = makeStorage();
    saveRecent('Alpha', storage);
    saveRecent('ALPHA', storage);
    expect(loadRecent(storage)).toEqual(['ALPHA']);
  });

  it('caps the list at RECENT_LIMIT entries', () => {
    const storage = makeStorage();
    for (let i = 0; i < RECENT_LIMIT + 5; i++) {
      saveRecent(`q-${i}`, storage);
    }
    const recent = loadRecent(storage);
    expect(recent).toHaveLength(RECENT_LIMIT);
    // Newest first — the most recent query should be at index 0.
    expect(recent[0]).toBe(`q-${RECENT_LIMIT + 4}`);
  });

  it('ignores blank/whitespace-only queries', () => {
    const storage = makeStorage();
    saveRecent('   ', storage);
    saveRecent('', storage);
    expect(loadRecent(storage)).toEqual([]);
  });

  it('does not crash when setItem throws (quota exceeded)', () => {
    const storage: RecentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceeded');
      },
    };
    expect(() => saveRecent('q', storage)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. Result aggregation (the shape the palette renders)
// ---------------------------------------------------------------------------

describe('aggregateResults', () => {
  const sessions = [
    { sessionId: 'sess-1', title: 'Refactor auth flow', preview: 'rotate session cookie...' },
    { sessionId: 'sess-2', title: 'Memory snapshot bug', preview: 'frozen entries vanish...' },
    { sessionId: 'sess-3', title: '', preview: '' }, // anonymous
  ];
  const memories = [
    { key: 'user.name', value: 'Subin', category: 'profile' },
    { key: 'project.repo', value: 'CrowClaw', category: 'context' },
  ];
  const skills = [
    { slug: 'code-review', title: 'Code Review', summary: 'Review a PR end-to-end', triggerPhrases: ['review pr'] },
    { slug: 'release', title: 'Cut release', summary: 'Bump version, tag, publish', triggerPhrases: ['release'] },
  ];
  const actions = [
    { id: 'new-chat', label: 'New chat', hint: 'Start a fresh session' },
    { id: 'open-settings', label: 'Open settings', hint: 'Tokens, providers' },
  ];

  it('returns one bucket per source', () => {
    const r = aggregateResults({ query: '', sessions, memories, skills, actions });
    expect(Object.keys(r).sort()).toEqual(['actions', 'memories', 'sessions', 'skills']);
  });

  it('renders sessions with id + title + truncated preview', () => {
    const r = aggregateResults({ query: 'refactor', sessions, memories: [], skills: [], actions: [] });
    expect(r.sessions).toHaveLength(1);
    const row = r.sessions[0];
    expect(row.source).toBe('sessions');
    expect(row.id).toBe('sess-1');
    expect(row.title).toBe('Refactor auth flow');
    expect(row.subtitle).toContain('rotate session cookie');
    expect(row.payload).toEqual({ sessionId: 'sess-1' });
  });

  it('falls back to sessionId when title is empty', () => {
    const r = aggregateResults({ query: 'sess-3', sessions, memories: [], skills: [], actions: [] });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0].title).toBe('sess-3');
  });

  it('matches skills by trigger phrase, not just title', () => {
    const r = aggregateResults({ query: 'review pr', sessions: [], memories: [], skills, actions: [] });
    // Trigger phrase is "review pr" — should match.
    const slugs = r.skills.map((s) => s.id);
    expect(slugs).toContain('code-review');
  });

  it('matches memories on key, value, or category', () => {
    const r1 = aggregateResults({ query: 'subin', sessions: [], memories, skills: [], actions: [] });
    expect(r1.memories.map((m) => m.id)).toContain('user.name');

    const r2 = aggregateResults({ query: 'profile', sessions: [], memories, skills: [], actions: [] });
    expect(r2.memories.map((m) => m.id)).toContain('user.name');

    const r3 = aggregateResults({ query: 'crowclaw', sessions: [], memories, skills: [], actions: [] });
    expect(r3.memories.map((m) => m.id)).toContain('project.repo');
  });

  it('matches actions by label', () => {
    const r = aggregateResults({ query: 'settings', sessions: [], memories: [], skills: [], actions });
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0].id).toBe('open-settings');
    expect(r.actions[0].title).toBe('Open settings');
  });

  it('returns nothing in any bucket when nothing matches', () => {
    const r = aggregateResults({ query: 'qqqzzzxxx', sessions, memories, skills, actions });
    expect(r.sessions).toEqual([]);
    expect(r.memories).toEqual([]);
    expect(r.skills).toEqual([]);
    expect(r.actions).toEqual([]);
  });

  it('respects the perSource page-size cap (50 default per spec)', () => {
    const many = Array.from({ length: 120 }, (_, i) => ({
      sessionId: `s-${i}`,
      title: `match-${i}`,
      preview: '',
    }));
    const r = aggregateResults({
      query: 'match',
      sessions: many,
      memories: [],
      skills: [],
      actions: [],
    });
    expect(r.sessions).toHaveLength(50);
  });

  it('honours an explicit perSource override', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({
      sessionId: `s-${i}`,
      title: `match-${i}`,
      preview: '',
    }));
    const r = aggregateResults({
      query: 'match',
      sessions: many,
      memories: [],
      skills: [],
      actions: [],
      perSource: 5,
    });
    expect(r.sessions).toHaveLength(5);
  });

  it('preserves source list order when query is empty', () => {
    const r = aggregateResults({ query: '', sessions, memories: [], skills: [], actions: [] });
    expect(r.sessions.map((s) => s.id)).toEqual(['sess-1', 'sess-2', 'sess-3']);
  });
});

/**
 * Lightweight fuzzy matcher and recent-search persistence for the
 * command palette (#178). No external dependencies; pure functions
 * so the logic is testable in vitest's `node` environment without
 * spinning up a DOM.
 *
 * Scoring rules (small enough to inline-document):
 *   - Empty query  -> score 1 (everything matches, preserves source order)
 *   - All query chars must appear in `text` in order (case-insensitive)
 *   - Score rewards: prefix match, consecutive matches, word-boundary hits
 *   - Score penalises: gaps between matched chars, longer source string
 */

export interface FuzzyMatch<T> {
  item: T;
  score: number;
}

/**
 * Score a single text against a query. Returns 0 when not all characters
 * of `query` appear in `text` in order. Higher = better match.
 */
export const fuzzyScore = (query: string, text: string): number => {
  if (!query) return 1;
  if (!text) return 0;

  const q = query.toLowerCase();
  const t = text.toLowerCase();

  // Exact prefix is always best.
  if (t.startsWith(q)) {
    return 1000 - t.length;
  }

  let score = 0;
  let qi = 0;
  let lastMatchIdx = -1;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Word-boundary bonus (start of string or after space/-/_/./:)
      const prev = ti > 0 ? t[ti - 1] : '';
      const isBoundary = ti === 0 || prev === ' ' || prev === '-' || prev === '_' || prev === '.' || prev === ':';
      if (isBoundary) score += 8;

      // Consecutive-match bonus (clusters score higher than scattered hits).
      // Weight chosen so two consecutive chars beat two scattered chars even
      // when the scattered run starts at a word boundary (the +8 bonus).
      if (lastMatchIdx === ti - 1) {
        consecutive++;
        score += 6 + consecutive * 2;
      } else {
        consecutive = 0;
        // Penalise gap (capped) so far-flung matches lose to compact ones.
        if (lastMatchIdx >= 0) {
          score -= Math.min((ti - lastMatchIdx - 1) * 2, 12);
        }
      }

      score += 1;
      lastMatchIdx = ti;
      qi++;
    }
  }

  // Not all chars matched → no match.
  if (qi < q.length) return 0;

  // Slight bias toward shorter source strings on ties.
  return Math.max(1, score - Math.floor(t.length / 20));
};

/**
 * Filter + rank a list against a query. Items with score 0 are dropped.
 * `getText` may return multiple strings — the highest-scoring field wins
 * so a session matches on either title or sessionId without double-counting.
 */
export const fuzzyFilter = <T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => string | string[],
  limit = 50,
): FuzzyMatch<T>[] => {
  const out: FuzzyMatch<T>[] = [];
  for (const item of items) {
    const fields = getText(item);
    const texts = Array.isArray(fields) ? fields : [fields];
    let best = 0;
    for (const text of texts) {
      const s = fuzzyScore(query, text);
      if (s > best) best = s;
    }
    if (best > 0) {
      out.push({ item, score: best });
    }
  }
  // Stable-ish sort by score desc; ties preserve original (input) order
  // because Array.prototype.sort is stable in V8.
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
};

// ---------------------------------------------------------------------------
// Recent-search persistence
// ---------------------------------------------------------------------------

export const RECENT_KEY = 'crowclaw:cmdk:recent';
export const RECENT_LIMIT = 20;

/**
 * Storage interface — `localStorage` in the browser, an injected mock in tests.
 */
export interface RecentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const loadRecent = (storage?: RecentStorage | null): string[] => {
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!s) return [];
  try {
    const raw = s.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string').slice(0, RECENT_LIMIT);
  } catch {
    return [];
  }
};

export const saveRecent = (
  query: string,
  storage?: RecentStorage | null,
): string[] => {
  const trimmed = query.trim();
  if (!trimmed) return loadRecent(storage);
  const s = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  const current = loadRecent(s);
  // Move-to-front: dedupe case-insensitively but keep original casing.
  const lc = trimmed.toLowerCase();
  const next = [trimmed, ...current.filter((q) => q.toLowerCase() !== lc)].slice(0, RECENT_LIMIT);
  if (s) {
    try {
      s.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      // Storage full or disabled — non-fatal, palette still works.
    }
  }
  return next;
};

// ---------------------------------------------------------------------------
// Result aggregation (extracted from the Lit component for testability)
// ---------------------------------------------------------------------------

export type CommandSource = 'sessions' | 'memories' | 'skills' | 'actions';

export interface CommandResult {
  source: CommandSource;
  id: string;
  title: string;
  subtitle?: string;
  /** Optional payload passed to the action handler on Enter. */
  payload?: unknown;
}

export interface SessionLike {
  sessionId: string;
  title?: string;
  preview?: string;
}

export interface MemoryLike {
  key: string;
  value: string;
  category?: string;
}

export interface SkillLike {
  slug: string;
  title: string;
  summary?: string;
  triggerPhrases?: string[];
}

export interface ActionLike {
  id: string;
  label: string;
  hint?: string;
}

export interface AggregateInput {
  query: string;
  sessions: readonly SessionLike[];
  memories: readonly MemoryLike[];
  skills: readonly SkillLike[];
  actions: readonly ActionLike[];
  /** Per-source page size, default 50 (per spec). */
  perSource?: number;
}

/**
 * Run the query against every source and return one ranked result list per
 * source. Pure function — easy to unit-test the rendering shape without
 * mounting a Lit element.
 */
export const aggregateResults = (input: AggregateInput): Record<CommandSource, CommandResult[]> => {
  const limit = input.perSource ?? 50;
  const q = input.query;

  const sessionMatches = fuzzyFilter(
    q,
    input.sessions,
    (s) => [s.title ?? '', s.sessionId, s.preview ?? ''],
    limit,
  ).map<CommandResult>(({ item }) => ({
    source: 'sessions',
    id: item.sessionId,
    title: item.title || item.sessionId,
    subtitle: item.preview?.slice(0, 80),
    payload: { sessionId: item.sessionId },
  }));

  const memoryMatches = fuzzyFilter(
    q,
    input.memories,
    (m) => [m.key, m.value, m.category ?? ''],
    limit,
  ).map<CommandResult>(({ item }) => ({
    source: 'memories',
    id: item.key,
    title: item.key,
    subtitle: item.value.slice(0, 80),
    payload: { key: item.key },
  }));

  const skillMatches = fuzzyFilter(
    q,
    input.skills,
    (s) => [s.title, s.slug, ...(s.triggerPhrases ?? [])],
    limit,
  ).map<CommandResult>(({ item }) => ({
    source: 'skills',
    id: item.slug,
    title: item.title,
    subtitle: item.summary?.slice(0, 80),
    payload: { slug: item.slug },
  }));

  const actionMatches = fuzzyFilter(
    q,
    input.actions,
    (a) => [a.label, a.id],
    limit,
  ).map<CommandResult>(({ item }) => ({
    source: 'actions',
    id: item.id,
    title: item.label,
    subtitle: item.hint,
    payload: { id: item.id },
  }));

  return {
    sessions: sessionMatches,
    memories: memoryMatches,
    skills: skillMatches,
    actions: actionMatches,
  };
};

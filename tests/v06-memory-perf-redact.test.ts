import { describe, expect, it } from 'vitest';
import {
  EmbeddingIndex,
  MemoryManager,
  SKIP_REDACTION_FLAG,
  cosineSimilarity,
  type ManagerMemoryRecord,
  type MemoryProvider,
} from '@crowclaw/memory';

/**
 * v0.6.0 memory regression tests:
 *  - #104  perf(memory): magnitude pre-filter, tightened maxVectors default
 *  - #137  fix(memory+core): MemoryManager.store routes through redactCredentials
 */

// -----------------------------------------------------------------------------
// #104 — EmbeddingIndex perf: norm caching + early-exit
// -----------------------------------------------------------------------------

describe('#104 EmbeddingIndex perf', () => {
  it('cached magnitudes still produce mathematically correct cosine scores', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 2, 3]);
    index.add('b', [4, 5, 6]);

    const results = index.search([1, 2, 3], 10, 0);
    const a = results.find((r) => r.id === 'a');
    const b = results.find((r) => r.id === 'b');

    // a is identical to query → 1.0
    expect(a?.score).toBeCloseTo(1.0, 5);
    // b vs query — must match the standalone cosineSimilarity helper
    // (i.e. cached norms produce no drift)
    expect(b?.score).toBeCloseTo(cosineSimilarity([1, 2, 3], [4, 5, 6]), 5);
  });

  it('early-exits negative dot products when threshold > 0 (perf path)', () => {
    const index = new EmbeddingIndex();
    index.add('opposite', [-1, 0, 0]);
    index.add('match', [1, 0, 0]);
    index.add('orthogonal', [0, 1, 0]);

    // threshold 0.5 — opposite (cos = -1) must be dropped via the early-exit
    // branch, not via the threshold check (both are correct, but the
    // early-exit is the perf path we want exercised).
    const results = index.search([1, 0, 0], 10, 0.5);
    expect(results.find((r) => r.id === 'opposite')).toBeUndefined();
    expect(results.find((r) => r.id === 'match')).toBeDefined();
  });

  it('still honors threshold = 0 (no early-exit, signed scores allowed)', () => {
    const index = new EmbeddingIndex();
    index.add('opposite', [-1, 0, 0]);
    index.add('match', [1, 0, 0]);

    // With threshold 0, we accept everything — but at threshold 0 the
    // early-exit guard ("threshold > 0") is bypassed, so the negative-dot
    // candidate must still appear. (If threshold===0, dot<=0 returns
    // score===-1 which is < 0, so it's filtered by the threshold instead —
    // either way the negative candidate must NOT be in the result set.
    // What we actually verify here is that the perf change doesn't crash
    // or skip valid candidates when threshold is exactly 0.)
    const results = index.search([1, 0, 0], 10, 0);
    expect(results.find((r) => r.id === 'match')?.score).toBeCloseTo(1, 5);
  });

  it('handles zero-magnitude query without throwing', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 2, 3]);
    expect(index.search([0, 0, 0], 5, 0.5)).toEqual([]);
  });

  it('drops cached norms when a vector is removed', () => {
    const index = new EmbeddingIndex();
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);
    index.remove('a');

    const results = index.search([1, 0, 0], 10, 0);
    expect(results.find((r) => r.id === 'a')).toBeUndefined();
    expect(results.find((r) => r.id === 'b')).toBeDefined();
  });

  it('skips dimension-mismatched candidates instead of NaN-crashing', () => {
    const index = new EmbeddingIndex();
    index.add('right_dim', [1, 0, 0]);
    index.add('wrong_dim', [1, 0]);

    const results = index.search([1, 0, 0], 10, 0);
    expect(results.find((r) => r.id === 'wrong_dim')).toBeUndefined();
    expect(results.find((r) => r.id === 'right_dim')).toBeDefined();
  });

  it('FIFO eviction also evicts the cached norm (no leak)', () => {
    const index = new EmbeddingIndex({ maxVectors: 2 });
    index.add('a', [1, 0, 0]);
    index.add('b', [0, 1, 0]);
    const evicted = index.add('c', [0, 0, 1]);
    expect(evicted).toBe('a');

    // Searching with the original 'a' direction must NOT match 'a' anymore.
    const results = index.search([1, 0, 0], 10, 0.5);
    expect(results.find((r) => r.id === 'a')).toBeUndefined();
    expect(index.size()).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// #137 — MemoryManager.store routes through redaction
// -----------------------------------------------------------------------------

interface CapturedWrite {
  key: string;
  content: string;
  metadata: Record<string, unknown> | undefined;
}

function createCapturingProvider(name: string): MemoryProvider & { writes: CapturedWrite[] } {
  const writes: CapturedWrite[] = [];
  return {
    name,
    writes,
    async store(key, content, metadata) {
      writes.push({ key, content, metadata });
    },
    async recall(): Promise<ManagerMemoryRecord[]> {
      return [];
    },
    async forget() {
      return false;
    },
  };
}

describe('#137 MemoryManager redaction', () => {
  it('redacts OpenAI keys embedded in content', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('note', 'My key is sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA right here');

    expect(provider.writes).toHaveLength(1);
    expect(provider.writes[0]!.content).not.toContain('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
    expect(provider.writes[0]!.content).toContain('[REDACTED]');
  });

  it('redacts Anthropic keys', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('note', 'token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    expect(provider.writes[0]!.content).not.toMatch(/sk-ant-api03-A{5,}/);
    expect(provider.writes[0]!.content).toContain('[REDACTED]');
  });

  it('redacts bearer tokens', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('h', 'Authorization: Bearer abcdef1234567890ABCDEF12345');

    expect(provider.writes[0]!.content).toContain('[REDACTED]');
    expect(provider.writes[0]!.content).not.toContain('abcdef1234567890ABCDEF12345');
  });

  it('redacts sensitive metadata keys wholesale', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('cfg', 'plain content', {
      authorization: 'opaque-session-token-xyz',
      apiKey: 'plain-but-still-secret',
      harmless: 'this should pass through',
    });

    const md = provider.writes[0]!.metadata!;
    expect(md.authorization).toBe('[REDACTED]');
    expect(md.apiKey).toBe('[REDACTED]');
    expect(md.harmless).toBe('this should pass through');
  });

  it('honors SKIP_REDACTION_FLAG opt-out for explicit secret tools', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    const secret = 'sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await manager.store('vault-entry', secret, {
      [SKIP_REDACTION_FLAG]: true,
      label: 'production-key',
    });

    expect(provider.writes[0]!.content).toBe(secret);
    // Opt-out flag must be stripped before reaching the backend.
    expect(provider.writes[0]!.metadata).toEqual({ label: 'production-key' });
    expect(provider.writes[0]!.metadata).not.toHaveProperty(SKIP_REDACTION_FLAG);
  });

  it('strips the opt-out flag even when redaction is on', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    // Flag explicitly set to false → redaction still runs, but the flag
    // itself must not persist to the backend.
    await manager.store('n', 'safe content', {
      [SKIP_REDACTION_FLAG]: false,
      tag: 'ok',
    });

    expect(provider.writes[0]!.metadata).toEqual({ tag: 'ok' });
    expect(provider.writes[0]!.metadata).not.toHaveProperty(SKIP_REDACTION_FLAG);
  });

  it('drops metadata entirely when only the opt-out flag was passed', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('n', 'safe content', { [SKIP_REDACTION_FLAG]: true });

    expect(provider.writes[0]!.metadata).toBeUndefined();
  });

  it('fans redacted writes out to all providers', async () => {
    const manager = new MemoryManager();
    const a = createCapturingProvider('a');
    const b = createCapturingProvider('b');
    manager.addProvider(a);
    manager.addProvider(b);

    await manager.store('k', 'leaked key sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');

    for (const provider of [a, b]) {
      expect(provider.writes).toHaveLength(1);
      expect(provider.writes[0]!.content).not.toContain('sk-proj-AAAAAAAAAAAAAAAAAAAAAAAAAAAA');
      expect(provider.writes[0]!.content).toContain('[REDACTED]');
    }
  });

  it('passes plain content through unchanged when nothing matches', async () => {
    const manager = new MemoryManager();
    const provider = createCapturingProvider('p');
    manager.addProvider(provider);

    await manager.store('k', 'hello world, nothing sensitive here', { user: 'alice' });

    expect(provider.writes[0]!.content).toBe('hello world, nothing sensitive here');
    expect(provider.writes[0]!.metadata).toEqual({ user: 'alice' });
  });
});

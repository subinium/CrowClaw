import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialPool, OpenAICompatibleProvider } from '@crowclaw/providers';
import type { ProviderRequest } from '@crowclaw/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const baseRequest: ProviderRequest = {
  systemPrompt: 'You are CrowClaw',
  messages: [{ role: 'user', content: 'hello', createdAt: new Date().toISOString() }],
  availableTools: [],
};

function makePool(
  keys: string[],
  opts?: { strategy?: 'round-robin' | 'random'; cooldownMs?: number; maxFailures?: number }
) {
  return new CredentialPool({
    keys,
    strategy: opts?.strategy ?? 'round-robin',
    cooldownMs: opts?.cooldownMs ?? 60_000,
    maxFailures: opts?.maxFailures ?? 3,
  });
}

// ---------------------------------------------------------------------------
// CredentialPool unit tests
// ---------------------------------------------------------------------------

describe('CredentialPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws when constructed with zero keys', () => {
    expect(() => new CredentialPool({ keys: [] })).toThrow('at least one key');
  });

  describe('round-robin', () => {
    it('cycles through 3 keys in order', () => {
      const pool = makePool(['key-A', 'key-B', 'key-C']);
      expect(pool.getKey()).toBe('key-A');
      expect(pool.getKey()).toBe('key-B');
      expect(pool.getKey()).toBe('key-C');
      expect(pool.getKey()).toBe('key-A');
    });

    it('skips cooled-down keys and continues cycling', () => {
      const pool = makePool(['key-A', 'key-B', 'key-C']);
      pool.getKey(); // key-A
      pool.reportFailure('key-B', 429);
      // key-B is cooling down, should skip to key-C
      expect(pool.getKey()).toBe('key-C');
      expect(pool.getKey()).toBe('key-A');
      expect(pool.getKey()).toBe('key-C');
    });
  });

  describe('failure + cooldown', () => {
    it('puts key on cooldown after 429', () => {
      const pool = makePool(['key-A', 'key-B'], { cooldownMs: 5000 });
      pool.reportFailure('key-A', 429);

      // key-A should be on cooldown, only key-B available
      expect(pool.getKey()).toBe('key-B');
      expect(pool.getKey()).toBe('key-B');
    });

    it('puts key on cooldown after 503', () => {
      const pool = makePool(['key-A', 'key-B'], { cooldownMs: 5000 });
      pool.reportFailure('key-A', 503);

      expect(pool.getKey()).toBe('key-B');
    });

    it('key becomes available again after cooldown expires', () => {
      const pool = makePool(['key-A', 'key-B'], { cooldownMs: 5000 });
      pool.reportFailure('key-A', 429);

      // Still cooling down
      expect(pool.getKey()).toBe('key-B');

      // Advance past cooldown
      vi.advanceTimersByTime(5001);

      // key-A should be available again — round-robin starts from where it left off
      // After getting key-B above, index advanced. Next cycle hits key-A if available.
      const nextKeys = [pool.getKey(), pool.getKey()];
      expect(nextKeys).toContain('key-A');
    });
  });

  describe('permanent disable', () => {
    it('disables key after maxFailures consecutive failures', () => {
      const pool = makePool(['key-A', 'key-B'], { maxFailures: 3, cooldownMs: 100 });

      pool.reportFailure('key-A', 500);
      pool.reportFailure('key-A', 500);
      // Not disabled yet (2 < 3)
      expect(pool.activeCount()).toBe(2);

      pool.reportFailure('key-A', 500);
      // Now disabled (3 >= 3)
      expect(pool.activeCount()).toBe(1);

      // Even after time passes, key-A stays disabled
      vi.advanceTimersByTime(1_000_000);
      expect(pool.getKey()).toBe('key-B');
      expect(pool.getKey()).toBe('key-B');
    });
  });

  describe('auth error', () => {
    it('immediately disables key on 401', () => {
      const pool = makePool(['key-A', 'key-B']);
      pool.reportFailure('key-A', 401);

      expect(pool.activeCount()).toBe(1);
      expect(pool.getKey()).toBe('key-B');
    });

    it('immediately disables key on 403', () => {
      const pool = makePool(['key-A', 'key-B']);
      pool.reportFailure('key-A', 403);

      expect(pool.activeCount()).toBe(1);
      expect(pool.getKey()).toBe('key-B');
    });
  });

  describe('all keys exhausted', () => {
    it('throws descriptive error when no keys available', () => {
      const pool = makePool(['key-A'], { maxFailures: 1 });
      pool.reportFailure('key-A', 500);

      expect(() => pool.getKey()).toThrow('All credential pool keys exhausted');
      expect(() => pool.getKey()).toThrow('1 total');
      expect(() => pool.getKey()).toThrow('1 disabled');
    });

    it('throws when all keys are cooling down', () => {
      const pool = makePool(['key-A', 'key-B'], { cooldownMs: 60_000 });
      pool.reportFailure('key-A', 429);
      pool.reportFailure('key-B', 429);

      expect(() => pool.getKey()).toThrow('All credential pool keys exhausted');
      expect(() => pool.getKey()).toThrow('2 cooling down');
    });
  });

  describe('success resets failure count', () => {
    it('resets consecutive failure counter on success', () => {
      const pool = makePool(['key-A', 'key-B'], { maxFailures: 3 });

      pool.reportFailure('key-A', 500);
      pool.reportFailure('key-A', 500);
      // 2 failures, one more would disable
      expect(pool.activeCount()).toBe(2);

      pool.reportSuccess('key-A');

      // Failure count reset — need 3 more to disable
      pool.reportFailure('key-A', 500);
      pool.reportFailure('key-A', 500);
      expect(pool.activeCount()).toBe(2); // Still active

      pool.reportFailure('key-A', 500);
      expect(pool.activeCount()).toBe(1); // Now disabled
    });

    it('clears cooldown on success', () => {
      const pool = makePool(['key-A', 'key-B'], { cooldownMs: 60_000 });
      pool.reportFailure('key-A', 429);

      // key-A on cooldown
      expect(pool.getKey()).toBe('key-B');

      // Simulate success (e.g., manual reset)
      pool.reportSuccess('key-A');

      // key-A should be available again
      const keys = [pool.getKey(), pool.getKey()];
      expect(keys).toContain('key-A');
    });
  });

  describe('getStatus', () => {
    it('returns accurate state with masked keys', () => {
      const pool = makePool(['sk-1234567890abcdef', 'sk-fedcba0987654321']);
      pool.reportFailure('sk-1234567890abcdef', 429);

      const status = pool.getStatus();
      expect(status).toHaveLength(2);

      // Keys are masked — only last 4 chars visible
      expect(status[0]!.key).toBe('****cdef');
      expect(status[1]!.key).toBe('****4321');

      // First key has 1 failure and cooldown
      expect(status[0]!.failures).toBe(1);
      expect(status[0]!.active).toBe(true);
      expect(status[0]!.cooldownUntil).toBeDefined();

      // Second key is clean
      expect(status[1]!.failures).toBe(0);
      expect(status[1]!.active).toBe(true);
      expect(status[1]!.cooldownUntil).toBeUndefined();
    });

    it('masks very short keys', () => {
      const pool = makePool(['abc']);
      const status = pool.getStatus();
      expect(status[0]!.key).toBe('****');
    });

    it('shows disabled state', () => {
      const pool = makePool(['key-A'], { maxFailures: 1 });
      pool.reportFailure('key-A', 500);

      const status = pool.getStatus();
      expect(status[0]!.active).toBe(false);
    });
  });

  describe('activeCount', () => {
    it('returns number of non-disabled keys', () => {
      const pool = makePool(['key-A', 'key-B', 'key-C']);
      expect(pool.activeCount()).toBe(3);

      pool.reportFailure('key-A', 401);
      expect(pool.activeCount()).toBe(2);

      pool.reportFailure('key-B', 403);
      expect(pool.activeCount()).toBe(1);
    });
  });

  describe('cooldownKey', () => {
    it('proactively cools down a key', () => {
      const pool = makePool(['key-A', 'key-B']);
      pool.cooldownKey('key-A', 10_000);

      expect(pool.getKey()).toBe('key-B');

      vi.advanceTimersByTime(10_001);
      const keys = [pool.getKey(), pool.getKey()];
      expect(keys).toContain('key-A');
    });
  });
});

// ---------------------------------------------------------------------------
// Provider integration tests
// ---------------------------------------------------------------------------

describe('OpenAICompatibleProvider with CredentialPool', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses pool key instead of config apiKey', async () => {
    const pool = makePool(['pool-key-1', 'pool-key-2']);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'config-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      credentialPool: pool,
    });

    let capturedAuthHeader = '';
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello!' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }));

    await provider.generate(baseRequest);
    expect(capturedAuthHeader).toBe('Bearer pool-key-1');

    await provider.generate(baseRequest);
    expect(capturedAuthHeader).toBe('Bearer pool-key-2');
  });

  it('reports failure and falls over to next key on 429', async () => {
    const pool = makePool(['key-rate-limited', 'key-good']);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'unused',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      credentialPool: pool,
    });

    let callCount = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return new Response('Rate limited', { status: 429 });
      }
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }));

    // First call gets key-rate-limited and fails
    await expect(provider.generate(baseRequest)).rejects.toThrow('429');

    // Pool should have reported failure, key-rate-limited is on cooldown
    // Second call should use key-good
    const result = await provider.generate(baseRequest);
    expect(result.assistantMessage).toBe('OK');
  });

  it('proactively cools down key when x-ratelimit-remaining is 0', async () => {
    const pool = makePool(['key-A', 'key-B']);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'unused',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      credentialPool: pool,
    });

    const resetTime = new Date(Date.now() + 30_000).toUTCString();
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': resetTime,
          },
        }
      );
    }));

    // First call uses key-A, succeeds but triggers proactive cooldown
    await provider.generate(baseRequest);

    // key-A is now on proactive cooldown, next call should use key-B
    const status = pool.getStatus();
    const keyAStatus = status[0]!;
    expect(keyAStatus.cooldownUntil).toBeDefined();
  });

  it('handles retry-after header', async () => {
    const pool = makePool(['key-A', 'key-B']);
    const provider = new OpenAICompatibleProvider({
      apiKey: 'unused',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      credentialPool: pool,
    });

    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'OK' } }],
        }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'retry-after': '30',
          },
        }
      );
    }));

    await provider.generate(baseRequest);

    // key-A should be cooled down for ~30 seconds
    const status = pool.getStatus();
    expect(status[0]!.cooldownUntil).toBeDefined();
  });

  it('works normally without pool (backward compatible)', async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: 'direct-key',
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
    });

    let capturedAuthHeader = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedAuthHeader = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'Hello!' } }],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }));

    await provider.generate(baseRequest);
    expect(capturedAuthHeader).toBe('Bearer direct-key');
  });
});

import { describe, expect, it } from 'vitest';
import {
  AnthropicProvider,
  SmartModelRouter,
  CredentialPool,
  classifyQueryComplexity,
  resolveContextWindow,
  getModelMetadata,
  listKnownModelMetadata,
  EchoProvider
} from '@crowclaw/providers';

describe('smart model routing', () => {
  it('classifies short simple messages as simple', () => {
    expect(classifyQueryComplexity('hello')).toBe('simple');
    expect(classifyQueryComplexity('what time is it?')).toBe('simple');
    expect(classifyQueryComplexity('thanks!')).toBe('simple');
  });

  it('classifies complex messages as complex', () => {
    expect(classifyQueryComplexity('please debug this function and refactor the module')).toBe('complex');
    expect(classifyQueryComplexity('```\nconst x = 1;\n```')).toBe('complex');
    expect(classifyQueryComplexity('check https://example.com')).toBe('complex');
    expect(classifyQueryComplexity('a '.repeat(100))).toBe('complex');
  });

  it('routes simple requests to cheap provider', () => {
    const primary = new EchoProvider();
    const cheap = new EchoProvider();
    const router = new SmartModelRouter(primary, cheap);

    const result = router.routeRequest({
      messages: [{ role: 'user', content: 'hi', createdAt: '' }],
      availableTools: []
    });
    expect(result).toBe(cheap);
  });

  it('routes complex requests to primary provider', () => {
    const primary = new EchoProvider();
    const cheap = new EchoProvider();
    const router = new SmartModelRouter(primary, cheap);

    const result = router.routeRequest({
      messages: [{ role: 'user', content: 'implement a new authentication system with OAuth2', createdAt: '' }],
      availableTools: []
    });
    expect(result).toBe(primary);
  });

  it('routes to primary when tools are available', () => {
    const primary = new EchoProvider();
    const cheap = new EchoProvider();
    const router = new SmartModelRouter(primary, cheap);

    const result = router.routeRequest({
      messages: [{ role: 'user', content: 'hi', createdAt: '' }],
      availableTools: [{ name: 'echo', description: '', runtime: 'worker', streaming: false, stateful: false, requiresWorkspace: false, requiresNetwork: false, dangerLevel: 'low' }]
    });
    expect(result).toBe(primary);
  });
});

describe('credential pool', () => {
  it('acquires and releases credentials with round-robin strategy', () => {
    const pool = new CredentialPool({ keys: ['key-a', 'key-b'], strategy: 'round-robin' });

    const first = pool.getKey();
    expect(first).toBe('key-a');

    const second = pool.getKey();
    expect(second).toBe('key-b');

    const third = pool.getKey();
    expect(third).toBe('key-a');
  });

  it('applies cooldown on rate limit errors', () => {
    const pool = new CredentialPool({ keys: ['key-a', 'key-b'] });

    pool.reportFailure('key-a', 429);
    // key-a is on cooldown, only key-b available
    expect(pool.getKey()).toBe('key-b');
    expect(pool.getKey()).toBe('key-b');
  });

  it('clears error state on success', () => {
    const pool = new CredentialPool({ keys: ['key-a'] });

    pool.reportFailure('key-a', 429);
    expect(() => pool.getKey()).toThrow('exhausted');

    pool.reportSuccess('key-a');
    expect(pool.getKey()).toBe('key-a');
  });
});

describe('resolveContextWindow', () => {
  it('returns known context window for cataloged models', () => {
    expect(resolveContextWindow('gpt-4o')).toBe(128_000);
    expect(resolveContextWindow('claude-opus-4')).toBe(200_000);
  });

  it('returns default 128K for unknown models', () => {
    expect(resolveContextWindow('totally-unknown-model')).toBe(128_000);
  });
});

describe('expanded model metadata', () => {
  it('has at least 40 model entries', () => {
    expect(listKnownModelMetadata().length).toBeGreaterThanOrEqual(40);
  });

  it('includes models from multiple families', () => {
    const models = listKnownModelMetadata();
    const families = new Set(models.map(m => m.family));
    expect(families.has('openai-compatible')).toBe(true);
    expect(families.has('anthropic')).toBe(true);
  });
});

/**
 * v0.6.0 providers + gateway sweep regression tests:
 *   #87  vision routing (model descriptor + dispatch helper)
 *   #91  GatewayCredentialPool with 401-rotation + least_used picker
 *   #92  ordered fallback_providers chain on primary error
 *   #97  api_max_retries via GatewayConfig
 *   #98  per-provider per-model request_timeout_seconds
 *   #102 typing-indicator try/finally across send path
 *   #72  per-provider API key schema validation
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicProvider,
  EchoProvider,
  OpenAICompatibleProvider,
  modelSupportsVision,
  requestContainsImage,
  resolveRequestTimeoutMs,
  validateAnthropicKey,
  validateGeminiKey,
  validateNvidiaKey,
  validateOpenAIKey,
  validateProviderKey,
  validateXaiKey,
  getModelMetadata,
} from '@crowclaw/providers';
import {
  GatewayCredentialPool,
  ProviderKeyPool,
  executeWithProviderFallback,
  resolveGatewayMaxAttempts,
  resolveGatewayRequestTimeoutMs,
} from '@crowclaw/gateway';
import type { ConversationMessage } from '@crowclaw/core';

// -----------------------------------------------------------------------------
// #87 — vision routing
// -----------------------------------------------------------------------------

describe('#87 vision routing', () => {
  it('flags known vision-capable models', () => {
    expect(modelSupportsVision('gpt-4o')).toBe(true);
    expect(modelSupportsVision('gpt-4o-mini')).toBe(true);
    expect(modelSupportsVision('gpt-4.1')).toBe(true);
    expect(modelSupportsVision('claude-sonnet-4-5')).toBe(true);
    expect(modelSupportsVision('claude-opus-4')).toBe(true);
    expect(modelSupportsVision('claude-haiku-3-5')).toBe(true);
    expect(modelSupportsVision('gemini-2.5-pro')).toBe(true);
    expect(modelSupportsVision('llama-4-maverick')).toBe(true);
  });

  it('flags non-vision models as unsupported', () => {
    // o-series reasoning models are text-only.
    expect(modelSupportsVision('o1')).toBe(false);
    expect(modelSupportsVision('o3')).toBe(false);
    expect(modelSupportsVision('o4-mini')).toBe(false);
    // Older Claude 3 sonnet/haiku without 3.5 suffix.
    expect(modelSupportsVision('claude-3-haiku')).toBe(false);
    // Unknown models default to false.
    expect(modelSupportsVision('unknown-model-xyz')).toBe(false);
    // Mistral, Llama 3, DeepSeek text models.
    expect(modelSupportsVision('mistral-large')).toBe(false);
    expect(modelSupportsVision('llama-3.1-70b')).toBe(false);
  });

  it('enriches ModelMetadata with vision flag for known models', () => {
    const meta = getModelMetadata('gpt-4o');
    expect(meta?.vision).toBe(true);
    const o3 = getModelMetadata('o3');
    expect(o3).not.toBeNull();
    expect(o3?.vision).toBeUndefined();
  });

  it('detects image attachments in metadata', () => {
    const messages: ConversationMessage[] = [
      {
        role: 'user',
        content: 'Look at this',
        createdAt: new Date().toISOString(),
        metadata: { attachments: [{ type: 'image', url: 'https://example.com/x.png' }] },
      },
    ];
    expect(requestContainsImage(messages)).toBe(true);
  });

  it('detects image content blocks embedded as JSON', () => {
    const messages: ConversationMessage[] = [
      {
        role: 'user',
        content: JSON.stringify([
          { type: 'text', text: 'see this' },
          { type: 'image', source: { url: 'https://example.com/x.png' } },
        ]),
        createdAt: new Date().toISOString(),
      },
    ];
    expect(requestContainsImage(messages)).toBe(true);
  });

  it('returns false for plain-text-only conversations', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: 'hello world', createdAt: new Date().toISOString() },
      { role: 'assistant', content: 'hi', createdAt: new Date().toISOString() },
    ];
    expect(requestContainsImage(messages)).toBe(false);
  });

  it('does not crash on malformed JSON content', () => {
    const messages: ConversationMessage[] = [
      { role: 'user', content: '[not valid json', createdAt: new Date().toISOString() },
    ];
    expect(requestContainsImage(messages)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// #91 — credential pool with 401-rotation + least_used picker
// -----------------------------------------------------------------------------

describe('#91 GatewayCredentialPool', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects empty key set at construction', () => {
    expect(() => new ProviderKeyPool({ keys: [] })).toThrow('at least one key');
  });

  it('least_used picks the smallest usage count', () => {
    const pool = new ProviderKeyPool({ keys: ['k1', 'k2', 'k3'], cursor: 'least_used' });
    // First call: all 0, picks first.
    const first = pool.pick();
    expect(['k1', 'k2', 'k3']).toContain(first);
    // Second call: must pick a different (still-zero-usage) key.
    const second = pool.pick();
    expect(second).not.toBe(first);
    // Third call: only one zero-usage key remains.
    const third = pool.pick();
    expect(third).not.toBe(first);
    expect(third).not.toBe(second);
    // Fourth call: all keys at usageCount=1, ties broken deterministically.
    const fourth = pool.pick();
    expect(['k1', 'k2', 'k3']).toContain(fourth);
  });

  it('round_robin cycles through keys in order', () => {
    const pool = new ProviderKeyPool({ keys: ['kA', 'kB', 'kC'], cursor: 'round_robin' });
    expect(pool.pick()).toBe('kA');
    expect(pool.pick()).toBe('kB');
    expect(pool.pick()).toBe('kC');
    expect(pool.pick()).toBe('kA');
  });

  it('rotates to next key on 401 and cools down the offender', () => {
    const pool = new ProviderKeyPool({ keys: ['k1', 'k2', 'k3'], cursor: 'round_robin', cooldownMs: 60_000 });
    expect(pool.activeCount()).toBe(3);
    pool.markRotated('k1', 401);
    expect(pool.activeCount()).toBe(2);
    expect(pool.rotatedCount()).toBe(1);
    // Pick should now skip k1.
    expect(pool.pick()).toBe('k2');
    expect(pool.pick()).toBe('k3');
    expect(pool.pick()).toBe('k2');
  });

  it('clearRotation re-enables a previously rotated key', () => {
    const pool = new ProviderKeyPool({ keys: ['k1', 'k2'] });
    pool.markRotated('k1', 401);
    expect(pool.activeCount()).toBe(1);
    pool.clearRotation('k1');
    expect(pool.activeCount()).toBe(2);
    expect(pool.rotatedCount()).toBe(0);
  });

  it('throws when all keys are rotated', () => {
    const pool = new ProviderKeyPool({ keys: ['k1', 'k2'] });
    pool.markRotated('k1', 401);
    pool.markRotated('k2', 401);
    expect(() => pool.pick()).toThrow('exhausted');
  });

  it('status returns masked keys only', () => {
    const pool = new ProviderKeyPool({ keys: ['secret-abc123', 'shorter'] });
    const snapshot = pool.status();
    expect(snapshot[0]!.key).toBe('****c123');
    expect(snapshot[1]!.key).toBe('****rter');
    // The full key must not appear anywhere in the masked output.
    expect(JSON.stringify(snapshot)).not.toContain('secret-abc123');
  });

  it('GatewayCredentialPool routes per provider', () => {
    const gw = new GatewayCredentialPool();
    gw.configure('openai', { keys: ['o1', 'o2'] });
    gw.configure('anthropic', { keys: ['a1'] });
    expect(gw.providers().sort()).toEqual(['anthropic', 'openai']);
    expect(['o1', 'o2']).toContain(gw.pick('openai'));
    expect(gw.pick('anthropic')).toBe('a1');
    gw.markRotated('openai', 'o1', 401);
    expect(gw.pick('openai')).toBe('o2');
  });

  it('GatewayCredentialPool throws for unconfigured providers', () => {
    const gw = new GatewayCredentialPool();
    expect(() => gw.pick('openai')).toThrow("No credential pool configured for provider 'openai'");
  });
});

// -----------------------------------------------------------------------------
// #92 — fallback_providers chain
// -----------------------------------------------------------------------------

describe('#92 executeWithProviderFallback', () => {
  it('returns primary success without invoking fallback', async () => {
    const seen: string[] = [];
    const result = await executeWithProviderFallback(
      'openai',
      async (p) => {
        seen.push(p);
        return { ok: true, data: 42 };
      },
      { fallbackProviders: ['anthropic', 'gemini'] },
    );
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('openai');
    expect(result.fallbacksUsed).toEqual([]);
    expect(seen).toEqual(['openai']);
  });

  it('falls through the chain on thrown errors', async () => {
    const seen: string[] = [];
    const events: Array<{ from: string; to: string }> = [];
    const result = await executeWithProviderFallback(
      'openai',
      async (p) => {
        seen.push(p);
        if (p === 'openai') throw new Error('primary boom');
        if (p === 'anthropic') throw new Error('secondary boom');
        return { ok: true, data: p };
      },
      { fallbackProviders: ['anthropic', 'gemini'] },
      (e) => events.push({ from: e.from, to: e.to }),
    );
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('gemini');
    expect(seen).toEqual(['openai', 'anthropic', 'gemini']);
    expect(result.fallbacksUsed).toEqual([
      { from: 'openai', to: 'anthropic' },
      { from: 'anthropic', to: 'gemini' },
    ]);
    expect(events).toEqual([
      { from: 'openai', to: 'anthropic' },
      { from: 'anthropic', to: 'gemini' },
    ]);
  });

  it('treats {ok: false} returns as retryable failures', async () => {
    const result = await executeWithProviderFallback(
      'openai',
      async (p) => (p === 'openai' ? { ok: false, error: 'rate_limited' } : { ok: true, p }),
      { fallbackProviders: ['anthropic'] },
    );
    expect(result.ok).toBe(true);
    expect(result.provider).toBe('anthropic');
    expect(result.fallbacksUsed).toEqual([{ from: 'openai', to: 'anthropic' }]);
  });

  it('reports failure when entire chain is exhausted', async () => {
    const result = await executeWithProviderFallback(
      'openai',
      async () => {
        throw new Error('all dead');
      },
      { fallbackProviders: ['anthropic'] },
    );
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.lastError).toBe('all dead');
    expect(result.provider).toBe('anthropic');
  });

  it('runs primary only when fallbackProviders is empty', async () => {
    const seen: string[] = [];
    await executeWithProviderFallback('openai', async (p) => {
      seen.push(p);
      throw new Error('x');
    });
    expect(seen).toEqual(['openai']);
  });
});

// -----------------------------------------------------------------------------
// #97 — api_max_retries in GatewayConfig
// -----------------------------------------------------------------------------

describe('#97 resolveGatewayMaxAttempts', () => {
  it('falls back to per-platform default when config is absent', () => {
    expect(resolveGatewayMaxAttempts('telegram')).toBe(2); // platform default
    expect(resolveGatewayMaxAttempts('slack')).toBe(3);
    expect(resolveGatewayMaxAttempts('whatsapp')).toBe(4);
  });

  it('honours GatewayConfig.maxRetries (Hermes-style additional-retry count)', () => {
    expect(resolveGatewayMaxAttempts('telegram', { maxRetries: 5 })).toBe(6); // 5 retries + 1 initial
    expect(resolveGatewayMaxAttempts('slack', { maxRetries: 0 })).toBe(1); // 0 retries → 1 attempt only
  });

  it('ignores undefined maxRetries', () => {
    expect(resolveGatewayMaxAttempts('telegram', { maxRetries: undefined })).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// #98 — request_timeout_seconds (model → provider → global)
// -----------------------------------------------------------------------------

describe('#98 request timeout precedence', () => {
  it('model-level wins over provider and global', () => {
    expect(resolveRequestTimeoutMs('any-model', 5000, 10000)).toBe(5000); // no model meta → provider
    // Now exercise gateway-side resolver with explicit model timeout.
    expect(resolveGatewayRequestTimeoutMs(2000, { requestTimeoutMs: 5000, globalRequestTimeoutMs: 10000 })).toBe(2000);
  });

  it('provider/gateway timeout used when model timeout is absent', () => {
    expect(resolveGatewayRequestTimeoutMs(undefined, { requestTimeoutMs: 5000, globalRequestTimeoutMs: 10000 })).toBe(5000);
  });

  it('global default used when neither model nor provider configured one', () => {
    expect(resolveGatewayRequestTimeoutMs(undefined, { globalRequestTimeoutMs: 10000 })).toBe(10000);
  });

  it('returns undefined when no level configured a timeout', () => {
    expect(resolveGatewayRequestTimeoutMs(undefined, {})).toBeUndefined();
    expect(resolveGatewayRequestTimeoutMs(undefined)).toBeUndefined();
  });

  it('provider helper resolves model-level when the model declares a timeout', () => {
    // No catalog model declares one out of the box; ensure provider fallback works.
    expect(resolveRequestTimeoutMs('gpt-4o', 1234)).toBe(1234);
    expect(resolveRequestTimeoutMs('gpt-4o', undefined, 9999)).toBe(9999);
    expect(resolveRequestTimeoutMs('gpt-4o')).toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// #72 — per-provider API key schema validation
// -----------------------------------------------------------------------------

describe('#72 validateProviderKey', () => {
  it('accepts well-formed keys per provider', () => {
    expect(validateAnthropicKey('sk-ant-abc123').ok).toBe(true);
    expect(validateOpenAIKey('sk-proj-xyz').ok).toBe(true);
    expect(validateGeminiKey('AIzaSyA1B2C3').ok).toBe(true);
    expect(validateNvidiaKey('nvapi-deadbeef').ok).toBe(true);
    expect(validateXaiKey('xai-foo').ok).toBe(true);
  });

  it('rejects mismatched prefixes with actionable reasons', () => {
    expect(validateAnthropicKey('sk-proj-leaked').ok).toBe(false);
    expect(validateAnthropicKey('sk-proj-leaked').reason).toMatch(/sk-ant-/);
    expect(validateOpenAIKey('sk-ant-leaked').ok).toBe(false);
    expect(validateOpenAIKey('sk-ant-leaked').reason).toMatch(/Anthropic/);
    expect(validateGeminiKey('not-a-google-key').ok).toBe(false);
    expect(validateNvidiaKey('sk-proj-leaked').ok).toBe(false);
  });

  it('rejects empty keys', () => {
    expect(validateAnthropicKey('').ok).toBe(false);
    expect(validateOpenAIKey('').ok).toBe(false);
  });

  it('validateProviderKey routes by provider name (case-insensitive)', () => {
    expect(validateProviderKey('anthropic', 'sk-ant-x').ok).toBe(true);
    expect(validateProviderKey('Anthropic', 'sk-x').ok).toBe(false);
    expect(validateProviderKey('OpenAI', 'sk-x').ok).toBe(true);
    expect(validateProviderKey('google', 'AIzaX').ok).toBe(true);
    expect(validateProviderKey('gemini', 'AIzaY').ok).toBe(true);
    expect(validateProviderKey('nvidia', 'nvapi-x').ok).toBe(true);
    expect(validateProviderKey('xai', 'xai-x').ok).toBe(true);
  });

  it('unknown providers accept any non-empty key (Ollama, custom endpoints)', () => {
    expect(validateProviderKey('ollama', 'literally-anything').ok).toBe(true);
    expect(validateProviderKey('custom', 'whatever').ok).toBe(true);
    expect(validateProviderKey('custom', '').ok).toBe(false);
  });

  it('provider classes expose static validateKey', () => {
    expect(AnthropicProvider.validateKey('sk-ant-x').ok).toBe(true);
    expect(AnthropicProvider.validateKey('sk-x').ok).toBe(false);
    expect(OpenAICompatibleProvider.validateKey('sk-x').ok).toBe(true);
    expect(OpenAICompatibleProvider.validateKey('sk-ant-x').ok).toBe(false);
    expect(EchoProvider.validateKey('any').ok).toBe(true);
  });
});

// -----------------------------------------------------------------------------
// #102 — typing indicator try/finally
//
// We can't easily exercise the full GatewayRunner without a Telegram backend,
// but we can assert structural invariants on the source: every code path that
// creates a `createTypingIndicator` must guarantee a `finally { typing.stop() }`.
// -----------------------------------------------------------------------------

describe('#102 typing indicator structural invariant', () => {
  it('runner.ts wraps the entire send path in try/finally', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const runnerPath = path.resolve(here, '../packages/gateway/src/runner.ts');
    const source = await fs.readFile(runnerPath, 'utf8');
    // The send block must be inside a try, and `typing.stop()` must appear in
    // a `finally` clause, not just on the success / catch paths.
    expect(source).toMatch(/finally\s*{\s*typing\.stop\(\);\s*}/);
    // Sanity: there should be exactly ONE actual typing.stop() invocation
    // (the one inside `finally`). Previously there were two: one on success,
    // one in catch. Strip line comments before counting so the JSDoc-style
    // mention in the explanatory comment does not inflate the count.
    const sourceWithoutComments = source.replace(/^\s*\/\/.*$/gm, '');
    const stopCallCount = sourceWithoutComments.match(/typing\.stop\(\)/g)?.length ?? 0;
    expect(stopCallCount).toBe(1);
  });
});

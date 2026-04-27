/**
 * #68 + #135 — centralized redaction at log/event sinks.
 *
 * Verifies redactStructuredData() walks objects and arrays, masks values
 * under sensitive keys, and runs string-content redaction on every other
 * value. Also verifies the runtime-node logger applies it before serializing.
 */
import { describe, expect, it, vi } from 'vitest';
import { redactStructuredData } from '../packages/core/src/security.js';
import { createLogger } from '../packages/runtime-node/src/logger.js';

describe('redactStructuredData — primitives', () => {
  it('redacts known credential patterns in plain strings', () => {
    expect(redactStructuredData('Bearer sk-1234567890abcdefghij')).toContain('[REDACTED]');
    expect(redactStructuredData('plain text without secret')).toBe('plain text without secret');
  });

  it('passes through numbers / booleans / null', () => {
    expect(redactStructuredData(42)).toBe(42);
    expect(redactStructuredData(true)).toBe(true);
    expect(redactStructuredData(null)).toBe(null);
    expect(redactStructuredData(undefined)).toBe(undefined);
  });
});

describe('redactStructuredData — sensitive keys', () => {
  it('redacts values under `token` key', () => {
    const out = redactStructuredData({ token: 'opaque-session-id', name: 'alice' });
    expect(out).toEqual({ token: '[REDACTED]', name: 'alice' });
  });

  it('redacts apiKey / api_key / X-Api-Key variants', () => {
    expect(redactStructuredData({ apiKey: 'x' })).toEqual({ apiKey: '[REDACTED]' });
    expect(redactStructuredData({ api_key: 'x' })).toEqual({ api_key: '[REDACTED]' });
    expect(redactStructuredData({ 'x-api-key': 'x' })).toEqual({ 'x-api-key': '[REDACTED]' });
  });

  it('redacts Authorization / authorization', () => {
    expect(redactStructuredData({ Authorization: 'Bearer xyz' })).toEqual({ Authorization: '[REDACTED]' });
    expect(redactStructuredData({ authorization: 'Bearer xyz' })).toEqual({ authorization: '[REDACTED]' });
  });

  it('redacts password / passwd / pwd', () => {
    expect(redactStructuredData({ password: 'p' })).toEqual({ password: '[REDACTED]' });
    expect(redactStructuredData({ pwd: 'p' })).toEqual({ pwd: '[REDACTED]' });
  });

  it('redacts cookie', () => {
    expect(redactStructuredData({ cookie: 'session=abc' })).toEqual({ cookie: '[REDACTED]' });
  });

  it('redacts privateKey / private_key', () => {
    expect(redactStructuredData({ privateKey: 'PEM' })).toEqual({ privateKey: '[REDACTED]' });
    expect(redactStructuredData({ private_key: 'PEM' })).toEqual({ private_key: '[REDACTED]' });
  });

  it('does NOT redact innocuous keys', () => {
    expect(redactStructuredData({ name: 'alice', userId: 'u-1', email: 'a@b.c' }))
      .toEqual({ name: 'alice', userId: 'u-1', email: 'a@b.c' });
  });
});

describe('redactStructuredData — recursion + cycles', () => {
  it('recurses into nested objects', () => {
    const out = redactStructuredData({
      user: { name: 'alice', token: 'x' },
      meta: { count: 1 },
    });
    expect(out).toEqual({
      user: { name: 'alice', token: '[REDACTED]' },
      meta: { count: 1 },
    });
  });

  it('walks arrays', () => {
    const out = redactStructuredData({
      events: [{ token: 'a' }, { name: 'b' }],
    });
    expect(out).toEqual({
      events: [{ token: '[REDACTED]' }, { name: 'b' }],
    });
  });

  it('handles circular references', () => {
    type Node = { name: string; next?: Node };
    const a: Node = { name: 'first' };
    a.next = a;
    const out = redactStructuredData(a) as Node;
    expect(out.name).toBe('first');
    // The circular `next` is stringified as the placeholder.
    expect(out.next).toBe('[CIRCULAR]');
  });

  it('also runs string-content credential redaction on non-sensitive keys', () => {
    const out = redactStructuredData({
      message: 'Authorization: Bearer sk-abcdefghijklmnopqrst',
    }) as { message: string };
    expect(out.message).toContain('[REDACTED]');
  });
});

describe('runtime-node logger — applies redaction at emit', () => {
  it('redacts sensitive keys from data argument before stdout write', () => {
    const writes: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const logger = createLogger({ name: 'test', level: 'info' });
      logger.info('auth ok', {
        userId: 'u-1',
        token: 'opaque-session',
        Authorization: 'Bearer xyz',
        nested: { apiKey: 'k' },
      });
    } finally {
      spy.mockRestore();
      // Ensure orig restored even if mockRestore fails.
      process.stdout.write = orig;
    }

    expect(writes.length).toBeGreaterThan(0);
    const line = writes.join('');
    expect(line).toContain('"userId":"u-1"');
    expect(line).toContain('"token":"[REDACTED]"');
    expect(line).toContain('"Authorization":"[REDACTED]"');
    expect(line).toContain('"apiKey":"[REDACTED]"');
    // Confirm the actual secret value never made it.
    expect(line).not.toContain('opaque-session');
    expect(line).not.toContain('Bearer xyz');
  });

  it('does not affect normal data', () => {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => {
      writes.push(typeof chunk === 'string' ? chunk : chunk.toString());
      return true;
    });

    try {
      const logger = createLogger({ name: 'test', level: 'info' });
      logger.info('hello', { count: 3, items: ['a', 'b'] });
    } finally {
      spy.mockRestore();
    }

    const line = writes.join('');
    expect(line).toContain('"count":3');
    expect(line).toContain('"items":["a","b"]');
  });
});

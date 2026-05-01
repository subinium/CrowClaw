// ---------------------------------------------------------------------------
// json-repair tests (#232 — v0.8.0 Hermes parity)
// ---------------------------------------------------------------------------
//
// Repair pipeline must:
//   - Be a no-op on well-formed JSON (fast path returns repaired:false).
//   - Recover from truncated strings / objects / arrays.
//   - Strip trailing commas, comments; quote unquoted keys; convert single
//     quotes to double quotes.
//   - Drop dangling keys (never invent values).
//   - Round-trip arbitrary JSON.stringify(obj) inputs identically.
// ---------------------------------------------------------------------------

import { describe, it, expect } from 'vitest';
import { repairJson } from '@crowclaw/providers';

describe('repairJson — fast path (well-formed input)', () => {
  it('passes through {}', () => {
    const r = repairJson('{}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({});
  });

  it('passes through []', () => {
    const r = repairJson('[]');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual([]);
  });

  it('passes through nested object', () => {
    const r = repairJson('{"a":1,"b":{"c":[1,2,3]},"d":"hello"}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ a: 1, b: { c: [1, 2, 3] }, d: 'hello' });
  });

  it('passes through string with escaped quotes', () => {
    const r = repairJson('{"msg":"He said \\"hi\\""}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ msg: 'He said "hi"' });
  });

  it('passes through unicode + numbers', () => {
    const r = repairJson('{"name":"한글","price":12.5,"flag":true,"none":null}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ name: '한글', price: 12.5, flag: true, none: null });
  });

  it('passes through array of objects', () => {
    const r = repairJson('[{"a":1},{"a":2}]');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe('repairJson — truncation recovery', () => {
  it('closes a truncated string mid-value', () => {
    const r = repairJson('{"foo":"bar');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 'bar' });
    expect(r.reason).toMatch(/closed/);
  });

  it('closes a truncated object after a key:value pair', () => {
    const r = repairJson('{"foo":"bar","baz":1');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 'bar', baz: 1 });
  });

  it('drops a dangling key string when truncated mid-key', () => {
    const r = repairJson('{"foo":"bar","baz');
    expect(r.repaired).toBe(true);
    // The dangling "baz key has no value — drop it, keep foo.
    expect(r.value).toEqual({ foo: 'bar' });
    expect(r.reason).toMatch(/dropped/);
  });

  it('drops a dangling key with completed quote but no colon', () => {
    const r = repairJson('{"foo":1,"baz"');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 1 });
  });

  it('closes a truncated array', () => {
    const r = repairJson('[1,2,3');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual([1, 2, 3]);
  });

  it('closes nested truncated object inside array', () => {
    const r = repairJson('[{"a":1},{"b":');
    // The second object's value is missing — should drop it gracefully.
    expect(r.repaired).toBe(true);
    expect(Array.isArray(r.value)).toBe(true);
    expect((r.value as unknown[])[0]).toEqual({ a: 1 });
  });

  it('closes deeply nested truncation', () => {
    const r = repairJson('{"a":{"b":{"c":"truncated');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: { b: { c: 'truncated' } } });
  });
});

describe('repairJson — trailing commas', () => {
  it('strips a trailing comma in an object', () => {
    const r = repairJson('{"a":1,}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('strips a trailing comma in an array', () => {
    const r = repairJson('[1,2,3,]');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual([1, 2, 3]);
  });

  it('strips trailing commas in nested structures', () => {
    const r = repairJson('{"arr":[1,2,],"obj":{"x":1,}}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ arr: [1, 2], obj: { x: 1 } });
  });
});

describe('repairJson — unquoted keys', () => {
  it('quotes a single unquoted key', () => {
    const r = repairJson('{foo:1}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 1 });
  });

  it('quotes multiple unquoted keys', () => {
    const r = repairJson('{foo:1, bar:2, baz:"hello"}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 1, bar: 2, baz: 'hello' });
  });

  it('handles unquoted keys with underscores and digits', () => {
    const r = repairJson('{user_id:42, count2:5}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ user_id: 42, count2: 5 });
  });
});

describe('repairJson — single-quoted strings', () => {
  it('converts single-quoted values to double-quoted', () => {
    const r = repairJson("{\"foo\":'bar'}");
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 'bar' });
  });

  it('handles apostrophe inside double-quoted (unchanged)', () => {
    const r = repairJson('{"msg":"it\'s ok"}');
    // Already valid JSON — fast path.
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ msg: "it's ok" });
  });

  it('escapes embedded double quotes when converting', () => {
    const r = repairJson("{\"msg\":'say \"hi\"'}");
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ msg: 'say "hi"' });
  });
});

describe('repairJson — comments', () => {
  it('strips a single block comment', () => {
    const r = repairJson('{"a"/* comment */:1}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('strips a line comment', () => {
    const r = repairJson('{\n"a":1 // trailing\n}');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1 });
  });

  it('strips multiple comments at once', () => {
    const r = repairJson('{ /* c1 */ "a":1, // c2\n"b":2 }');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1, b: 2 });
  });

  it('does not strip comment-like sequences inside strings', () => {
    const r = repairJson('{"url":"https://example.com/path"}');
    expect(r.repaired).toBe(false);
    expect(r.value).toEqual({ url: 'https://example.com/path' });
  });
});

describe('repairJson — combined repairs', () => {
  it('handles trailing comma + unquoted key + truncation together', () => {
    const r = repairJson('{foo:1, bar:"baz"');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ foo: 1, bar: 'baz' });
  });

  it('handles BOM + comment + trailing comma', () => {
    const r = repairJson('﻿{ /* x */ "a":1, }');
    expect(r.repaired).toBe(true);
    expect(r.value).toEqual({ a: 1 });
    expect(r.reason).toMatch(/BOM/);
  });
});

describe('repairJson — irrecoverable input', () => {
  it('throws original error when even repair fails', () => {
    expect(() => repairJson('not even close to json @@@@')).toThrow();
  });
});

describe('repairJson — property-based round-trip', () => {
  // A handful of structurally-diverse objects. Each must round-trip via
  // JSON.stringify → repairJson → identical value.
  const samples: unknown[] = [
    {},
    [],
    { a: 1 },
    { a: [1, 2, { b: 'three' }] },
    [1, 'two', null, true, false, 3.14],
    { unicode: 'こんにちは', emoji: '🌟', mixed: ['x', { y: [null, true] }] },
    { 'with spaces': 'in key', 'with-dashes': 1 },
    { nested: { deeply: { and: { more: { still: 'going' } } } } },
    [{ a: 1 }, { b: 2 }, { c: { d: [3, 4, 5] } }],
    { num: 0, neg: -1, big: 1e10, frac: 0.001 },
  ];

  for (let i = 0; i < samples.length; i++) {
    it(`roundtrips sample #${i}`, () => {
      const raw = JSON.stringify(samples[i]);
      const r = repairJson(raw);
      expect(r.repaired).toBe(false);
      expect(r.value).toEqual(samples[i]);
    });
  }
});
